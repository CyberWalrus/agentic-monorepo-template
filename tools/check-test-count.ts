/**
 * Храповик числа тестов (A3 п.3, З7): число тестов в пакете не уменьшается
 * без явного подтверждения. Warning-only — решение о блокирующем режиме за
 * человеком: падение числа тестов относительно базлайна и понижение базлайна
 * относительно merge-base дают WARNING с именем файла и обоими числами,
 * exit-код всегда 0. Битый или отсутствующий базлайн тоже WARNING — храповик
 * не должен молча ослепнуть.
 *
 * Базлайн — map «путь отчёта → число тестов», он же перечисляет, что храповик
 * смотрит (те же JSON-отчёты, что пишет гейт test-report). Отчёт, которого
 * нет (turbo --affected не гонял пакет), молча пропускается: сравнивается
 * только реально гонявшееся. База для сравнения базлайна: --merge-base <ref>,
 * иначе env TURBO_SCM_BASE, иначе origin/main → main → HEAD.
 *
 * `pnpm test:count:update` (--update) поднимает числа и добавляет новые
 * отчёты; понижать и удалять не умеет — ослабить храповик им нельзя (З7).
 * Автоматически порог может только ужесточаться; когда человек решит сделать
 * гейт блокирующим, файл базлайна уходит в protected-paths.
 *
 * Аргументы: [--cwd <dir>] [--baseline <path>] [--merge-base <ref>] [--update].
 * --cwd/--baseline/--merge-base — для тестов.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import { resolve } from 'node:path';

const BOOLEAN_FLAGS = new Set(['update']);
const REPORT_PATTERNS = [
  'apps/*/reports/vitest.json',
  'packages/*/reports/vitest.json',
  'reports/vitest-hooks.json',
];

const warnings: string[] = [];
const hints: string[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseArgs(argv: string[]): Record<string, string[]> {
  const parsed: Record<string, string[]> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      break;
    }
    if (!arg.startsWith('--')) {
      warnings.push(`unexpected argument: ${arg}`);
      continue;
    }
    const name = arg.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      parsed[name] = [];
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      warnings.push(`flag --${name} requires a value`);
      continue;
    }
    index += 1;
    (parsed[name] ??= []).push(value);
  }
  return parsed;
}

function readReportTotal(path: string): number | null {
  try {
    const report = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const total = isRecord(report) ? report['numTotalTests'] : undefined;
    if (typeof total !== 'number') {
      warnings.push(`${path}: report unreadable ("numTotalTests" is not a number)`);
      return null;
    }
    return total;
  } catch (error) {
    warnings.push(
      `${path}: report unreadable (${error instanceof Error ? error.message : String(error)})`,
    );
    return null;
  }
}

function git(args: string[], cwd: string): string | null {
  const result = spawnSync('git', args, { encoding: 'utf8', cwd, timeout: 30_000 });
  if (result.error !== undefined || result.status !== 0) {
    return null;
  }
  return result.stdout.trim();
}

function resolveBaseRef(root: string, explicit?: string): string | null {
  if (explicit !== undefined) {
    return explicit;
  }
  const fromEnv = process.env['TURBO_SCM_BASE'];
  if (fromEnv !== undefined && fromEnv !== '') {
    return fromEnv;
  }
  for (const candidate of ['origin/main', 'main', 'HEAD']) {
    if (git(['rev-parse', '--verify', candidate], root) !== null) {
      return candidate;
    }
  }
  return null;
}

const argv = parseArgs(process.argv.slice(2));
const root = resolve(argv['cwd']?.[0] ?? process.cwd());
const baselinePath = resolve(root, argv['baseline']?.[0] ?? 'test-count-baseline.json');

// Базлайн: map «путь отчёта → число тестов». Нечитаемый — WARNING: храповик
// не имеет права молча ослепнуть, но warning-only гейт не красит прогон.
let baseline: Record<string, number> | null = null;
if (!existsSync(baselinePath)) {
  warnings.push(
    `${argv['baseline']?.[0] ?? 'test-count-baseline.json'}: baseline is missing — run pnpm test:count:update to create it`,
  );
} else {
  try {
    const parsed: Record<string, number> = {};
    const raw: unknown = JSON.parse(readFileSync(baselinePath, 'utf8'));
    if (!isRecord(raw)) {
      throw new Error('expected an object of {report path: number}');
    }
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value !== 'number') {
        throw new Error(`expected a number for "${key}", got ${typeof value}`);
      }
      parsed[key] = value;
    }
    baseline = parsed;
  } catch (error) {
    warnings.push(
      `${argv['baseline']?.[0] ?? 'test-count-baseline.json'}: baseline is unreadable (${error instanceof Error ? error.message : String(error)}) — the ratchet is blind`,
    );
  }
}

if (argv['update'] !== undefined) {
  if (baseline === null) {
    baseline = {};
  }
  let lowered = 0;
  let raised = 0;
  for await (const entry of glob(REPORT_PATTERNS, { cwd: root })) {
    const key = entry.replaceAll('\\', '/');
    const total = readReportTotal(resolve(root, key));
    if (total === null) {
      continue;
    }
    const current = baseline[key];
    if (current === undefined || total > current) {
      baseline[key] = total;
      raised += 1;
      console.log(`raised ${key}: ${current ?? 'new'} → ${total}`);
    } else if (total < current) {
      lowered += 1;
      console.log(`refused to lower ${key}: baseline ${current} > current ${total}`);
    }
  }
  const sorted = Object.fromEntries(
    Object.entries(baseline).toSorted(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(baselinePath, `${JSON.stringify(sorted, null, 2)}\n`);
  if (lowered > 0) {
    console.log(`test count: updated with ${raised} raise(s); ${lowered} decrease(s) refused`);
  } else {
    console.log(`test count: baseline updated (${raised} raise(s))`);
  }
  process.exit(0);
}

// Понижение базлайна против merge-base: ослабление храповика видно в PR
// наравне с падением числа тестов.
const baseRef = resolveBaseRef(root, argv['merge-base']?.[0]);
if (baseline !== null && baseRef !== null) {
  const baseText = git(['show', `${baseRef}:test-count-baseline.json`], root);
  if (baseText !== null) {
    try {
      const parsed = JSON.parse(baseText) as unknown;
      if (isRecord(parsed) && Object.values(parsed).every((value) => typeof value === 'number')) {
        const baseBaseline = parsed;
        for (const key of Object.keys(baseline).toSorted()) {
          const baseValue = baseBaseline[key];
          const currentValue = baseline[key];
          if (
            typeof baseValue === 'number' &&
            currentValue !== undefined &&
            currentValue < baseValue
          ) {
            warnings.push(
              `test-count-baseline.json: baseline for "${key}" lowered vs ${baseRef}: ${baseValue} → ${currentValue} — a ratchet must only tighten; justify in the PR description`,
            );
          }
        }
      }
    } catch {
      // Базлайна не было в базе (новый файл) — сравнивать не с чем, не ошибка.
    }
  }
}

// Сравнение с отчётами: отсутствующий отчёт (--affected не гонял пакет) — пропуск.
let compared = 0;
if (baseline !== null) {
  for (const [key, expected] of Object.entries(baseline).toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const reportPath = resolve(root, key);
    if (!existsSync(reportPath)) {
      continue;
    }
    const total = readReportTotal(reportPath);
    if (total === null) {
      continue;
    }
    compared += 1;
    if (total < expected) {
      warnings.push(
        `${key}: test count decreased: ${expected} → ${total} — skipped or deleted tests hide regressions; justify in the PR description`,
      );
    } else if (total > expected) {
      hints.push(
        `${key}: tests grew ${expected} → ${total} — run pnpm test:count:update to raise the baseline`,
      );
    }
  }
}

for (const warning of warnings) {
  console.log(`WARNING: ${warning}`);
}
for (const hint of hints) {
  console.log(`hint: ${hint}`);
}
console.log(
  warnings.length > 0
    ? `test count: ${warnings.length} warning(s), ${compared} report(s) compared`
    : `test count: ok (${compared} report(s) compared)`,
);
process.exit(0);
