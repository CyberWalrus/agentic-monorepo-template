/**
 * Хуки агента не имеют права зависеть от node_modules (З4, roadmap A2 пункт 3):
 * без зависимостей падение хука с кодом 1 считается неблокирующей ошибкой, и контур
 * молча исчезает ровно тогда, когда node_modules нет, — а это самый нужный момент.
 * Канарейка: любой внешний import в хуковой цепочке роняет этот тест.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
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

// stop-verify.ts в списке с 2026-11-13: zod убран, отчёт verify валидируется
// вручную, неожиданная ошибка закрывается обёрткой (exit 2).
// C10.1: логика хуков — CLI в tools/ (tools/hooks/* + общие модули tools/),
// адаптер в .claude/hooks — только вызов; файлы lib.ts/*.main.ts из
// .claude/hooks переехали в tools/hooks.
describe('hooks are dependency-free', () => {
  for (const name of [
    'guard-bash.ts',
    'protect-paths.ts',
    'protect-result.ts',
    'session-start.ts',
    'stop-verify.ts',
    'lint-changed-file.ts',
  ]) {
    it(`${name} imports nothing from node_modules`, () => {
      const { files, external } = localChain(resolve(HOOKS_DIR, name));
      expect(files.length, 'import chain is discovered').toBeGreaterThanOrEqual(2);
      expect(external, 'external imports found').toEqual([]);
    });

    it(`${name}: вся логика — в tools/ (адаптер без логики, C10.1)`, () => {
      const { files } = localChain(resolve(HOOKS_DIR, name));
      const strays = files.slice(1).filter((file) => !file.includes(`${sep}tools${sep}`));
      expect(strays, 'files outside tools/ in the import chain').toEqual([]);
    });
  }
});
