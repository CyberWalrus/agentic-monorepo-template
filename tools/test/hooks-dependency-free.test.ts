/**
 * Хуки агента не имеют права зависеть от node_modules (З4, roadmap A2 пункт 3):
 * без зависимостей падение хука с кодом 1 считается неблокирующей ошибкой, и контур
 * молча исчезает ровно тогда, когда node_modules нет, — а это самый нужный момент.
 * Канарейка: любой внешний import в хуковой цепочке роняет этот тест.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HOOKS_DIR = resolve(import.meta.dirname, '..', '..', '.claude', 'hooks');

const IMPORT_RE =
  /(?:^|\n)(?:import|export)\s+(?:type\s+)?(?:[\w*\s{},$]+?from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function localChain(entry: string): { files: string[]; external: string[] } {
  const files: string[] = [];
  const external: string[] = [];
  const queue = [entry];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) {
      continue;
    }
    seen.add(file);
    files.push(file);
    for (const match of readFileSync(file, 'utf8').matchAll(IMPORT_RE)) {
      const specifier = match[1] ?? match[2] ?? '';
      if (specifier.startsWith('node:')) {
        continue;
      }
      if (specifier.startsWith('.')) {
        queue.push(resolve(dirname(file), specifier));
      } else {
        external.push(`${file} → ${specifier}`);
      }
    }
  }
  return { files, external };
}

// stop-verify.ts пока не в списке: он всё ещё читает отчёт verify через zod,
// его fail-closed закрытие входит в roadmap A2 пункт 2 (PR по merge-base).
describe('hooks are dependency-free', () => {
  for (const name of ['lib.ts', 'guard-bash.ts', 'protect-paths.ts', 'session-start.ts']) {
    it(`${name} imports nothing from node_modules`, () => {
      const { files, external } = localChain(resolve(HOOKS_DIR, name));
      expect(files.length, 'import chain is discovered').toBeGreaterThanOrEqual(1);
      expect(external, 'external imports found').toEqual([]);
    });
  }
});
