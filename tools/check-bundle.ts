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

// Детерминизм сборки (ADR 0005): адрес API не должен запекаться в клиентский
// бандл — иначе dist зависит от окружения сборки, кэш turbo между worktree
// (разные порты API) промахивается, а браузер стучится мимо прокси. Все
// loopback-формы: имя хоста, IPv4-петля, wildcard и IPv6-петля.
const jsFiles = files.filter((file) => file.endsWith('.js'));
const bakedAddresses: string[] = [];
for (const file of jsFiles) {
  const source = await readFile(join(assetsDir, file), 'utf8');
  for (const match of source.matchAll(/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):\d+/g)) {
    bakedAddresses.push(`${file}: ${match[0]}`);
  }
}
if (bakedAddresses.length > 0) {
  console.error(
    [
      '✗ Baked API addresses in the client bundle (ADR 0005): the build must not depend',
      '  on API_URL. Read the address at runtime: SSR — process.env.API_URL, browser —',
      '  location.origin (api-client.ts). Do not add localhost literals to client code.',
      '',
      ...bakedAddresses.slice(0, 10),
    ].join('\n'),
  );
  process.exit(1);
}

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
