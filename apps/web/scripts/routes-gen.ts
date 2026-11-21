/**
 * Генерация `src/routeTree.gen.ts` без vite-сборки (b7.1): `tsr generate`
 * (`@tanstack/router-cli`, пин версии генератора — в catalog pnpm-workspace.yaml)
 * плюс стартовый футер, который при сборке дописывает плагин Start.
 *
 * Почему двумя шагами: standalone-генератор про Start не знает и пишет дерево
 * без блока `declare module '@tanstack/react-start'` — его строит
 * start-plugin-core (`start-router-plugin/route-tree-footer.ts` из опций
 * старт-конфига). Для этого репозитория (tanstackStart() без опций, router.tsx
 * в src/) футер детерминирован, поэтому дописывается здесь — иначе `pnpm regen`
 * давал бы файл, отличающийся от результата сборки, и гейт дрейфа
 * (tools/check-routetree-drift.ts) разошёлся бы с vite.
 *
 * Граница версий: при подъёме @tanstack/react-start сверить футер с новым
 * start-plugin-core и поднять пин router-cli до генераторной версии чейна —
 * гейт дрейфа сверяет версии и краснеть не перестанет (сообщение гейта
 * называет оба шага). Класс защиты — apps/web, не гейт.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Стартовый футер routeTree (start-plugin-core buildRouteTreeFileFooter:
 * getRouter из src/router.tsx, createStart из пакета, ssr: true). Путь к
 * router.tsx — относительный от src/routeTree.gen.ts, как его считает плагин.
 */
export const ROUTE_TREE_FOOTER = [
  "import type { getRouter } from './router.tsx'",
  "import type { createStart } from '@tanstack/react-start'",
  "declare module '@tanstack/react-start' {",
  '  interface Register {',
  '    ssr: true',
  '    router: Awaited<ReturnType<typeof getRouter>>',
  '  }',
  '}',
].join('\n');

/**
 * Единая трансформация «вывод генератора → committed-файл»: голый вывод tsr
 * дописывается футером с пустой строкой-разделителем (плагин клеит футер к
 * последней строке через `\n${block}` — наблюдается наcommitted-файле).
 * Идемпотентно: футер уже на месте — строка возвращается как есть.
 */
export function withRouteTreeFooter(content: string): string {
  if (content.includes(ROUTE_TREE_FOOTER)) {
    return content;
  }
  const lineBreak = content.endsWith('\n') || content.length === 0 ? '' : '\n';
  return `${content}${lineBreak}\n${ROUTE_TREE_FOOTER}\n`;
}

/** Запуск tsr generate в apps/web; текст ошибки спавна — наружу. */
function runTsr(cwd: string): { ok: boolean; stderr: string } {
  const result = spawnSync('pnpm', ['exec', 'tsr', 'generate'], {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.error !== undefined) {
    return { ok: false, stderr: String(result.error) };
  }
  return { ok: result.status === 0, stderr: result.stderr ?? '' };
}

function main(): void {
  const webRoot = fileURLToPath(new URL('..', import.meta.url));
  const treePath = `${webRoot}src/routeTree.gen.ts`;
  const run = runTsr(webRoot);
  if (!run.ok) {
    console.error(`routes:gen — tsr generate failed: ${run.stderr.trim() || 'unknown error'}`);
    process.exit(1);
  }
  writeFileSync(treePath, withRouteTreeFooter(readFileSync(treePath, 'utf8')));
  console.log(
    'routes:gen — src/routeTree.gen.ts перегенерирован (@tanstack/router-cli + футер Start)',
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  main();
}
