/**
 * Патч канарейки 200 мс (A6 PR-3): вставляет задержку в create() домена
 * задач и проверяет, что применился — неприменённый патч дал бы зелёное
 * сравнение и красный job по ложной причине «канарейка не ловит» (находка
 * arch-ревью A6.1: причина должна быть точной).
 *
 *   node tools/perf-canary-patch.ts apply [--file PATH]
 *
 * По умолчанию — apps/api/src/tasks/repository.ts (in-memory репозиторий: в
 * ночном прогоне Postgres нет). Откат — git checkout -- <файл> в job'е.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_FILE = 'apps/api/src/tasks/repository.ts';
const ANCHOR = '  async create(title: string, ownerId?: string | null): Promise<Task> {\n';
const DELAY = '    await new Promise((resolve) => setTimeout(resolve, 200));\n';

const fileArg = process.argv.indexOf('--file');
const file = fileArg >= 0 ? process.argv[fileArg + 1] : undefined;
if (process.argv.includes('--file') && !file) {
  console.error('perf-canary-patch: --file требует значение PATH');
  process.exit(2);
}
const target = resolve(file ?? DEFAULT_FILE);

let source: string;
try {
  source = readFileSync(target, 'utf8');
} catch (error) {
  console.error(
    `✗ ${target}: не удалось прочитать (${error instanceof Error ? error.message : String(error)})`,
  );
  process.exit(1);
}
if (source.includes('setTimeout(resolve, 200)')) {
  console.error(`✗ ${target}: патч уже стоит — состояние нечистое`);
  process.exit(1);
}
const patched = source.replace(ANCHOR, `${ANCHOR}${DELAY}`);
if (patched === source) {
  console.error(`✗ ${target}: якорь create() не найден — патч не применился`);
  process.exit(1);
}
if (!patched.includes(DELAY)) {
  console.error(`✗ ${target}: после замены задержки нет — патч не применился`);
  process.exit(1);
}
writeFileSync(target, patched);
console.log(`perf-canary: задержка 200 мс вставлена в create() (${target})`);
