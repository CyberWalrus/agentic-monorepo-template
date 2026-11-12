/**
 * Бюджет размера клиентского бандла web (gzip). Пороги — /perf-budgets.json.
 * Требует собранного apps/web (`pnpm build`). Отчёт: reports/bundle.json.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { loadPerfBudgets } from './perf-budgets.ts';

const root = new URL('..', import.meta.url).pathname;
const assetsDir = join(root, 'apps/web/dist/client/assets');
const budget = loadPerfBudgets().web.bundle;

const files = await readdir(assetsDir).catch(() => {
  console.error(`No build output at ${assetsDir}. Run \`pnpm build\` first.`);
  process.exit(1);
});

const sizes = await Promise.all(
  files
    .filter((file) => file.endsWith('.js') || file.endsWith('.css'))
    .map(async (file) => ({
      file,
      gzipKb: gzipSync(await readFile(join(assetsDir, file))).length / 1024,
    })),
);

const js = sizes.filter((s) => s.file.endsWith('.js'));
const css = sizes.filter((s) => s.file.endsWith('.css'));
const sum = (items: { gzipKb: number }[]) => items.reduce((total, item) => total + item.gzipKb, 0);

const checks = [
  { metric: 'total JS (gzip, KB)', value: sum(js), limit: budget.maxTotalJsGzipKb },
  {
    metric: 'largest JS chunk (gzip, KB)',
    value: Math.max(0, ...js.map((s) => s.gzipKb)),
    limit: budget.maxLargestJsChunkGzipKb,
  },
  { metric: 'total CSS (gzip, KB)', value: sum(css), limit: budget.maxTotalCssGzipKb },
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
  `${JSON.stringify({ checks, files: sizes }, null, 2)}\n`,
);

if (checks.some((check) => check.value > check.limit)) {
  console.error(
    '\nBundle budget exceeded. Reduce the bundle (code-split, drop dependencies); do not raise the budget.',
  );
  process.exit(1);
}
