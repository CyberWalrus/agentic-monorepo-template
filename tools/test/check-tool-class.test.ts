/**
 * Канарейка и тесты гейта check-tool-class (ADR 0014, e9): логика чекера —
 * на синтетических деревьях (замыкание вне deny обязано красить, лишняя
 * deny-запись тоже, зелёный случай проходит), проводка шага verify — на
 * настоящем репозитории (B4.1: канарейка gate-canaries «выбор E2E…» — образец).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkToolClass } from '../check-tool-class.ts';

// --- Синтетическое дерево -------------------------------------------------------

let tmp = '';

const TREE: Record<string, string> = {
  'package.json': `${JSON.stringify(
    {
      name: 'fixture',
      private: true,
      type: 'module',
      scripts: { 'docs:check': 'node tools/check-docs.ts' },
    },
    null,
    2,
  )}\n`,
  'vitest.config.ts': `export default { test: { include: ['tools/test/**/*.test.ts'] } };\n`,
  'tools/verify-steps.ts': `export const fast = [
  { name: 'docs', command: 'pnpm', args: ['docs:check'] },
];
export const post = [];
export const slow = [];\n`,
  // Литерал делает tools/protected-paths.json членом замыкания — как в
  // настоящем репозитории (gate-canaries, hooks), чтобы (б) проверялся с
  // цикличностью на месте.
  'tools/check-docs.ts': `import { model } from './board-model.ts';\nexport const use = model;\nexport const config = 'tools/protected-paths.json';\n`,
  'tools/board-model.ts': `export const model = { rules: 1 };\n`,
  'tools/hooks/lib.ts': `export const hookLib = true;\n`,
  'tools/test/board.test.ts': `import { expect, it } from 'vitest';\nit('stub', () => {\n  expect(1).toBe(1);\n});\n`,
  // Файл вне замыкания: для (б) — лишняя deny-запись и blanket tools/**.
  'tools/loose.ts': `export const loose = 1;\n`,
};

const DENY = [
  'tools/verify-steps.ts',
  'tools/check-docs.ts',
  'tools/board-model.ts',
  'tools/protected-paths.json',
  'tools/hooks/**',
  'tools/test/**',
];

function writeTree(deny: string[]): void {
  mkdirSync(tmp, { recursive: true });
  for (const [relative, content] of Object.entries(TREE)) {
    const path = join(tmp, relative);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  writeProtected(tmp, deny);
}

function writeProtected(root: string, deny: string[]): void {
  writeFileSync(
    join(root, 'tools/protected-paths.json'),
    `${JSON.stringify({ deny, review: [] }, null, 2)}\n`,
  );
}

beforeEach(() => {
  tmp = join(tmpdir(), `tool-class-fixture-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  writeTree(DENY);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// --- Логика чекера на синтетическом дереве --------------------------------------

describe('check-tool-class: логика на синтетическом дереве', () => {
  it('зелёный случай: замыкание покрыто deny — проблем нет', () => {
    const report = checkToolClass({
      root: tmp,
      knownGates: ['tools/check-docs.ts', 'tools/hooks/lib.ts', 'tools/test/board.test.ts'],
    });
    expect(report.problems).toEqual([]);
    expect(report.closure).toEqual(
      expect.arrayContaining([
        'tools/check-docs.ts',
        'tools/board-model.ts',
        'tools/hooks/lib.ts',
        'tools/test/board.test.ts',
      ]),
    );
    // Файл вне замыкания не попадает в отчёт.
    expect(report.closure).not.toContain('tools/loose.ts');
  });

  it('(а) файл замыкания вне deny — красит', () => {
    writeProtected(
      tmp,
      DENY.filter((entry) => entry !== 'tools/board-model.ts'),
    );
    const report = checkToolClass({ root: tmp, knownGates: ['tools/check-docs.ts'] });
    expect(report.problems.join('\n')).toMatch(/board-model\.ts/);
  });

  it('(б) лишняя deny-запись внутри tools/ — красит', () => {
    writeProtected(tmp, [...DENY, 'tools/loose.ts']);
    const report = checkToolClass({ root: tmp, knownGates: ['tools/check-docs.ts'] });
    expect(report.problems.join('\n')).toMatch(/tools\/loose\.ts/);
  });

  it('(б) blanket tools/** красит — покрывает файл вне замыкания', () => {
    writeProtected(tmp, [...DENY, 'tools/**']);
    const report = checkToolClass({ root: tmp, knownGates: ['tools/check-docs.ts'] });
    expect(report.problems.join('\n')).toMatch(/tools\/\*\*|tools\/loose\.ts/);
  });

  it('(в) шаг verify ссылается на несуществующий скрипт — красит', () => {
    writeFileSync(join(tmp, 'package.json'), `${JSON.stringify({ scripts: {} }, null, 2)}\n`);
    const report = checkToolClass({ root: tmp, knownGates: [] });
    expect(report.problems.join('\n')).toMatch(/docs:check/);
  });

  it('(в) скрипт ссылается на несуществующий tools-файл — красит', () => {
    writeFileSync(
      join(tmp, 'package.json'),
      `${JSON.stringify({ scripts: { 'docs:check': 'node tools/missing-gate.ts' } }, null, 2)}\n`,
    );
    const report = checkToolClass({ root: tmp, knownGates: [] });
    expect(report.problems.join('\n')).toMatch(/missing-gate\.ts/);
  });

  it('fail-closed: известный гейт не найден в замыкании — расчёт красный', () => {
    const report = checkToolClass({ root: tmp, knownGates: ['tools/ghost-gate.ts'] });
    expect(report.problems.join('\n')).toMatch(/ghost-gate\.ts/);
  });

  it('(major-1) цепочка скриптов pnpm→pnpm→tools-файл попадает в замыкание', () => {
    writeFileSync(
      join(tmp, 'package.json'),
      `${JSON.stringify(
        {
          scripts: {
            'docs:check': 'pnpm inner:check',
            'inner:check': 'node tools/hidden-gate.ts',
          },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(join(tmp, 'tools/hidden-gate.ts'), `export const gate = 1;\n`);
    // Замыкание изменилось: docs:check больше не ведёт к check-docs.ts —
    // его deny-записи убраны, иначе (б) честно красит устаревший список.
    writeProtected(tmp, [
      'tools/verify-steps.ts',
      'tools/hooks/**',
      'tools/test/**',
      'tools/hidden-gate.ts',
    ]);
    const report = checkToolClass({ root: tmp, knownGates: ['tools/hidden-gate.ts'] });
    expect(report.problems).toEqual([]);
    expect(report.closure).toContain('tools/hidden-gate.ts');
  });

  it('(major-1) tools-файл из цепочки скриптов без deny — красит', () => {
    writeFileSync(
      join(tmp, 'package.json'),
      `${JSON.stringify(
        {
          scripts: {
            'docs:check': 'pnpm inner:check',
            'inner:check': 'node tools/hidden-gate.ts',
          },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(join(tmp, 'tools/hidden-gate.ts'), `export const gate = 1;\n`);
    const report = checkToolClass({ root: tmp, knownGates: ['tools/check-docs.ts'] });
    expect(report.problems.join('\n')).toMatch(/hidden-gate\.ts/);
  });

  it('(major-2) нераспознанный относительный импорт — красит', () => {
    writeFileSync(
      join(tmp, 'tools/check-docs.ts'),
      `import { helper } from './ghost-helper.ts';\nimport { model } from './board-model.ts';\nexport const use = model;\n`,
    );
    const report = checkToolClass({ root: tmp, knownGates: ['tools/check-docs.ts'] });
    expect(report.problems.join('\n')).toMatch(/нераспознанный относительный импорт.*ghost-helper/);
  });

  it('(major-2) import-текст внутри строки — не ребро и не красит', () => {
    // Пробник канарейки: import-текст в строке записываемого файла; литерал
    // protected-paths.json сохранён — json остаётся членом замыкания.
    writeFileSync(
      join(tmp, 'tools/check-docs.ts'),
      `import { model } from './board-model.ts';\nexport const config = 'tools/protected-paths.json';\nexport const probe = "import { x } from '../tasks/use-tasks';";\nexport const use = model;\n`,
    );
    const report = checkToolClass({ root: tmp, knownGates: ['tools/check-docs.ts'] });
    expect(report.problems).toEqual([]);
  });

  it('(major-3) npx в контурном файле — красит', () => {
    writeFileSync(
      join(tmp, 'lefthook.yml'),
      `pre-commit:\n  commands:\n    x:\n      run: npx evil-tool\n`,
    );
    const report = checkToolClass({ root: tmp, knownGates: ['tools/check-docs.ts'] });
    expect(report.problems.join('\n')).toMatch(/нераспознанный вызов/);
  });

  it('(major-3) pnpm run — прозрачный токен, скрипт резолвится', () => {
    writeFileSync(
      join(tmp, 'lefthook.yml'),
      `pre-commit:\n  commands:\n    x:\n      run: pnpm run docs:check\n`,
    );
    const report = checkToolClass({ root: tmp, knownGates: ['tools/check-docs.ts'] });
    expect(report.problems).toEqual([]);
  });
});

// --- Проводка шага на настоящем репозитории (B4.1) -------------------------------

const repoRoot = resolve(import.meta.dirname, '../..');

/** Объект из JSON без `as`-присваиваний (правило линтера): плоская копия. */
function asRecord(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof value === 'object' && value !== null) {
    Object.assign(out, value);
  }
  return out;
}

describe('проводка: шаг tool-class в verify', () => {
  it('verify-steps содержит шаг tool-class в fast-волне', () => {
    const source = readFileSync(join(repoRoot, 'tools/verify-steps.ts'), 'utf8');
    expect(source).toMatch(/name:\s*'tool-class'/);
    expect(source).toMatch(/'tool-class:check'/);
  });

  it('package.json ведёт шаг к гейту', () => {
    const pkg = asRecord(JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')));
    const scripts = asRecord(pkg['scripts']);
    expect(scripts['tool-class:check']).toBe('node tools/check-tool-class.ts');
    expect(existsSync(join(repoRoot, 'tools/check-tool-class.ts'))).toBe(true);
  });

  it('CI исполняет шаг в job static (needs у gate)', () => {
    const ci = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toMatch(/pnpm tool-class:check/);
  });

  it('бюджет шага в verify-budgets.json', () => {
    const budgets = asRecord(
      JSON.parse(readFileSync(join(repoRoot, 'verify-budgets.json'), 'utf8')),
    );
    const fast = asRecord(budgets['fast']);
    expect(typeof fast['tool-class']).toBe('number');
  });
});
