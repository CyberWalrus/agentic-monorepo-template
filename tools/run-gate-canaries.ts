/**
 * Канарейки гейтов (З6, B1): применяет плохие изменения из tools/gate-canaries.ts
 * во временном git worktree и требует, чтобы соответствующий шаг verify упал.
 * Проверяется проводка гейта (шаг → команда → конфиг → exit code), а не логика
 * чекеров — та канареечна в tools/test/*. Реальная команда (`pnpm verify --json
 * --only`) исключает дрейф между канарейкой и тем, что гоняют человек, хуки и CI.
 *
 * Ограничения: канарейки проверяют ЗАКОММИЧЕННОЕ состояние (worktree от HEAD) —
 * при локальной разработке сначала commit. Запускаются при изменении tools/,
 * .claude/, конфигов гейтов (workflow canaries.yml) и в nightly; в каждом PR
 * не нужны. pnpm install в worktree делаетс один раз на весь набор; в CI store
 * прогревается установкой в корневом чекауте (setup action) до worktree.
 *
 *   pnpm canaries
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CANARIES } from './gate-canaries.ts';
// Список slow-шагов — из того же источника, что у verify: негатив-контроль
// не должен дрейфовать от определения шагов (см. verify-steps.ts).
import { slow as slowSteps } from './verify-steps.ts';

const repoDir = resolve(import.meta.dirname);
const worktreeDir = mkdtempSync(join(tmpdir(), 'b1-canaries-'));

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
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    cwd,
    timeout: timeoutMs,
    // Канарейки — гейт-контекст: CI=1 выключает reuseExistingServer (по A5
    // reuse:false и так станет безусловным в PR-3). Иначе локальный ручной
    // сервер на фиксированных портах 3000/3001 молча подменяет сервер
    // канарейки, и e2e-канарейки стреляют по чужому процессу (наблюдалось:
    // leftover `pnpm dev` без INSTANCE_ID — global setup его отверг).
    env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
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
  steps: Array<{ name: string; ok: boolean; output: string }>;
}

function verifyInWorktree(
  steps: string,
  full: boolean,
): { json: ResultJson | null; output: string } {
  const args = ['verify', '--json', '--only', steps];
  if (full) {
    args.push('--full');
  }
  const result = run(['pnpm', ...args], worktreeDir, full ? 600_000 : 300_000);
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

const SIGNAL_KILL = /signal SIG(?:TERM|KILL)/;

/**
 * Среда изредка убивает vitest сигналом под нагрузкой (наблюдается на macOS,
 * три случая 2026-11-13; тесты при этом успевают пройти). Сигнал — не вердикт
 * гейта: шаг, умерший от сигнала, не может ни подтвердить, ни опровергнуть
 * канарейку. Повторяем такой прогон один раз; повторная смерть остаётся громкой.
 */
function verifyInWorktreeWithSignalRetry(
  steps: string,
  full: boolean,
): { json: ResultJson | null; output: string } {
  const first = verifyInWorktree(steps, full);
  const killedBySignal =
    first.json === null
      ? SIGNAL_KILL.test(first.output)
      : first.json.steps.some((step) => !step.ok && SIGNAL_KILL.test(step.output));
  if (!killedBySignal) {
    return first;
  }
  console.error(
    `verify (${steps}) was killed by a signal — environment, not the gate; retrying once`,
  );
  return verifyInWorktree(steps, full);
}

let failures = 0;
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
  const slowNames = new Set(slowSteps.map((step) => step.name));
  const allCovered = [...new Set(CANARIES.flatMap((canary) => canary.steps.split(',')))];
  const union = allCovered.filter((step) => !slowNames.has(step)).join(',');
  const control = verifyInWorktreeWithSignalRetry(union, false);
  if (control.json === null || !control.json.ok) {
    throw new Error(
      `negative control failed — worktree is red before any bad change:\n${control.output.slice(-3000)}`,
    );
  }
  console.log(`negative control: ${union} — ok`);
  // Отдельный контроль slow-шагов, покрытых канарейками (build,bundle,e2e):
  // slow-канарейки не должны стрелять вакуумно на красной базе.
  const slowUnion = [...new Set(allCovered.filter((step) => slowNames.has(step)))].join(',');
  const slowControl = verifyInWorktreeWithSignalRetry(slowUnion, true);
  if (slowControl.json === null || !slowControl.json.ok) {
    throw new Error(
      `negative control (${slowUnion}) failed — a slow gate is already red on the clean base:\n${slowControl.output.slice(-2000)}`,
    );
  }
  console.log(`negative control: ${slowUnion} — ok`);

  for (const canary of CANARIES) {
    canary.apply(worktreeDir);
    const { json } = verifyInWorktreeWithSignalRetry(canary.steps, canary.full ?? false);
    const step = json?.steps.find((item) => item.name === canary.failedStep);
    // Отчёт verify парсится, целевой шаг красный и ругается ожидаемой причиной.
    const tripped =
      json !== null &&
      !json.ok &&
      step !== undefined &&
      !step.ok &&
      canary.expect.test(step.output);
    if (tripped) {
      rows.push(`✓ ${canary.name.padEnd(30)} → ${canary.failedStep} красный`);
    } else {
      failures += 1;
      rows.push(
        `✗ ${canary.name.padEnd(30)} → ${canary.failedStep} НЕ УПАЛ${json === null ? ' (verify не дал JSON)' : ''}`,
      );
      console.error(
        `canary "${canary.name}" did not trip its gate:\n${json === null ? '(no json)' : JSON.stringify(json.steps, null, 2).slice(-2000)}`,
      );
    }
    // Возврат worktree в чистое состояние (правки + untracked probe-файлы).
    // reports/ (в .gitignore) переживает revert намеренно: канарейки его не читают.
    for (const revert of [
      ['git', 'checkout', '--', '.'],
      ['git', 'clean', '-fdq'],
    ]) {
      const reverted = run(revert, worktreeDir);
      if (reverted.status !== 0) {
        throw new Error(`revert failed (${revert.join(' ')}):\n${reverted.output}`);
      }
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
if (failures > 0) {
  console.error(
    `\n${failures} canary(ies) did not trip their gate — a gate may have been silently weakened (З6)`,
  );
  process.exit(1);
}
console.log('all gates are alive');
