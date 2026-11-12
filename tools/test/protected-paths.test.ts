/**
 * Тесты tools/protected-paths.ts: ручная валидация конфига обязана падать закрытым
 * (битый конфиг → throw → импортирующий хук блокирует действие), а protectionOf —
 * отражать текущий список защищённых путей.
 */
import { describe, expect, it } from 'vitest';

import { parseProtectedPaths, protectionOf } from '../protected-paths.ts';

describe('parseProtectedPaths: fail-closed на битом конфиге', () => {
  const bad: [string, unknown][] = [
    ['строка вместо объекта', 'deny'],
    ['массив вместо объекта', ['deny']],
    ['null', null],
    ['нет ключа review', { deny: [] }],
    ['нет ключа deny', { review: [] }],
    ['deny не массив', { deny: 'tools/**', review: [] }],
    ['deny не из строк', { deny: [42], review: [] }],
    ['review не из строк', { deny: [], review: [null] }],
  ];
  for (const [name, raw] of bad) {
    it(`throws: ${name}`, () => {
      expect(() => parseProtectedPaths(raw)).toThrow(
        /expected an object|must be arrays of strings/,
      );
    });
  }

  it('accepts a valid config', () => {
    expect(parseProtectedPaths({ deny: ['a/**'], review: ['b.md'] })).toEqual({
      deny: ['a/**'],
      review: ['b.md'],
    });
  });
});

describe('protectionOf: текущий список защищённых путей', () => {
  const cases: [string, 'deny' | 'review' | null][] = [
    ['tools/protected-paths.json', 'deny'],
    ['tools/check-bundle.ts', 'deny'],
    ['.claude/hooks/guard-bash.ts', 'deny'],
    ['.claude/settings.json', 'deny'],
    ['perf-budgets.json', 'deny'],
    ['.oxlintrc.json', 'deny'],
    ['e2e/playwright.config.ts', 'deny'],
    ['packages/ui/src/__screenshots__/x.png', 'deny'],
    // каталог, внутри которого лежат защищённые файлы, защищён так же
    ['e2e/__screenshots__/tasks.visual.ts/diff.png', 'deny'],
    ['AGENTS.md', 'review'],
    ['CLAUDE.md', 'review'],
    ['docs/adr/0002-gate-integrity.md', 'review'],
    ['pnpm-workspace.yaml', 'review'],
    ['packages/ui/src/index.ts', null],
    ['apps/web/src/features/tasks/tasks-page.tsx', null],
    ['README.md', null],
  ];
  for (const [path, expected] of cases) {
    it(`"${path}" → ${expected ?? 'null'}`, () => {
      expect(protectionOf(path)).toBe(expected);
    });
  }
});
