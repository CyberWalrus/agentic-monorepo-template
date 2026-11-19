/**
 * Раннер эталонных агентных прогонов (evals, задача C9.1, ADR 0016).
 *
 *   pnpm evals --all                     все сценарии по очереди
 *   pnpm evals due-date                  один сценарий по имени
 *   pnpm evals --list                    список сценариев
 *
 * Флаги: --out <каталог> (по умолчанию reports/evals), --model <имя>,
 * --timeout-minutes <N> (лимит агента, по умолчанию 45), --keep (не удалять
 * worktree — отладка), --agent <пресет> (claude), --agent-command <строка>
 * (подмена команды агента целиком), --install-command / --verify-command
 * (подмена шагов — швы для тестов, находка sanity-ревью плана).
 *
 * Прогон сценария: guards отсутствия фичи → чистый detached worktree от HEAD →
 * установка зависимостей → агент headless с промптом сценария через stdin →
 * `pnpm verify --full` в worktree руками раннера. pass — только зелёный verify,
 * самоотчёт агента метрикой не считается. Отчёт — JSON в --out (артефакт CI
 * `evals-<run_id>`, источник тренда для c9.4). Код выхода — 0, только если
 * каждый сценарий зелёный; guards/ошибки/недоступные метрики — громкий красный.
 *
 * Класс защиты: deny (ADR 0014, ADR 0016) — вызывается контуром CI (evals.yml).
 */
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import {
  agentVersion,
  buildAgentInvocation,
  parseAgentResult,
  type AgentMetrics,
} from './agent.ts';
import { runProcess } from './exec.ts';
import {
  buildReport,
  summaryLines,
  writeReport,
  type EvalsReport,
  type ScenarioOutcome,
} from './report.ts';
import { discoverScenarios, guardViolations, loadScenario, type ScenarioRef } from './scenarios.ts';
import { createEvalWorktree, headSha, removeEvalWorktree } from './worktree.ts';

const INSTALL_TIMEOUT_MS = 10 * 60_000;
const VERIFY_TIMEOUT_MS = 20 * 60_000;
// Калибровка 2026-11-19: полный стек-эталон (контракт→API→UI→E2E) с холодным
// worktree (без турбо-кэша) занял у агента больше 45 мин — таймаут должен
// покрывать работу агента и его собственные прогоны verify с запасом.
const DEFAULT_TIMEOUT_MINUTES = 90;

export interface RunEvalsOptions {
  root: string;
  scenarios: string[];
  outDir: string;
  model?: string;
  timeoutMinutes: number;
  keepWorktree: boolean;
  agentPreset: string;
  agentCommand?: string;
  installCommand: string;
  verifyCommand: string;
  runId: string;
}

export interface RunEvalsResult {
  report: EvalsReport;
  reportPath: string;
  exitCode: number;
}

export async function runEvals(options: RunEvalsOptions): Promise<RunEvalsResult> {
  const refs = discoverScenarios(options.root).filter(
    (ref) => options.scenarios.length === 0 || options.scenarios.includes(ref.name),
  );
  const unknown = options.scenarios.filter((name) => !refs.some((ref) => ref.name === name));
  if (unknown.length > 0) {
    throw new Error(
      `сценарии не найдены: ${unknown.join(', ')}; есть: ${discoverScenarios(options.root)
        .map((ref) => ref.name)
        .join(', ')}`,
    );
  }
  const invocation = buildAgentInvocation(options.agentPreset, options.model);
  const agentCommand = options.agentCommand ?? shellLine(invocation.command, invocation.args);
  const version =
    options.agentCommand === undefined
      ? await agentVersion(invocation.command, options.root, runProcess)
      : null;
  // Один baseSha на весь прогон: сценарии внутри запуска сопоставимы между
  // собой, а HEAD, сдвинувшийся посреди прогона, не смешивает базы.
  const baseSha = await headSha(options.root);

  const outcomes: ScenarioOutcome[] = [];
  for (const ref of refs) {
    outcomes.push(await runScenario(options, agentCommand, ref, baseSha));
  }

  const report = buildReport(outcomes, {
    runId: options.runId,
    commit: baseSha,
    agentName: options.agentCommand === undefined ? options.agentPreset : 'custom',
    agentCommand,
    agentVersion: version,
    model: options.model ?? null,
    installCommand: options.installCommand,
    verifyCommand: options.verifyCommand,
    timeoutMinutes: options.timeoutMinutes,
  });
  const reportPath = writeReport(options.outDir, report);
  const exitCode = outcomes.every((item) => item.pass === true) ? 0 : 1;
  return { report, reportPath, exitCode };
}

async function runScenario(
  options: RunEvalsOptions,
  agentCommand: string,
  ref: ScenarioRef,
  baseSha: string,
): Promise<ScenarioOutcome> {
  const scenario = loadScenario(ref);
  const outcome: ScenarioOutcome = {
    scenario: ref.name,
    description: scenario.description,
    promptSha256: createHash('sha256').update(scenario.prompt).digest('hex'),
    pass: null,
    iterations: null,
    timeMs: null,
    tokens: null,
    agentExitCode: null,
    verifyExitCode: null,
    invalid: null,
    error: null,
  };

  const violations = guardViolations(scenario, options.root);
  if (violations.length > 0) {
    outcome.invalid = `guards-not-present нарушены: ${violations.join('; ')} — фича уже реализована, сценарий подлежит замене тем же PR`;
    return outcome;
  }

  const worktree = await createEvalWorktree(options.root, baseSha);
  try {
    const install = await runProcess('/bin/sh', ['-c', options.installCommand], {
      cwd: worktree.path,
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    if (install.code !== 0) {
      outcome.error = `установка зависимостей не удалась (код ${install.code})`;
      return outcome;
    }

    const started = Date.now();
    const agent = await runProcess('/bin/sh', ['-c', agentCommand], {
      cwd: worktree.path,
      input: `${scenario.prompt}\n`,
      timeoutMs: options.timeoutMinutes * 60_000,
    });
    outcome.timeMs = Date.now() - started;
    outcome.agentExitCode = agent.code;
    if (agent.timedOut) {
      outcome.error = `агент не уложился в ${options.timeoutMinutes} мин`;
      return outcome;
    }
    if (agent.code !== 0) {
      outcome.error = `агент завершился с кодом ${agent.code}`;
      return outcome;
    }
    let metrics: AgentMetrics;
    try {
      metrics = parseAgentResult(agent);
    } catch (error) {
      outcome.error = error instanceof Error ? error.message : String(error);
      return outcome;
    }
    outcome.iterations = metrics.iterations;
    outcome.tokens = metrics.tokens;
    if (metrics.isError) {
      outcome.error = `агент отчитался об ошибке: ${metrics.resultText.slice(0, 200)}`;
      return outcome;
    }

    const verify = await runProcess('/bin/sh', ['-c', options.verifyCommand], {
      cwd: worktree.path,
      timeoutMs: VERIFY_TIMEOUT_MS,
    });
    outcome.verifyExitCode = verify.code;
    outcome.pass = verify.code === 0;
    if (verify.code !== 0) {
      outcome.error = `verify красный (код ${verify.code}) — см. ${worktree.path}`;
    }
    return outcome;
  } finally {
    if (!options.keepWorktree) {
      await removeEvalWorktree(options.root, worktree.path);
    }
  }
}

/** Безопасный токен shell-строки: без пробелов и кавычек — кавычка не нужна. */
const SHELL_SAFE_RE = /^[a-zA-Z0-9@/._=:${}-]+$/;

function shellQuote(item: string): string {
  return SHELL_SAFE_RE.test(item) ? item : `'${item.replaceAll("'", `'\\''`)}'`;
}

/** Строковая команда агента: пресет без shell (без кавычек), подменённый — как дали. */
function shellLine(command: string, args: string[]): string {
  return [command, ...args].map(shellQuote).join(' ');
}

function die(message: string): never {
  process.stderr.write(`pnpm evals: ${message}\n`);
  process.exit(1);
}

/** Значение строкового флага или undefined (boolean-флаги и отсутствие — не строка). */
function stringArg(args: Record<string, string | boolean>, flag: string): string | undefined {
  const value = args[flag];
  return typeof value === 'string' ? value : undefined;
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {};
  const flagsWithValues = new Set([
    '--out',
    '--model',
    '--timeout-minutes',
    '--agent',
    '--agent-command',
    '--install-command',
    '--verify-command',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (token.startsWith('--')) {
      if (flagsWithValues.has(token)) {
        const value = argv[index + 1];
        if (value === undefined) {
          die(`${token} требует значение`);
        }
        parsed[token] = value;
        index += 1;
        continue;
      }
      parsed[token] = true;
      continue;
    }
    const previous = parsed['name'];
    const previousNames = typeof previous === 'string' ? previous : undefined;
    parsed['name'] = previousNames === undefined ? token : `${previousNames},${token}`;
  }
  return parsed;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const root = process.cwd();
  if (args['--list'] === true) {
    for (const ref of discoverScenarios(root)) {
      const scenario = loadScenario(ref);
      process.stdout.write(`${ref.name}: ${scenario.description}\n`);
    }
    return 0;
  }
  const names =
    typeof args['name'] === 'string'
      ? args['name'].split(',')
      : args['--all'] === true
        ? []
        : undefined;
  if (names === undefined) {
    die('укажи имена сценариев или --all');
  }
  const timeoutRaw = args['--timeout-minutes'];
  const timeoutMinutes =
    timeoutRaw === undefined
      ? DEFAULT_TIMEOUT_MINUTES
      : Number.parseInt(stringArg(args, '--timeout-minutes') ?? '', 10);
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes <= 0) {
    die(`--timeout-minutes: целое число минут, получено «${String(timeoutRaw)}»`);
  }
  const model = stringArg(args, '--model');
  const agentCommand = stringArg(args, '--agent-command');
  const { report, reportPath, exitCode } = await runEvals({
    root,
    scenarios: names,
    outDir: stringArg(args, '--out') ?? 'reports/evals',
    ...(model === undefined ? {} : { model }),
    timeoutMinutes,
    keepWorktree: args['--keep'] === true,
    agentPreset: stringArg(args, '--agent') ?? 'claude',
    ...(agentCommand === undefined ? {} : { agentCommand }),
    installCommand: stringArg(args, '--install-command') ?? 'pnpm install --frozen-lockfile',
    verifyCommand: stringArg(args, '--verify-command') ?? 'pnpm verify --full',
    runId: new Date().toISOString(),
  });
  process.stdout.write(`${summaryLines(report).join('\n')}\nотчёт: ${reportPath}\n`);
  return exitCode;
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(await main(process.argv.slice(2)));
}
