/**
 * Бюджет размера клиентского бандла web (gzip). Пороги — /perf-budgets.json.
 * Требует собранного apps/web (`pnpm build`). Отчёт: reports/bundle.json.
 * Замер общий с дельта-гейтом (tools/measure-bundle.ts, A6 PR-2): гуарды
 * детерминизма — там, здесь только пороги и отчёт.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { assetsDirUnder, measureBundle, type BundleSizes } from './measure-bundle.ts';
import { loadPerfBudgets } from './perf-budgets.ts';

const root = new URL('..', import.meta.url).pathname;
const budget = loadPerfBudgets().web.bundle;

let sizes: BundleSizes;
try {
  sizes = await measureBundle(assetsDirUnder(root));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const checks = [
  { metric: 'total JS (gzip, KB)', value: sizes.totalJsKb, limit: budget.maxTotalJsGzipKb },
  {
    metric: 'largest JS chunk (gzip, KB)',
    value: sizes.largestJsKb,
    limit: budget.maxLargestJsChunkGzipKb,
  },
  { metric: 'total CSS (gzip, KB)', value: sizes.totalCssKb, limit: budget.maxTotalCssGzipKb },
];

for (const check of checks) {
  const ok = check.value <= check.limit;
  console.log(
    `${ok ? '✓' : '✗'} ${check.metric.padEnd(30)} ${check.value.toFixed(1).padStart(7)} / ${check.limit}`,
  );
}

await mkdir(join(root, 'reports'), { recursive: true });
await writeFile(
  join(root, 'reports/bundle.json'),
  `${JSON.stringify({ checks, files: sizes.files }, null, 2)}\n`,
);

if (checks.some((check) => check.value > check.limit)) {
  console.error(
    '\nBundle budget exceeded. Reduce the bundle (code-split, drop dependencies); do not raise the budget.',
  );
  process.exit(1);
}
