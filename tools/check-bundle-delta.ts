/**
 * Дельта-гейт бандла (A6 PR-2, ADR 0013): рост total JS (gzip, КБ) от точки
 * ветвления с основной веткой. Порог — perf-budgets.json
 * web.bundle.maxPrGrowthKb; превышение одобряет человек label-ом
 * bundle-growth-approved на PR (решение о доверенном одобрении — ADR 0013).
 * Локальная краснота при поставленном label — ожидаемое состояние: merge
 * блокирует bundle-approval в CI, а не локальный шаг.
 *
 * База — merge-base(HEAD, <ref>): в CI передаётся base.sha (тот же base, что у
 * TURBO_SCM_BASE), локально origin/main. База строится в отдельном worktree с
 * общим кэшем turbo текущего чекаута: сборка main обычно в кэше; в CI оба
 * прогона холодные — это цена job'а bundle-delta, а не шага verify на main
 * (там base == HEAD и сборка шага build попадает в кэш).
 *
 *   node tools/check-bundle-delta.ts [--base <ref>]
 *
 * Fail-closed (З4): нет dist, нет merge-base, не собралась база — красный
 * с причиной, а не молчаливый пропуск.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { assetsDirUnder, measureBundle, type BundleSizes } from './measure-bundle.ts';
import { loadPerfBudgets } from './perf-budgets.ts';

const DEFAULT_BASE_REF = 'origin/main';
const INSTALL_TIMEOUT_MS = 600_000;
const BUILD_TIMEOUT_MS = 900_000;

const root = resolve(import.meta.dirname, '..');
const thresholdKb = loadPerfBudgets().web.bundle.maxPrGrowthKb;

// --base <ref>: единственный флаг. Неизвестный аргумент — отказ, а не игнор.
const argv = process.argv.slice(2);
let baseRef: string | undefined;
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === '--base') {
    baseRef = argv[index + 1];
    if (!baseRef) {
      console.error('check-bundle-delta: --base требует значение <ref>');
      process.exit(2);
    }
    index += 1;
    continue;
  }
  console.error(`check-bundle-delta: неизвестный аргумент «${arg}» (ожидается --base <ref>)`);
  process.exit(2);
}

function tail(output: string, lines = 5): string {
  return output.trim().split('\n').slice(-lines).join('\n');
}

function git(args: string[], cwd = root): { status: number; output: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
}

function run(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): { status: number; output: string } {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
}

// Кандидат: dist текущего чекаута (в verify slow-волне сборка идёт шагом build
// раньше; при прямом запуске без сборки — красный с причиной).
let current: BundleSizes;
try {
  current = await measureBundle(assetsDirUnder(root));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const ref = baseRef ?? DEFAULT_BASE_REF;
const mergeBase = git(['merge-base', 'HEAD', ref]);
if (mergeBase.status !== 0) {
  console.error(
    [
      `✗ Не удалось определить базу дельты: git merge-base HEAD ${ref} завершился с ошибкой.`,
      `  Выполни git fetch origin main или передай --base <ref> (в CI передаётся base.sha).`,
      `  ${tail(mergeBase.output, 1)}`,
    ].join('\n'),
  );
  process.exit(1);
}
const baseSha = mergeBase.output.trim().split('\n').at(-1) ?? '';

// База: отдельный worktree на merge-base, install + сборка с общим кэшем
// turbo. Любой сбой — красный: немерянная база не даёт верить дельте.
// Выход из catch — через флаг и process.exitCode, не process.exit():
// exit внутри catch пропускает finally и оставляет worktree базы в tmp.
const baseDir = mkdtempSync(join(tmpdir(), 'bundle-delta-base-'));
let base: BundleSizes | undefined;
try {
  const added = git(['worktree', 'add', '--detach', baseDir, baseSha]);
  if (added.status !== 0) {
    throw new Error(`git worktree add ${baseSha}: ${tail(added.output)}`);
  }
  const installed = run('pnpm', ['install', '--frozen-lockfile'], baseDir, INSTALL_TIMEOUT_MS);
  if (installed.status !== 0) {
    throw new Error(`pnpm install: ${tail(installed.output)}`);
  }
  const built = run(
    'pnpm',
    [
      'turbo',
      'run',
      'build',
      '--filter=@repo/web',
      '--output-logs=errors-only',
      `--cache-dir=${join(root, 'node_modules/.cache/turbo')}`,
    ],
    baseDir,
    BUILD_TIMEOUT_MS,
  );
  if (built.status !== 0) {
    throw new Error(`turbo build: ${tail(built.output)}`);
  }
  base = await measureBundle(assetsDirUnder(baseDir));
} catch (error) {
  console.error(
    [
      `✗ Сборка базы (${baseSha}) не удалась: ${error instanceof Error ? error.message : String(error)}`,
      '  Дельта не измерена — красный по контракту fail-closed (ADR 0013).',
    ].join('\n'),
  );
} finally {
  git(['worktree', 'remove', '--force', baseDir]);
  git(['worktree', 'prune']);
  rmSync(baseDir, { recursive: true, force: true });
}
// process.exit() — never: после guard'а base сужен до BundleSizes.
if (base === undefined) {
  process.exit(1);
}

const deltaKb = current.totalJsKb - base.totalJsKb;
const ok = deltaKb <= thresholdKb;

const fileDiffs = [
  ...new Set([...current.files.map((f) => f.file), ...base.files.map((f) => f.file)]),
]
  .map((name) => {
    const cur = current.files.find((f) => f.file === name)?.gzipKb ?? 0;
    const prev = base.files.find((f) => f.file === name)?.gzipKb ?? 0;
    return { file: name, currentKb: cur, baseKb: prev, diffKb: cur - prev };
  })
  .toSorted((a, b) => Math.abs(b.diffKb) - Math.abs(a.diffKb));

console.log(`bundle-delta: base ${baseSha.slice(0, 12)} (${ref})`);
console.log(
  `  total JS (gzip, KB): ${base.totalJsKb.toFixed(1)} → ${current.totalJsKb.toFixed(1)}  Δ ${deltaKb >= 0 ? '+' : ''}${deltaKb.toFixed(1)} / ${thresholdKb}`,
);
for (const row of fileDiffs.slice(0, 10)) {
  console.log(
    `  ${row.diffKb >= 0 ? '+' : ''}${row.diffKb.toFixed(1).padStart(7)} KB  ${row.file}  (${row.baseKb.toFixed(1)} → ${row.currentKb.toFixed(1)})`,
  );
}
if (fileDiffs.length > 10) {
  console.log(`  … ещё ${fileDiffs.length - 10} файлов: reports/bundle-delta.json`);
}

const round2 = (value: number): number => Number(value.toFixed(2));
// reports/ игнорируется git'ом и в CI-чекауте не существует (локально каталог
// создаёт шаг bundle раньше) — создаём сами, иначе writeFileSync падает ENOENT.
mkdirSync(join(root, 'reports'), { recursive: true });
writeFileSync(
  join(root, 'reports/bundle-delta.json'),
  `${JSON.stringify(
    {
      base: {
        ref,
        sha: baseSha,
        totalJsGzipKb: round2(base.totalJsKb),
        largestJsGzipKb: round2(base.largestJsKb),
        totalCssGzipKb: round2(base.totalCssKb),
      },
      current: {
        totalJsGzipKb: round2(current.totalJsKb),
        largestJsGzipKb: round2(current.largestJsKb),
        totalCssGzipKb: round2(current.totalCssKb),
      },
      deltaJsGzipKb: round2(deltaKb),
      thresholdKb,
      ok,
      files: fileDiffs.map((row) => ({
        file: row.file,
        currentKb: round2(row.currentKb),
        baseKb: round2(row.baseKb),
        diffKb: round2(row.diffKb),
      })),
    },
    null,
    2,
  )}\n`,
);
const summaryPath = process.env['GITHUB_STEP_SUMMARY'];
if (summaryPath) {
  appendFileSync(
    summaryPath,
    [
      '### Bundle delta (A6 PR-2, ADR 0013)',
      '',
      `| | base (${baseSha.slice(0, 12)}) | head | Δ |`,
      '| --- | --- | --- | --- |',
      `| total JS (gzip, KB) | ${base.totalJsKb.toFixed(1)} | ${current.totalJsKb.toFixed(1)} | ${deltaKb >= 0 ? '+' : ''}${deltaKb.toFixed(1)} / ${thresholdKb} |`,
      '',
    ].join('\n'),
  );
}

if (!ok) {
  console.error(
    [
      '',
      `✗ Bundle growth ${deltaKb.toFixed(1)} KB > ${thresholdKb} KB (perf-budgets.json web.bundle.maxPrGrowthKb).`,
      '  Рост одобряет человек: label bundle-growth-approved на PR (ADR 0013).',
      '  Локальная краснота при поставленном label — ожидаемое состояние: merge',
      '  блокирует CI-job bundle-approval, а не локальный шаг.',
    ].join('\n'),
  );
  process.exit(1);
}
