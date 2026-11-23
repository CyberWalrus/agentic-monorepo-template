/**
 * Гейт состава workspace (e20, b13): каждая обязательная задача turbo объявлена
 * носителями в количестве не ниже MIN_CARRIERS. Прогон `turbo run <задача>`
 * без единого носителя завершается exit 0 («No tasks were executed»), поэтому
 * удаление пакетов-носителей тихо выключает гейты CI (mutation — никто, e2e —
 * только merge queue; e6, «дыра №1» research 2026-11-template-profiles.md), а
 * удаление ОДНОГО носителя тихо выключало гейт этого пакета — тест-count
 * warning-only, отчёту test-report нечего требовать у исчезнувшего скрипта
 * (b13): поэтому минимум, а не только ноль.
 *
 * Источник обязательного списка — один литеральный список здесь (REQUIRED_TASKS).
 * Механизм — turbo `--dry=json` БЕЗ --affected: состав workspace, а не прогон,
 * поэтому docs-only PR остаётся зелёным (по dry-спавну — как turboGraph в
 * check-test-report.ts). turbo рисует задачу из глобального определения
 * turbo.json для каждого пакета workspace и помечает отсутствующий скрипт как
 * <NONEXISTENT>: носителем считается только запись с реальной командой — иначе
 * гейт мёртв при рождении (в полном workspace у mutation есть 3 носителя и 3
 * призрака @repo/{e2e,preflight,ui}#mutation).
 *
 * Чистое ядро (carriersFromGraph, evaluateTask) отделено от CLI guard-ом
 * invokedDirectly: импорт из тестов не спавнит turbo (как в check-tool-class.ts).
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Обязательные задачи turbo; единое место определения списка. */
export const REQUIRED_TASKS: readonly string[] = ['build', 'test', 'e2e', 'mutation'];

/**
 * Минимальное число носителей на обязательную задачу (b13). Порог = фактический
 * состав репо на момент b13 (снят dry-графом): удаление скрипта у ОДНОГО
 * носителя тихо выключало гейт этого пакета (mutation в apps/api при живых
 * web/contracts), а гейт красил только полный ноль. Пороги:
 * - build: @repo/web — 1;
 * - test: @repo/{api,contracts,preflight,ui,web} — 5;
 * - e2e: @repo/e2e (merge queue по дизайну) — 1;
 * - mutation: @repo/{api,contracts,web} — 3.
 * Рост носителей порог не ломает (это минимум), сокращение носителей —
 * осознанная правка порога тем же PR (файл в deny protected-paths.json).
 * Задача REQUIRED_TASKS без порога — красная ветка (fail-closed, З4):
 * списки обязаны идти в ногу — инвариант в tools/test/check-required-tasks.
 */
export const MIN_CARRIERS: Readonly<Record<string, number>> = {
  build: 1,
  e2e: 1,
  mutation: 3,
  test: 5,
};

/** Результат dry-спавна turbo, вход чистой оценки. */
export interface DryRun {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Носители задачи в dry-графе — записи taskId с реальной командой. Задача без
 * скрипта в пакете помечена turbo как <NONEXISTENT> (глобальное определение
 * turbo.json рисует её для каждого пакета workspace) и носителем не считается:
 * тот же фильтр, что в check-test-report.ts. Битый граф — проблема, не пустой
 * список (fail-closed, З4). Чистая функция: тесты подают фикстуру dry-json.
 */
export function carriersFromGraph(
  graph: unknown,
  task: string,
): { carriers: string[]; problems: string[] } {
  if (!isRecord(graph) || !Array.isArray(graph['tasks'])) {
    return { carriers: [], problems: [`turbo dry-json (${task}): no "tasks" array`] };
  }
  const carriers: string[] = [];
  const problems: string[] = [];
  for (const entry of graph['tasks']) {
    if (!isRecord(entry) || typeof entry['taskId'] !== 'string') {
      problems.push(`turbo dry-json (${task}): task without taskId`);
      continue;
    }
    if (!entry['taskId'].endsWith(`#${task}`)) {
      continue;
    }
    const command = entry['command'];
    // Призрак: задача из глобального определения turbo.json без скрипта в пакете.
    if (typeof command !== 'string' || command === '' || command === '<NONEXISTENT>') {
      continue;
    }
    carriers.push(entry['taskId']);
  }
  return { carriers, problems };
}

/**
 * Оценка одной обязательной задачи по результату dry-спавна: срыв спавна и
 * опечатка в имени задачи — одна ветка (turbo exit ≠ 0, fail-closed З4),
 * битый JSON и битый граф — свои проблемы, ноль носителей —
 * «<задача>: ни одного пакета», носителей меньше MIN_CARRIERS (b13) —
 * «<задача>: носителей N, минимум M» — частично выключенная задача красит так
 * же громко, как выключенная целиком. Тоже чистая: спавн подставлен аргументом.
 */
export function evaluateTask(
  task: string,
  dry: DryRun,
): { problems: string[]; carriers: string[] } {
  if (!dry.ok) {
    const reason = dry.stderr.trim() || dry.stdout.trim() || 'unknown error';
    return {
      problems: [`turbo dry-json failed for ${task}: ${reason.split('\n')[0]}`],
      carriers: [],
    };
  }
  let graph: unknown;
  try {
    graph = JSON.parse(dry.stdout) as unknown;
  } catch (error) {
    return {
      problems: [
        `turbo dry-json (${task}) not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
      carriers: [],
    };
  }
  const min = MIN_CARRIERS[task];
  if (min === undefined) {
    return { problems: [`${task}: нет порога в MIN_CARRIERS`], carriers: [] };
  }
  const { carriers, problems } = carriersFromGraph(graph, task);
  if (problems.length > 0) {
    return { problems, carriers };
  }
  if (carriers.length === 0) {
    return { problems: [`${task}: ни одного пакета`], carriers: [] };
  }
  if (carriers.length < min) {
    return { problems: [`${task}: носителей ${carriers.length}, минимум ${min}`], carriers };
  }
  return { problems, carriers };
}

/** Dry-спавн turbo без --affected: состав workspace, не прогон. */
function dryRun(task: string, root: string): DryRun {
  const result = spawnSync('pnpm', ['exec', 'turbo', 'run', task, '--dry=json'], {
    encoding: 'utf8',
    cwd: root,
    timeout: 60_000,
  });
  if (result.error !== undefined) {
    return { ok: false, stdout: result.stdout ?? '', stderr: String(result.error) };
  }
  return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

// --- CLI ---------------------------------------------------------------------------

const repoRootFromHere = fileURLToPath(new URL('..', import.meta.url));
const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  const problems: string[] = [];
  const okLines: string[] = [];
  for (const task of REQUIRED_TASKS) {
    // Отдельный спавн на задачу: изолированная диагностика «задача: ни одного
    // пакета» вместо общего «граф сломан».
    const { problems: taskProblems, carriers } = evaluateTask(task, dryRun(task, repoRootFromHere));
    if (taskProblems.length > 0) {
      problems.push(...taskProblems);
      continue;
    }
    okLines.push(`${task}: ${carriers.join(', ')}`);
  }
  if (problems.length > 0) {
    console.error(
      'required tasks: обязательные задачи turbo без достаточного числа носителей (e20, b13)',
    );
    console.error(problems.map((problem) => `- ${problem}`).join('\n'));
    process.exit(1);
  }
  console.log(`required tasks: ok — ${okLines.join('; ')}`);
}
