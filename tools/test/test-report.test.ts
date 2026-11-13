/**
 * Канарейка гейта test-report (A3, З3): пропущенные и «залеченные» тесты ловятся
 * по отчёту раннера, а не по синтаксису. Приёмы из аудита A3 в отчёте Vitest дают
 * статусы skipped/todo; у Playwright запрещены expectedStatus "skipped" и "failed"
 * (test.fail). Отсутствующий, нечитаемый, пустой отчёт и невалидная форма — красные
 * (З4, fail-closed). Ожидания для --from-turbo выводятся из dry-графа turbo, задачи
 * без команды (<NONEXISTENT>) не требуют отчёта. Исходники трюков собираются
 * конкатенацией строк, чтобы не матчить собственные гейты (прецедент STUB_VERIFY
 * в stop-verify.test.ts).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const repoDir = resolve(import.meta.dirname, '..', '..');
const checker = join(repoDir, 'tools', 'check-test-report.ts');
const vitestBin = join(repoDir, 'node_modules', '.bin', 'vitest');

let tmpRoot = '';

afterAll(() => {
  if (tmpRoot !== '') {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

function nextDir(prefix: string): string {
  if (tmpRoot === '') {
    tmpRoot = mkdtempSync(join(tmpdir(), 'a3-report-'));
  }
  const dir = mkdtempSync(join(tmpRoot, `${prefix}-`));
  return dir;
}

function runChecker(args: string[]): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [checker, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (result.error) {
    throw result.error;
  }
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

// Ключевые слова собираются из кусков: готовый литерал запрещённого вызова в этом
// файле поймали бы regex-гейт (он не отличает строковые литералы от кода) и линтер.
const SKIP = ['sk', 'ip'].join('');
const FAILS = ['fa', 'ils'].join('');
const TODO = ['to', 'do'].join('');
const TRICKS_SOURCE = [
  "import { describe, expect, it, test } from 'vitest';",
  `describe('tricks', () => {`,
  `  it.${FAILS}('expected failure hides a bug', () => { expect(1 + 1).toBe(3); });`,
  `  it.${SKIP}If(true)('skipped by skipIf', () => {});`,
  `  it.runIf(false)('never runs runIf', () => {});`,
  `  test('object option skip', { ${SKIP}: true }, () => {});`,
  `  it('context skip inside', (context) => { context.${SKIP}(); });`,
  `  it.concurrent.${SKIP}('concurrent skip', () => {});`,
  `  it.${TODO}('a todo', () => {});`,
  `  it('honest test', () => { expect(2).toBe(2); });`,
  `});`,
].join('\n');

const HONEST_SOURCE = [
  "import { expect, it } from 'vitest';",
  `it('honest passing test', () => { expect(2).toBe(2); });`,
].join('\n');

const VITEST_REPORTER = ['--reporter=json', '--reporter=default'];

/** Прогоняет реальный vitest на fixture-проекте и пишет отчёт рядом. */
function vitestFixture(prefix: string, files: Record<string, string>): string {
  const dir = nextDir(prefix);
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(join(dir, name), source);
  }
  // cwd — fixture-каталог: vitest иначе подхватит корневой vitest.config.ts
  // (include tools/test/**) и не найдёт в фикстуре ни одного теста.
  const result = spawnSync(vitestBin, ['run', ...VITEST_REPORTER, '--outputFile=report.json'], {
    encoding: 'utf8',
    cwd: dir,
    timeout: 120_000,
  });
  if (result.error) {
    throw result.error;
  }
  return join(dir, 'report.json');
}

function syntheticReport(prefix: string, payload: unknown): string {
  const dir = nextDir(prefix);
  const path = join(dir, 'report.json');
  writeFileSync(path, typeof payload === 'string' ? payload : JSON.stringify(payload));
  return path;
}

const CLEAN_VITEST = {
  numTotalTests: 1,
  numTodoTests: 0,
  testResults: [
    {
      name: '/repo/apps/api/src/honest.test.ts',
      status: 'passed',
      assertionResults: [{ fullName: 'honest passing test', status: 'passed', title: 'honest' }],
    },
  ],
};

const CLEAN_PLAYWRIGHT = {
  suites: [
    {
      title: 'features/honest.spec.ts',
      file: 'features/honest.spec.ts',
      suites: [],
      specs: [
        {
          title: 'honest passing test',
          file: 'features/honest.spec.ts',
          tests: [{ expectedStatus: 'passed', projectName: 'functional', results: [] }],
        },
      ],
    },
  ],
};

it('приёмы из аудита A3 видны в реальном отчёте vitest и называются файлом и тестом', () => {
  const report = vitestFixture('vitest-tricks', {
    'skip.test.ts': TRICKS_SOURCE,
    'honest.test.ts': HONEST_SOURCE,
  });
  const result = runChecker(['--only', report]);
  expect(result.status).toBe(1);
  for (const title of [
    'skipped by skipIf',
    'never runs runIf',
    'object option skip',
    'context skip inside',
    'concurrent skip',
    'a todo',
  ]) {
    expect(result.output).toContain(title);
  }
  expect(result.output).toContain('skip.test.ts');
  // Честный тест не флагуется.
  expect(result.output).not.toContain('honest passing test');
});

it('pending-статус и пустой отчёт ловятся', () => {
  const pending = syntheticReport('vitest-pending', {
    numTotalTests: 1,
    testResults: [
      {
        name: '/repo/apps/web/src/x.test.ts',
        status: 'passed',
        assertionResults: [{ fullName: 'later', status: 'pending', title: 'later' }],
      },
    ],
  });
  const pendingResult = runChecker(['--only', pending]);
  expect(pendingResult.status).toBe(1);
  expect(pendingResult.output).toContain('pending');
  expect(pendingResult.output).toContain('x.test.ts');

  const empty = syntheticReport('vitest-empty', { numTotalTests: 0, testResults: [] });
  const emptyResult = runChecker(['--only', empty]);
  expect(emptyResult.status).toBe(1);
  expect(emptyResult.output).toMatch(/no tests/);
});

it('playwright: skip, fixme и test.fail ловятся по expectedStatus', () => {
  const report = syntheticReport('pw-tricks', {
    suites: [
      {
        title: 'features/tricks.spec.ts',
        file: 'features/tricks.spec.ts',
        suites: [],
        specs: [
          {
            title: 'skipped with reason',
            file: 'features/tricks.spec.ts',
            tests: [{ expectedStatus: 'skipped', projectName: 'functional', results: [] }],
          },
          {
            title: 'fixme never runs',
            file: 'features/tricks.spec.ts',
            tests: [{ expectedStatus: 'skipped', projectName: 'functional', results: [] }],
          },
          {
            title: 'expected failure playwright',
            file: 'features/tricks.spec.ts',
            tests: [{ expectedStatus: 'failed', projectName: 'functional', results: [] }],
          },
          {
            title: 'honest passing test',
            file: 'features/tricks.spec.ts',
            tests: [{ expectedStatus: 'passed', projectName: 'functional', results: [] }],
          },
        ],
      },
    ],
  });
  const result = runChecker(['--only', report]);
  expect(result.status).toBe(1);
  expect(result.output).toContain('skipped with reason');
  expect(result.output).toContain('fixme never runs');
  expect(result.output).toContain('expected failure playwright');
  expect(result.output).not.toContain('honest passing test');
});

it('playwright: обязательный проект отсутствует — красный; присутствует — зелёный', () => {
  const without = runChecker([
    '--only',
    syntheticReport('pw-project-missing', CLEAN_PLAYWRIGHT),
    '--expect-project',
    'mobile',
  ]);
  expect(without.status).toBe(1);
  expect(without.output).toContain('mobile');

  const present = runChecker([
    '--only',
    syntheticReport('pw-project-present', CLEAN_PLAYWRIGHT),
    '--expect-project',
    'functional',
  ]);
  expect(present.status).toBe(0);
});

it('отсутствующий, битый и нечитаемый отчёт — красные с именем файла', () => {
  const missing = runChecker(['--only', join(nextDir('missing'), 'report.json')]);
  expect(missing.status).toBe(1);
  expect(missing.output).toMatch(/missing/);

  const corrupt = runChecker(['--only', syntheticReport('corrupt', '{nope')]);
  expect(corrupt.status).toBe(1);
  expect(corrupt.output).toMatch(/not valid JSON/);

  // Каталог вместо файла: ошибка чтения не должна маскироваться под битый JSON.
  const dirAsReport = nextDir('is-a-dir');
  const unreadable = runChecker(['--only', dirAsReport]);
  expect(unreadable.status).toBe(1);
  expect(unreadable.output).toMatch(/not readable/);
});

it('невалидная форма отчёта — красная (fail-closed)', () => {
  const shapeless = runChecker(['--only', syntheticReport('shapeless', '{}')]);
  expect(shapeless.status).toBe(1);
  expect(shapeless.output).toMatch(/numTotalTests/);
});

it('неизвестный статус раннера не считается зелёным (vitest и playwright)', () => {
  const flaky = syntheticReport('unknown-vitest', {
    numTotalTests: 1,
    testResults: [
      {
        name: '/repo/apps/api/src/x.test.ts',
        status: 'passed',
        assertionResults: [{ fullName: 'mystery', status: 'runTodoFlaky', title: 'mystery' }],
      },
    ],
  });
  const vitestResult = runChecker(['--only', flaky]);
  expect(vitestResult.status).toBe(1);
  expect(vitestResult.output).toMatch(/unknown test status/);

  const noStatus = syntheticReport('no-expected-status', {
    suites: [
      {
        title: 'features/x.spec.ts',
        file: 'features/x.spec.ts',
        suites: [],
        specs: [{ title: 'no status', file: 'features/x.spec.ts', tests: [{ results: [] }] }],
      },
    ],
  });
  const noStatusResult = runChecker(['--only', noStatus]);
  expect(noStatusResult.status).toBe(1);
  expect(noStatusResult.output).toMatch(/without expectedStatus/);

  const weird = syntheticReport('weird-expected-status', {
    suites: [
      {
        title: 'features/x.spec.ts',
        file: 'features/x.spec.ts',
        suites: [],
        specs: [
          {
            title: 'timed out expectation',
            file: 'features/x.spec.ts',
            tests: [{ expectedStatus: 'timedOut', projectName: 'functional', results: [] }],
          },
        ],
      },
    ],
  });
  const weirdResult = runChecker(['--only', weird]);
  expect(weirdResult.status).toBe(1);
  expect(weirdResult.output).toMatch(/unexpected expectedStatus/);
});

it('чистые отчёты проходят', () => {
  const result = runChecker([
    '--only',
    syntheticReport('clean-vitest', CLEAN_VITEST),
    '--only',
    syntheticReport('clean-pw', CLEAN_PLAYWRIGHT),
    '--expect-project',
    'functional',
  ]);
  expect(result.status).toBe(0);
  expect(result.output).toMatch(/ok/);
});

it('граф turbo: путь отчёта берётся из literal-записи outputs', () => {
  const dir = nextDir('outputs-literal');
  const graph = join(dir, 'dry.json');
  writeFileSync(
    graph,
    JSON.stringify({
      tasks: [
        {
          taskId: '@repo/api#test',
          directory: 'apps/api',
          command: 'vitest run',
          outputs: ['coverage/**', 'reports/custom.json'],
        },
      ],
    }),
  );
  // literal отличается от конвенции — только так видно, что именно outputs
  // называет путь (в проде это reports/vitest.json из turbo.json).
  const missing = runChecker(['--from-turbo', 'test', '--graph', graph, '--cwd', dir]);
  expect(missing.status).toBe(1);
  expect(missing.output).toContain('apps/api/reports/custom.json');
  expect(missing.output).not.toContain('apps/api/reports/vitest.json');
});

it('перевод строки в имени файла отчёта не подделывает строчки лога', () => {
  const injected = syntheticReport('log-injection', {
    numTotalTests: 1,
    testResults: [
      {
        name: '/repo/apps/api/src/x.test.ts\nFAKE: test report: ok (injected)',
        status: 'passed',
        assertionResults: [{ fullName: 'pending trick', status: 'pending', title: 'p' }],
      },
    ],
  });
  const result = runChecker(['--only', injected]);
  expect(result.status).toBe(1);
  expect(result.output).toMatch(/pending/);
  // Имя файла с \n печатается экранированным: фейковой строки в логе нет.
  expect(result.output).not.toMatch(/\nFAKE:/);
});

it('пустой affected-граф — зелёный пустой прогон (docs-only PR)', () => {
  const dir = nextDir('affected-empty');
  const graph = join(dir, 'dry.json');
  writeFileSync(graph, JSON.stringify({ tasks: [] }));
  const empty = runChecker(['--from-turbo', 'test', '--affected', '--graph', graph]);
  expect(empty.status).toBe(0);
  expect(empty.output).toMatch(/nothing to check/);
  // Без --affected пустой набор — красный: опечатка в имени задачи должна быть громкой.
  const withoutAffected = runChecker(['--from-turbo', 'test', '--graph', graph]);
  expect(withoutAffected.status).toBe(1);
  expect(withoutAffected.output).toMatch(/no reports to check/);
});

it('граф turbo: задачи с командой требуют отчёты, <NONEXISTENT> — нет', () => {
  const dir = nextDir('graph');
  const graph = join(dir, 'dry.json');
  writeFileSync(
    graph,
    JSON.stringify({
      tasks: [
        { taskId: '@repo/api#test', directory: 'apps/api', command: 'vitest run', outputs: [] },
        { taskId: '@repo/e2e#e2e', directory: 'e2e', command: 'playwright test', outputs: [] },
        {
          taskId: '@repo/e2e#test',
          directory: 'e2e',
          command: '<NONEXISTENT>',
          outputs: [],
        },
      ],
    }),
  );
  const missingTest = runChecker(['--from-turbo', 'test', '--graph', graph, '--cwd', dir]);
  expect(missingTest.status).toBe(1);
  expect(missingTest.output).toContain('apps/api/reports/vitest.json');
  // Задача @repo/e2e#test без команды не требует отчёта; #e2e — другая задача.
  expect(missingTest.output).not.toContain('e2e/reports/vitest.json');

  const missingE2e = runChecker(['--from-turbo', 'e2e', '--graph', graph, '--cwd', dir]);
  expect(missingE2e.status).toBe(1);
  expect(missingE2e.output).toContain('e2e/reports/e2e.json');

  // Чистые отчёты: vitest-формат для тестовой задачи, playwright-формат для e2e —
  // вид определяется по форме отчёта.
  for (const [relPath, payload] of [
    ['apps/api/reports/vitest.json', CLEAN_VITEST],
    ['e2e/reports/e2e.json', CLEAN_PLAYWRIGHT],
  ] as const) {
    const reportPath = join(dir, relPath);
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, JSON.stringify(payload));
  }
  const ok = runChecker(['--from-turbo', 'test', '--graph', graph, '--cwd', dir]);
  expect(ok.status).toBe(0);
});
