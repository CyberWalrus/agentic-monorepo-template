/**
 * Тесты tools/verify-diagnostics.ts (b9): диагностика «файл, строка, сообщение»
 * по машиночитаемым источникам шагов verify и её деградация к хвосту —
 * отсутствующий, устаревший, невалидный отчёт или отчёт без фейлов дают null
 * (потребители показывают сырой output), а не пустой список.
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { diagnoseStep, formatFindings } from '../verify-diagnostics.ts';

const root = mkdtempSync(join(tmpdir(), 'verify-diagnostics-'));
const NOW = 1_000_000_000_000;

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// Состояние не течёт между кейсами: сканирование идёт по apps/*/reports и
// reports/vitest-hooks.json — оба сбрасываются.
afterEach(() => {
  rmSync(join(root, 'apps'), { recursive: true, force: true });
  rmSync(join(root, 'reports'), { recursive: true, force: true });
});

/** Пакетный отчёт: apps/<pkg>/reports/vitest.json. */
function seedVitestReport(pkg: string, report: unknown): void {
  seedFile(join('apps', pkg, 'reports', 'vitest.json'), JSON.stringify(report));
}

/** Пишет файл в tmp-корне, создавая каталоги (writeFileSync их не создаёт). */
function seedFile(relativePath: string, content: string): void {
  const absolute = join(root, relativePath);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, content);
}

function failedAssertion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ancestorTitles: [],
    fullName: 'probe failure',
    status: 'failed',
    title: 'probe failure',
    duration: 1,
    failureMessages: [
      'AssertionError: expected 1 to be 2\n' +
        `    at ${join(root, 'apps/api/src/x.test.ts')}:4:13\n` +
        '    at file:///node_modules/vitest/dist/chunks/run.js:1632:35',
    ],
    meta: {},
    tags: [],
    benchmarks: [],
    ...overrides,
  };
}

function vitestReport(assertions: Record<string, unknown>[]): Record<string, unknown> {
  return {
    numTotalTests: assertions.length,
    numFailedTests: assertions.filter((a) => a['status'] === 'failed').length,
    success: false,
    testResults: [
      {
        name: join(root, 'apps/api/src/x.test.ts'),
        status: 'failed',
        assertionResults: assertions,
      },
    ],
  };
}

describe('diagnoseStep: vitest JSON (test / test:hooks)', () => {
  it('свежий отчёт с фейлом → файл, строка из стека, сообщение', () => {
    seedVitestReport('api', vitestReport([failedAssertion()]));
    const diagnostics = diagnoseStep(
      { name: 'test', command: 'pnpm', args: ['turbo', 'run', 'test'] },
      'tail ignored',
      NOW,
      root,
    );
    expect(diagnostics).not.toBeNull();
    expect(diagnostics?.source).toBe('vitest-json');
    expect(diagnostics?.findings).toEqual([
      {
        file: 'apps/api/src/x.test.ts',
        line: 4,
        message: 'probe failure: AssertionError: expected 1 to be 2',
      },
    ]);
  });

  it('отсутствующий отчёт → null (деградация к хвосту)', () => {
    const diagnostics = diagnoseStep(
      { name: 'test:hooks', command: 'pnpm', args: ['test:hooks'] },
      'TypeError: crashed',
      NOW,
      root,
    );
    expect(diagnostics).toBeNull();
  });

  it('устаревший отчёт (mtime раньше старта шага) → null', () => {
    const stale = join(root, 'reports/vitest-hooks.json');
    seedFile(
      join('reports', 'vitest-hooks.json'),
      JSON.stringify(vitestReport([failedAssertion()])),
    );
    const past = new Date(NOW - 60_000);
    utimesSync(stale, past, past);
    const diagnostics = diagnoseStep(
      { name: 'test:hooks', command: 'pnpm', args: ['test:hooks'] },
      'failed',
      NOW,
      root,
    );
    expect(diagnostics).toBeNull();
  });

  it('свежий отчёт без фейлов (краш до тестов) → null', () => {
    seedVitestReport(
      'web',
      vitestReport([{ ...failedAssertion(), status: 'passed', failureMessages: [] }]),
    );
    const diagnostics = diagnoseStep(
      { name: 'test', command: 'pnpm', args: ['turbo', 'run', 'test'] },
      'config error',
      NOW,
      root,
    );
    expect(diagnostics).toBeNull();
  });

  it('невалидный JSON отчёта пропускается, валидный сосед даёт список', () => {
    seedFile(join('apps', 'broken', 'reports', 'vitest.json'), '{"testResults": nope');
    seedVitestReport('ui', vitestReport([failedAssertion({ fullName: 'ui failure' })]));
    const diagnostics = diagnoseStep(
      { name: 'test', command: 'pnpm', args: ['turbo', 'run', 'test'] },
      'failed',
      NOW,
      root,
    );
    expect(diagnostics?.findings.map((f) => f.message)).toEqual([
      'ui failure: AssertionError: expected 1 to be 2',
    ]);
  });

  it('не vitest-форма (playwright suites) — пропускается', () => {
    seedVitestReport('contracts', JSON.stringify({ suites: [] }));
    seedVitestReport('preflight', vitestReport([failedAssertion({ fullName: 'pf failure' })]));
    const diagnostics = diagnoseStep(
      { name: 'test', command: 'pnpm', args: ['turbo', 'run', 'test'] },
      'failed',
      NOW,
      root,
    );
    expect(diagnostics?.findings).toHaveLength(1);
  });
});

describe('diagnoseStep: tsc-вывод (typecheck / typecheck:tools)', () => {
  const step = { name: 'typecheck', command: 'pnpm', args: ['turbo', 'run', 'typecheck'] };

  it('строки file(line,col): error TS… → список', () => {
    const output = [
      "apps/web/src/routes/index.tsx(12,7): error TS2322: Type 'number' is not assignable to type 'string'",
      '',
      'Found 1 error.',
    ].join('\n');
    const diagnostics = diagnoseStep(step, output, NOW, root);
    expect(diagnostics).toEqual({
      source: 'tsc-stdout',
      findings: [
        {
          file: 'apps/web/src/routes/index.tsx',
          line: 12,
          message: "TS2322: Type 'number' is not assignable to type 'string'",
        },
      ],
    });
  });

  it('нет распознанных ошибок (конфиг-сбой) → null', () => {
    expect(diagnoseStep(step, 'error TS5109: tsconfig broken', NOW, root)).toBeNull();
  });

  it('управляющие символы в сообщении экранируются (log injection)', () => {
    const diagnostics = diagnoseStep(
      step,
      'a.ts(1,1): error TS1: bad\u0000msg\nnext line',
      NOW,
      root,
    );
    expect(diagnostics?.findings[0]?.message).toBe('TS1: bad\\x0msg');
  });
});

describe('diagnoseStep: oxlint agent (lint) — passthrough', () => {
  it('строки file:line:col: … разбираются по префиксу, текст как есть', () => {
    const output = [
      'apps/api/src/x.ts:1:7: error eslint(no-unused-vars): Variable is unused. help: Remove it',
      '',
      '2 problems',
    ].join('\n');
    const diagnostics = diagnoseStep(
      { name: 'lint', command: 'pnpm', args: ['lint', '--format', 'agent'] },
      output,
      NOW,
      root,
    );
    expect(diagnostics?.source).toBe('oxlint-agent');
    expect(diagnostics?.findings[0]).toEqual({
      file: 'apps/api/src/x.ts',
      line: 1,
      message: 'error eslint(no-unused-vars): Variable is unused. help: Remove it',
    });
    expect(diagnostics?.findings[1]).toEqual({
      file: '(oxlint)',
      message: '2 problems',
    });
  });
});

describe('diagnoseStep: неизвестный шаг', () => {
  it('knip и прочие — null, текстовый вывод показывает хвост', () => {
    expect(
      diagnoseStep(
        { name: 'knip', command: 'pnpm', args: ['knip'] },
        'Unused exports (2)',
        NOW,
        root,
      ),
    ).toBeNull();
  });
});

describe('formatFindings', () => {
  it('файл:строка: сообщение; без строки, если её нет', () => {
    expect(
      formatFindings({
        source: 'vitest-json',
        findings: [
          { file: 'a.test.ts', line: 4, message: 'boom' },
          { file: 'b.test.ts', message: 'silent' },
        ],
      }),
    ).toBe('a.test.ts:4: boom\nb.test.ts: silent');
  });

  it('режет список до MAX_FINDINGS с пометкой источника', () => {
    const findings = Array.from({ length: 65 }, (_, i) => ({ file: `f${i}.ts`, message: 'x' }));
    const formatted = formatFindings({ source: 'vitest-json', findings }).split('\n');
    expect(formatted).toHaveLength(61);
    expect(formatted[60]).toBe('… and 5 more (source: vitest-json)');
  });
});
