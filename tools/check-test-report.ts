/**
 * Гейт целостности тестов по отчёту раннера (З3, A3): смотрит на результат
 * исполнения, а не на синтаксис. Во всех проектах, входящих в гейты, число
 * тестов со статусом skipped, todo и pending равно нулю; у Playwright, кроме
 * того, запрещён expected failure (expectedStatus "failed" — test.fail) и
 * требуется, чтобы обязательный проект (--expect-project) присутствовал в
 * отчёте, иначе проект с `default: false` мог бы молча не запуститься.
 *
 * Отчёты: Vitest — jest-совместимый JSON (`--reporter=json`), Playwright —
 * JSON reporter; вид определяется по форме, путь отчёта называет команда,
 * которая его пишет (turbo.json outputs ↔ script'ы пакетов).
 *
 * Откуда брать отчёты: явный список (--only, повторяемый) или из dry-графа
 * turbo (--from-turbo <task>): в PR CI turbo гоняется с --affected, поэтому
 * требовать отчёты всех пакетов нельзя — только тех задач, которые реально
 * исполнялись, включая кэш-попадания (outputs восстановлены). Путь отчёта —
 * literal-запись в outputs задачи, иначе конвенция (test → reports/vitest.json,
 * e2e → reports/e2e.json).
 *
 * Отсутствующий, нечитаемый, пустой отчёт и невалидная форма — красные
 * (З4, fail-closed). Пустой dry-граф при --affected — зелёный: ни одна задача
 * не гонялась, требовать нечего (docs-only PR); без --affected пустой набор —
 * красный (опечатка в имени задачи должна быть громкой).
 *
 * Нюанс (эмпирика 2026-11-13): it.fails в Vitest-отчёте неотличим от честного
 * теста — его и подавляющие комментарии ловит regex-гейт
 * check-test-integrity.ts, а не этот.
 *
 * Остаточный риск: содержимое отчёта производит код PR (суффикс в test-скрипте
 * package.json или запись в reports/ из теста может подсунуть чистый отчёт).
 * Гейт дополняет реальный прогон тестов в том же job, reports/ вне git; против
 * активной подделки — ревью правок тест-скриптов и мутационное тестирование.
 *
 * Аргументы: [--from-turbo <task>] [--affected] [--graph <dry.json>]
 * [--only <path>]... [--expect-project <name>]... [--cwd <dir>].
 * --affected добавляет --affected к вызову turbo (CI); --graph читает
 * готовый dry-граф вместо запуска turbo, --cwd задаёт корень относительных
 * путей (оба — для тестов).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

const BOOLEAN_FLAGS = new Set(['affected']);

const problems: string[] = [];

// Поля отчёта приходят из недоверенного входа: перевод строки подделает
// строчки лога шага (log injection), управляющие символы — замусорят его.
// Без regex: oxlint запрещает управляющие символы в регулярных выражениях.
function clean(value: string): string {
  let result = '';
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      result += code === 10 ? '\\n' : code === 9 ? '\\t' : `\\x${code.toString(16)}`;
    } else {
      result += char;
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rel(path: string, root: string): string {
  return isAbsolute(path) ? relative(root, path) : path;
}

function parseArgs(argv: string[]): Record<string, string[]> {
  const parsed: Record<string, string[]> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      break;
    }
    if (!arg.startsWith('--')) {
      problems.push(`unexpected argument: ${arg}`);
      continue;
    }
    const name = arg.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      parsed[name] = [];
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      problems.push(`flag --${name} requires a value`);
      continue;
    }
    index += 1;
    (parsed[name] ??= []).push(value);
  }
  return parsed;
}

interface ExpectedReport {
  path: string;
  /** Задача turbo, требующая отчёт; null для --only (вид определяется по форме). */
  fromTask: string | null;
}

function isLiteralPath(value: string): boolean {
  return !/[*?[]/.test(value);
}

/**
 * Dry-граф turbo: задачи с реальной командой требуют отчёты, задачи без
 * скрипта turbo помечает как <NONEXISTENT>. Путь отчёта — literal-запись
 * outputs, иначе конвенция по имени задачи.
 */
function expectedFromGraph(graph: unknown, task: string, root: string): ExpectedReport[] {
  if (!isRecord(graph) || !Array.isArray(graph['tasks'])) {
    problems.push('turbo dry-json: no "tasks" array');
    return [];
  }
  const expected: ExpectedReport[] = [];
  for (const entry of graph['tasks']) {
    if (!isRecord(entry) || typeof entry['taskId'] !== 'string') {
      problems.push('turbo dry-json: task without taskId');
      continue;
    }
    if (!entry['taskId'].endsWith(`#${task}`)) {
      continue;
    }
    const command = entry['command'];
    if (typeof command !== 'string' || command === '' || command === '<NONEXISTENT>') {
      continue;
    }
    const directory = typeof entry['directory'] === 'string' ? entry['directory'] : '';
    if (directory === '') {
      problems.push(`turbo dry-json: ${entry['taskId']} without directory`);
      continue;
    }
    const outputs = Array.isArray(entry['outputs']) ? entry['outputs'] : [];
    const literal = outputs.find(
      (item) => typeof item === 'string' && item.endsWith('.json') && isLiteralPath(item),
    );
    const reportPath =
      typeof literal === 'string'
        ? join(root, directory, literal)
        : task === 'test'
          ? join(root, directory, 'reports/vitest.json')
          : task === 'e2e'
            ? join(root, directory, 'reports/e2e.json')
            : null;
    if (reportPath === null) {
      problems.push(`no report convention for task "${task}"`);
      continue;
    }
    expected.push({ path: reportPath, fromTask: entry['taskId'] });
  }
  return expected;
}

function turboGraph(task: string, affected: boolean, root: string): unknown {
  const args = ['exec', 'turbo', 'run', task, '--dry=json'];
  if (affected) {
    args.push('--affected');
  }
  const result = spawnSync('pnpm', args, { encoding: 'utf8', cwd: root, timeout: 60_000 });
  if (result.error !== undefined || result.status !== 0) {
    problems.push(`turbo dry-json failed: ${result.stderr?.trim() || String(result.error)}`);
    return null;
  }
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch (error) {
    problems.push(
      `turbo dry-json not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function checkVitestReport(report: Record<string, unknown>, label: string, root: string): void {
  const total = report['numTotalTests'];
  if (typeof total !== 'number') {
    problems.push(`${label}: "numTotalTests" must be a number`);
    return;
  }
  const testResults = report['testResults'];
  if (!Array.isArray(testResults)) {
    problems.push(`${label}: "testResults" must be an array`);
    return;
  }
  if (total === 0) {
    problems.push(
      `${label}: report contains no tests (runner excluded everything or tests were deleted)`,
    );
    return;
  }
  for (const fileResult of testResults) {
    if (!isRecord(fileResult) || typeof fileResult['name'] !== 'string') {
      problems.push(`${label}: testResult without a file name`);
      continue;
    }
    const file = rel(fileResult['name'], root);
    const assertions = fileResult['assertionResults'];
    if (!Array.isArray(assertions)) {
      problems.push(`${file}: "assertionResults" must be an array`);
      continue;
    }
    for (const raw of assertions) {
      if (!isRecord(raw) || typeof raw['status'] !== 'string') {
        problems.push(`${file}: assertion without status`);
        continue;
      }
      const fullName = typeof raw['fullName'] === 'string' ? clean(raw['fullName']) : '(unnamed)';
      const status = clean(raw['status']);
      if (status === 'skipped' || status === 'todo' || status === 'pending') {
        problems.push(`${file}: ${status} test "${fullName}"`);
      } else if (status !== 'passed' && status !== 'failed') {
        // Неизвестный статус раннера нельзя молча считать зелёным (З4).
        problems.push(`${file}: unknown test status "${status}" for "${fullName}"`);
      }
    }
  }
}

function checkPlaywrightSuites(suites: unknown, label: string, seenProjects: Set<string>): number {
  let testCount = 0;
  if (!Array.isArray(suites)) {
    problems.push(`${label}: "suites" must be an array`);
    return testCount;
  }
  for (const suite of suites) {
    if (!isRecord(suite)) {
      problems.push(`${label}: suite is not an object`);
      continue;
    }
    if (Array.isArray(suite['suites']) && suite['suites'].length > 0) {
      testCount += checkPlaywrightSuites(suite['suites'], label, seenProjects);
    }
    const specs = suite['specs'];
    if (!Array.isArray(specs)) {
      continue;
    }
    for (const spec of specs) {
      if (!isRecord(spec) || !Array.isArray(spec['tests'])) {
        continue;
      }
      const file = typeof spec['file'] === 'string' ? clean(spec['file']) : '(unknown file)';
      const title = typeof spec['title'] === 'string' ? clean(spec['title']) : '(unnamed)';
      for (const test of spec['tests']) {
        testCount += 1;
        if (!isRecord(test) || typeof test['expectedStatus'] !== 'string') {
          problems.push(`${file}: test without expectedStatus`);
          continue;
        }
        const expectedStatus = clean(test['expectedStatus']);
        if (expectedStatus === 'skipped' || expectedStatus === 'failed') {
          problems.push(`${file}: expectedStatus "${expectedStatus}" for "${title}"`);
        } else if (expectedStatus !== 'passed') {
          // passed — единственный ожидаемый исход; остальное нельзя молча пропускать.
          problems.push(`${file}: unexpected expectedStatus "${expectedStatus}" for "${title}"`);
        }
        if (typeof test['projectName'] === 'string') {
          seenProjects.add(test['projectName']);
        }
      }
    }
  }
  return testCount;
}

function checkPlaywrightReport(
  report: Record<string, unknown>,
  label: string,
  root: string,
  requiredProjects: string[],
): void {
  const seenProjects = new Set<string>();
  const testCount = checkPlaywrightSuites(report['suites'], label, seenProjects);
  if (testCount === 0) {
    problems.push(
      `${label}: report contains no tests (runner excluded everything or tests were deleted)`,
    );
  }
  for (const project of requiredProjects) {
    if (!seenProjects.has(project)) {
      problems.push(
        `${label}: project "${project}" is missing from the report (it did not run; projects with default:false need an explicit --project)`,
      );
    }
  }
}

const argv = parseArgs(process.argv.slice(2));
const affected = argv['affected'] !== undefined;
const root = resolve(argv['cwd']?.[0] ?? process.cwd());

const expected: ExpectedReport[] = [];
for (const path of argv['only'] ?? []) {
  expected.push({ path: resolve(root, path), fromTask: null });
}
const fromTurbo = argv['from-turbo']?.[0];
if (fromTurbo !== undefined) {
  let graph: unknown = null;
  const graphFile = argv['graph']?.[0];
  if (graphFile !== undefined) {
    const file = resolve(root, graphFile);
    try {
      graph = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    } catch (error) {
      problems.push(
        `${file}: not valid JSON (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  } else {
    graph = turboGraph(fromTurbo, affected, root);
  }
  if (graph !== null) {
    expected.push(...expectedFromGraph(graph, fromTurbo, root));
  }
}
const requiredProjects = argv['expect-project'] ?? [];

// docs-only PR: --affected оставляет ноль runnable-задач — проверять нечего,
// это зелёный пустой прогон, а не ошибка. Без --affected пустой набор означает
// опечатку в имени задачи или сломанный граф — красный (З4).
if (expected.length === 0 && affected && problems.length === 0 && fromTurbo !== undefined) {
  console.log(`test report: ok (0 affected ${fromTurbo} tasks — nothing to check)`);
  process.exit(0);
}
if (expected.length === 0 && problems.length === 0) {
  problems.push('no reports to check: pass --only or --from-turbo');
}

let checked = 0;
for (const { path, fromTask } of expected) {
  const label = fromTask !== null ? `${rel(path, root)} (from ${fromTask})` : rel(path, root);
  if (!existsSync(path)) {
    problems.push(`${label}: report is missing — run the tests that produce it`);
    continue;
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    problems.push(
      `${label}: not readable (${error instanceof Error ? error.message : String(error)})`,
    );
    continue;
  }
  let report: unknown;
  try {
    report = JSON.parse(text) as unknown;
  } catch (error) {
    problems.push(
      `${label}: not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
    continue;
  }
  if (!isRecord(report)) {
    problems.push(`${label}: report is not an object`);
    continue;
  }
  checked += 1;
  if (Array.isArray(report['suites'])) {
    checkPlaywrightReport(report, label, root, requiredProjects);
  } else {
    checkVitestReport(report, label, root);
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  console.error(
    '\nSkipped, todo and expected-failure tests hide regressions. Remove the modifier and fix the test or the code; if the app is wrong, report the bug.',
  );
  process.exit(1);
}
console.log(`test report: ok (${checked} report${checked === 1 ? '' : 's'} checked)`);
