/**
 * Канарейки гейтов (З6, B1): применяет плохие изменения из tools/gate-canaries.ts
 * во временном git worktree и требует, чтобы соответствующий шаг verify упал.
 * Проверяется проводка гейта (шаг → команда → конфиг → exit code), а не логика
 * чекеров — та канареечна в tools/test/*. Реальная команда (`pnpm verify --json
 * --only`) исключает дрейф между канарейкой и тем, что гоняют человек, хуки и CI.
 *
 * Вердикт канарейки — только по прогону, который отработал (e42): сбой среды
 * (сигнал, холодный старт browser-тестера) не подтверждает и не опровергает
 * канарейку. Такой прогон повторяется один раз; повторный сбой — «СРЕДА, НЕ
 * ВЕРДИКТ» с exit 1, строка отличима от «НЕ УПАЛ» (ослабленного гейта за ней нет).
 *
 * Ограничения: канарейки проверяют ЗАКОММИЧЕННОЕ состояние (worktree от HEAD) —
 * при локальной разработке сначала commit. Запускаются при изменении tools/,
 * .claude/, конфигов гейтов (workflow canaries.yml), на push в main (e79: на PR
 * с согласованными breaking changes negative control красен по замыслу, и
 * отдельные канарейки судятся только на main) и в nightly; в каждом PR не
 * нужны. pnpm install в worktree делаетс один раз на весь набор; в CI store
 * прогревается установкой в корневом чекауте (setup action) до worktree.
 *
 *   pnpm canaries
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkHookInstall } from './check-hook-install.ts';
import { CANARIES, type GateCanary } from './gate-canaries.ts';
import type { StepDiagnostics } from './verify-diagnostics.ts';
// Список slow-шагов — из того же источника, что у verify: негатив-контроль
// не должен дрейфовать от определения шагов (см. verify-steps.ts).
import { slow as slowSteps } from './verify-steps.ts';

const repoDir = resolve(import.meta.dirname);

interface SpawnResult {
  status: number | null;
  output: string;
  /** Только stdout: у verify JSON идёт в stdout, pnpm-заголовки и ELIFECYCLE — в stderr. */
  stdout: string;
}

function run(command: string[], cwd: string, timeoutMs = 600_000): SpawnResult {
  const [file, ...args] = command;
  if (file === undefined) {
    return { status: -1, output: 'empty command', stdout: '' };
  }
  // GITHUB_HEAD_REF/GITHUB_BASE_REF стираются (ревью d7): канареечный worktree
  // — detached от HEAD, а гейты, читающие CI-контекст PR (check-docs,
  // branch-scope), обязаны видеть ветку worktree, а не ветку PR раннера, —
  // иначе негатив-контроль красен в job canaries (detached + протёкшая
  // task/*-ветка без локального main = ложный fail-closed).
  const { GITHUB_HEAD_REF: _head, GITHUB_BASE_REF: _base, ...inheritedEnv } = process.env;
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    cwd,
    timeout: timeoutMs,
    // Канарейки — гейт-контекст: CI=1 выключает reuseExistingServer (по A5
    // reuse:false и так станет безусловным в PR-3). Иначе локальный ручной
    // сервер на фиксированных портах 3000/3001 молча подменяет сервер
    // канарейки, и e2e-канарейки стреляют по чужому процессу (наблюдалось:
    // leftover `pnpm dev` без INSTANCE_ID — global setup его отверг).
    // VERIFY_TAIL_LINES=400: соседние инвариант-тесты шумят большими диффами
    // и вытесняли якорь канарейки из хвоста шага в JSON-отчёте (см. verify.ts).
    env: {
      ...inheritedEnv,
      CI: '1',
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      VERIFY_TAIL_LINES: '400',
    },
  });
  if (result.error !== undefined) {
    return { status: -1, output: String(result.error), stdout: '' };
  }
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    stdout: result.stdout,
  };
}

function git(args: string[]): SpawnResult {
  return run(['git', ...args], repoDir);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isResultJson(value: unknown): value is ResultJson {
  if (!isRecord(value) || typeof value['ok'] !== 'boolean') {
    return false;
  }
  return Array.isArray(value['steps']);
}

interface ResultJson {
  ok: boolean;
  steps: Array<{ name: string; ok: boolean; output: string; diagnostics?: StepDiagnostics }>;
}

/** Один прогон verify в worktree — то, по чему выносится вердикт. */
export interface VerifyRun {
  json: ResultJson | null;
  /** Полный вывод (stdout + stderr) — единственный свидетель, когда JSON не получен. */
  output: string;
}

function verifyInWorktree(worktreeDir: string, steps: string, full: boolean): VerifyRun {
  const args = ['verify', '--json', '--only', steps];
  if (full) {
    args.push('--full');
  }
  // full-кап 900 с: канарейка perf (A6 PR-1) на холодном кэше CI — сборка + ~3 мин перфа.
  const result = run(['pnpm', ...args], worktreeDir, full ? 900_000 : 300_000);
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (!isResultJson(parsed)) {
      return { json: null, output: result.output };
    }
    return { json: parsed, output: result.output };
  } catch {
    return { json: null, output: result.output };
  }
}

// --- Среда ≠ вердикт (e42) -----------------------------------------------------------

/**
 * Среда изредка убивает vitest сигналом под нагрузкой (наблюдается на macOS,
 * три случая 2026-11-13; тесты при этом успевают пройти). Сигнал — не вердикт
 * гейта: шаг, умерший от сигнала, не может ни подтвердить, ни опровергнуть
 * канарейку.
 */
const SIGNAL_KILL = /signal SIG(?:TERM|KILL)/;

/**
 * Холодный старт browser-тестера (e42): в vitest browser-режиме первый
 * динамический импорт тест-файла обрывается (`Failed to fetch dynamically
 * imported module`), либо iframe не готов за connectTimeout (`did not become
 * ready within`). turbo без --continue не запускает остальные пакеты шага
 * `test` — саботаж никто не проверяет, а раннер писал «НЕ УПАЛ» (прогоны
 * canaries 45281745218, 45274684600, 45261129674, 45072912709; журнал e42).
 * Те же два маркера, что в повторе канарейки копии
 * (tools/run-template-copy-canary.ts) — сверяет tools/test/run-gate-canaries.test.ts.
 */
export const COLD_BROWSER_START: readonly string[] = [
  'Failed to fetch dynamically imported module',
  'did not become ready within',
];

/** Какой признак сбоя среды встретился в тексте, или null — текст его не содержит. */
function environmentSignature(evidence: string): string | null {
  if (SIGNAL_KILL.test(evidence)) {
    return 'was killed by a signal';
  }
  const marker = COLD_BROWSER_START.find((candidate) => evidence.includes(candidate));
  return marker === undefined ? null : `hit a cold start of the browser tester (${marker})`;
}

/** Всё, что шаг сказал о падении: хвост вывода + диагностика (b9). */
function stepEvidence(step: ResultJson['steps'][number]): string {
  return [
    step.output,
    ...(step.diagnostics?.findings ?? []).map((finding) => finding.message),
  ].join('\n');
}

/**
 * Сбой среды в прогоне (какой шаг, по какому признаку) или null — прогон
 * завершён и может давать вердикт. Признак учитывается только в упавших шагах:
 * зелёный шаг с такой строкой в выводе отработал. Без JSON признак ищется во
 * полном выводе — разбивки по шагам нет.
 */
export function environmentFailure(attempt: VerifyRun): string | null {
  if (attempt.json === null) {
    const signature = environmentSignature(attempt.output);
    return signature === null ? null : `verify gave no JSON and ${signature}`;
  }
  for (const step of attempt.json.steps) {
    if (step.ok) {
      continue;
    }
    const signature = environmentSignature(stepEvidence(step));
    if (signature !== null) {
      return `step ${step.name} ${signature}`;
    }
  }
  return null;
}

/** То из канарейки, по чему выносится вердикт. */
export type CanaryExpectation = Pick<GateCanary, 'name' | 'steps' | 'failedStep' | 'expect'>;

/**
 * Саботаж пойман: отчёт разобран, целевой шаг красный и ругается ожидаемой
 * причиной. Причина ищется и в diagnostics (b9): хвост output конечен, и флейк
 * другого пакета в том же шаге вытесняет из него сообщение целевого теста
 * (2026-11-22: флейк импорта TasksPage в клоне закрыл хвост — канарейка
 * owner-процедуры дала ложное «НЕ УПАЛ» при живом страже).
 */
export function tripped(canary: CanaryExpectation, attempt: VerifyRun): boolean {
  const step = attempt.json?.steps.find((item) => item.name === canary.failedStep);
  if (attempt.json === null || step === undefined || step.ok) {
    return false;
  }
  // Без флагов g/y: test у такого regex помнит lastIndex, а прогонов на
  // канарейку теперь два (первый и повтор) — на повторе совпадение терялось бы.
  return new RegExp(canary.expect.source, canary.expect.flags.replace(/[gy]/g, '')).test(
    stepEvidence(step),
  );
}

/**
 * - `tripped` — саботаж пойман: вердикт есть, даже если рядом шумела среда;
 * - `not-tripped` — шаг отработал и саботаж не увидел: «НЕ УПАЛ»;
 * - `environment` — сбой среды и в повторе: вердикта нет, «СРЕДА, НЕ ВЕРДИКТ».
 */
export type CanaryOutcome = 'tripped' | 'not-tripped' | 'environment';

export interface CanaryJudgment {
  outcome: CanaryOutcome;
  /** Строка сводки: «НЕ УПАЛ» — только настоящему вердикту. */
  row: string;
  /** Для stderr: что увидел шаг либо почему вердикта нет. */
  detail: string;
}

function notTripped(canary: CanaryExpectation, label: string, attempt: VerifyRun): CanaryJudgment {
  const report =
    attempt.json === null ? null : JSON.stringify(attempt.json.steps, null, 2).slice(-2000);
  return {
    outcome: 'not-tripped',
    row: `✗ ${label} НЕ УПАЛ${report === null ? ' (verify не дал JSON)' : ''}`,
    detail: `canary "${canary.name}" did not trip its gate:\n${report ?? '(no json)'}`,
  };
}

/**
 * Вердикт канарейки по прогонам verify в worktree: «НЕ УПАЛ» — только когда
 * целевой шаг отработал и не увидел саботажа. Сбой среды — не вердикт: один
 * повтор, повторный сбой — громкое «СРЕДА, НЕ ВЕРДИКТ» (не «НЕ УПАЛ»).
 * Общего повтора всех падений нет: он превращает канарейки в генератор зелёного.
 */
export function judgeCanary(
  canary: CanaryExpectation,
  runVerify: () => VerifyRun,
  onRetry: (message: string) => void,
): CanaryJudgment {
  const label = `${canary.name.padEnd(30)} → ${canary.failedStep}`;
  const caught = (): CanaryJudgment => ({
    outcome: 'tripped',
    row: `✓ ${label} красный`,
    detail: '',
  });
  const first = runVerify();
  // Пойманный саботаж — вердикт и при сбое среды рядом: повтор не нужен.
  if (tripped(canary, first)) {
    return caught();
  }
  const reason = environmentFailure(first);
  if (reason === null) {
    return notTripped(canary, label, first);
  }
  onRetry(`verify (${canary.steps}): ${reason} — environment, not a verdict; retrying once`);
  const second = runVerify();
  if (tripped(canary, second)) {
    return caught();
  }
  const again = environmentFailure(second);
  if (again !== null) {
    return {
      outcome: 'environment',
      row: `✗ ${label} СРЕДА, НЕ ВЕРДИКТ (сбой среды и в повторе)`,
      detail:
        `canary "${canary.name}" got no verdict: ${reason}; on retry ${again}. ` +
        'The gate was not judged — fix the environment and rerun',
    };
  }
  return notTripped(canary, label, second);
}

/**
 * Прогон негатив-контроля: по сбою среды — один повтор; повторный сбой —
 * ошибка «СРЕДА, НЕ ВЕРДИКТ» (канарейки не запускаются: база не проверена).
 * Красная база без признака среды возвращается как есть — её объявляет вызывающий.
 */
export function controlRun(
  label: string,
  runVerify: () => VerifyRun,
  onRetry: (message: string) => void,
): VerifyRun {
  const first = runVerify();
  const reason = environmentFailure(first);
  if (reason === null) {
    return first;
  }
  onRetry(`verify (${label}): ${reason} — environment, not a verdict; retrying once`);
  const second = runVerify();
  const again = environmentFailure(second);
  if (again !== null) {
    throw new Error(
      `negative control (${label}) got no verdict — СРЕДА, НЕ ВЕРДИКТ: the environment failed twice (${reason}; on retry ${again}):\n${second.output.slice(-2000)}`,
    );
  }
  return second;
}

/** Уведомление о повторе по сбою среды — в stderr, рядом с диагностикой шага. */
function retryNotice(message: string): void {
  console.error(message);
}

async function main(): Promise<void> {
  const worktreeDir = mkdtempSync(join(tmpdir(), 'b1-canaries-'));
  let failures = 0;
  /** Канарейки без вердикта: среда упала дважды — отдельно от «НЕ УПАЛ». */
  let noVerdicts = 0;
  const rows: string[] = [];

  try {
    // Worktree от HEAD: канарейки проверяют закоммиченное состояние.
    const added = git(['worktree', 'add', worktreeDir, 'HEAD']);
    if (added.status !== 0) {
      throw new Error(`git worktree add failed:\n${added.output}`);
    }
    const installed = run(['pnpm', 'install', '--frozen-lockfile'], worktreeDir, 600_000);
    if (installed.status !== 0) {
      // throw, а не process.exit: exit обходит finally и оставляет worktree
      // зарегистрированным в основном репо и каталог в tmp.
      throw new Error(`pnpm install in worktree failed:\n${installed.output.slice(-2000)}`);
    }

    // Негатив-контроль: на чистом worktree все шаги набора зелёные — иначе
    // канарейки «пролетают» на уже красной базе. Slow-шаги вне быстрого контроля:
    // `verify --only` с slow-шагом без --full сам выходит с ошибкой.
    // bundle-delta вне негатив-контроля (A6 PR-2, ADR 0013): PR с одобренным
    // ростом бандла легитимно красит его на чистом дереве — контроль уронил бы
    // весь прогон ложной тревогой. Всегда-красный (сломанный) гейт это не
    // скрывает: CI-job bundle-delta красный на каждом PR, а канарейка ниже
    // требует конкретной причины красноты (/bundle-growth-approved/).
    const NEGATIVE_CONTROL_EXEMPT = new Set(['bundle-delta']);
    const slowNames = new Set(slowSteps.map((step) => step.name));
    const allCovered = [...new Set(CANARIES.flatMap((canary) => canary.steps.split(',')))];
    const union = allCovered
      .filter((step) => !slowNames.has(step) && !NEGATIVE_CONTROL_EXEMPT.has(step))
      .join(',');
    const control = controlRun(
      union,
      () => verifyInWorktree(worktreeDir, union, false),
      retryNotice,
    );
    if (control.json === null || !control.json.ok) {
      throw new Error(
        `negative control failed — worktree is red before any bad change:\n${control.output.slice(-3000)}`,
      );
    }
    console.log(`negative control: ${union} — ok`);
    // Отдельный контроль slow-шагов, покрытых канарейками (build,bundle,e2e):
    // slow-канарейки не должны стрелять вакуумно на красной базе.
    const slowUnion = [
      ...new Set(
        allCovered.filter((step) => slowNames.has(step) && !NEGATIVE_CONTROL_EXEMPT.has(step)),
      ),
    ].join(',');
    const slowControl = controlRun(
      slowUnion,
      () => verifyInWorktree(worktreeDir, slowUnion, true),
      retryNotice,
    );
    if (slowControl.json === null || !slowControl.json.ok) {
      throw new Error(
        `negative control (${slowUnion}) failed — a slow gate is already red on the clean base:\n${slowControl.output.slice(-2000)}`,
      );
    }
    console.log(`negative control: ${slowUnion} — ok`);

    for (const canary of CANARIES) {
      canary.apply(worktreeDir);
      const judgment = judgeCanary(
        canary,
        () => verifyInWorktree(worktreeDir, canary.steps, canary.full ?? false),
        retryNotice,
      );
      rows.push(judgment.row);
      if (judgment.outcome === 'not-tripped') {
        failures += 1;
      }
      if (judgment.outcome === 'environment') {
        noVerdicts += 1;
      }
      if (judgment.outcome !== 'tripped') {
        console.error(judgment.detail);
      }
      // Возврат worktree в чистое состояние (правки + untracked probe-файлы).
      // reports/ (в .gitignore) переживает revert по умолчанию, но отчёты бандла
      // и перфа удаляются: их перезаписывают только одноимённые шаги, и после
      // канарейки «бандл сверх бюджета» там остаётся раздутый замер — тест
      // инварианта порогов (gates-canary.test) читает эти файлы, когда они
      // существуют, и ложнокраснил бы все последующие test:hooks-канарейки.
      for (const revert of [
        ['git', 'checkout', '--', '.'],
        ['git', 'clean', '-fdq'],
      ]) {
        const reverted = run(revert, worktreeDir);
        if (reverted.status !== 0) {
          throw new Error(`revert failed (${revert.join(' ')}):\n${reverted.output}`);
        }
      }
      for (const stale of ['reports/bundle.json', 'e2e/reports/perf.json']) {
        rmSync(join(worktreeDir, stale), { force: true });
      }
    }
  } finally {
    git(['worktree', 'remove', '--force', worktreeDir]);
    git(['worktree', 'prune']);
    rmSync(worktreeDir, { recursive: true, force: true });
  }

  console.log(`\ngate canaries (${CANARIES.length}):`);
  for (const row of rows) {
    console.log(`  ${row}`);
  }

  // d12: позитивная проверка контура установки хуков. Вне таблицы GateCanary:
  // prepare — не шаг verify, откат условия в нём не роняет ни один шаг verify.
  // Полный клон обязателен: хуки общие на клон, в worktree самого раннера они
  // уже поставлены корневой установкой — проверка внутри worktree даст
  // ложно-зелёный результат (журнал backlog/done/d11.md).
  const installRow = await checkHookInstall(resolve(import.meta.dirname, '..'));
  rows.push(installRow);
  if (installRow.startsWith('✗')) failures += 1;

  console.log(`\ngate canaries (${CANARIES.length + 1}):`);
  for (const row of rows) {
    console.log(`  ${row}`);
  }
  if (failures > 0) {
    console.error(
      `\n${failures} canary(ies) did not trip their gate — a gate may have been silently weakened (З6)`,
    );
  }
  if (noVerdicts > 0) {
    console.error(
      `\n${noVerdicts} canary(ies) got no verdict — the environment failed twice (СРЕДА, НЕ ВЕРДИКТ). This is not a weakened gate: fix the environment and rerun`,
    );
  }
  if (failures > 0 || noVerdicts > 0) {
    process.exit(1);
  }
  console.log('all gates are alive');
}

// Импорт модуля тестом (tools/test/run-gate-canaries.test.ts) прогон не запускает.
const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  await main();
}
