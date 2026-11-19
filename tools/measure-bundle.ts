/**
 * Общий замер клиентского бандла web (gzip) для check-bundle и
 * check-bundle-delta (A6 PR-2, ADR 0013): один алгоритм и один список файлов —
 * два гейта обязаны мерять одно и то же. Гуарды детерминизма сборки (ADR 0005)
 * живут здесь, поэтому действуют на обе стороны дельты: и на кандидат, и на
 * базу, собранную в отдельном worktree.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

export interface BundleSizes {
  files: Array<{ file: string; gzipKb: number }>;
  totalJsKb: number;
  largestJsKb: number;
  totalCssKb: number;
}

/** Каталог собранных клиентских ассетов относительно корня репозитория. */
export function assetsDirUnder(root: string): string {
  return join(root, 'apps/web/dist/client/assets');
}

const sum = (items: Array<{ gzipKb: number }>): number =>
  items.reduce((total, item) => total + item.gzipKb, 0);

/**
 * Замеряет каталог ассетов. Бросает с человекочитаемой причиной: нет сборки,
 * запечённый адрес API (ADR 0005), смешанная сборка с чужими чанками.
 * Вызывающий превращает throw в красный шаг — fail-closed (З4).
 */
export async function measureBundle(assetsDir: string): Promise<BundleSizes> {
  const files = await readdir(assetsDir).catch(() => {
    throw new Error(`No build output at ${assetsDir}. Run \`pnpm build\` first.`);
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
    throw new Error(
      [
        '✗ Baked API addresses in the client bundle (ADR 0005): the build must not depend',
        '  on API_URL. Read the address at runtime: SSR — process.env.API_URL, browser —',
        '  location.origin (api-client.ts). Do not add localhost literals to client code.',
        '',
        ...bakedAddresses.slice(0, 10),
      ].join('\n'),
    );
  }

  const js = sizes.filter((s) => s.file.endsWith('.js'));
  const css = sizes.filter((s) => s.file.endsWith('.css'));

  // Turbo при cache-hit восстанавливает outputs, не подчищая чужие файлы: после
  // переключения источников рядом с актуальными чанками остаются чанки прошлой
  // сборки, и счётчик удваивается (наблюдалось 2026-11-14: 299.6/160 после
  // патча и отката). Признак смешанной сборки — больше одного entry-чанка.
  const entryChunks = js.filter((s) => /^index-.*\.js$/.test(s.file));
  if (entryChunks.length > 1) {
    throw new Error(
      [
        `✗ Stale build output: ${entryChunks.length} entry chunks in ${assetsDir}:`,
        ...entryChunks.map((s) => `  ${s.file} (${s.gzipKb.toFixed(1)} KB gzip)`),
        '  Turbo cache restore does not prune files left by other builds.',
        '  Rebuild clean: pnpm turbo run build --filter=@repo/web --force',
      ].join('\n'),
    );
  }

  return {
    files: sizes,
    totalJsKb: sum(js),
    largestJsKb: Math.max(0, ...js.map((s) => s.gzipKb)),
    totalCssKb: sum(css),
  };
}
