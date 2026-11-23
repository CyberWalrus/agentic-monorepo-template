/**
 * Тест классификации ответов check-flaky-rate (хвост e31, ночь 45013082390):
 * отсутствие flake.json и битый JSON — exit 1 с named-причиной и путём (З11,
 * не стек), «flaky rate не вычислен» (З4: отсутствие данных — не успех);
 * валидный отчёт — обычный путь чекера: все passed → зелёная сводка, микс
 * passed/failed → красный с тем же порогом 1% (G4). Гейт исполняет main()
 * на импорте, поэтому проверка через spawnSync самого скрипта (как CLI-тесты
 * check-perf-trend).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const checker = resolve(import.meta.dirname, '..', 'check-flaky-rate.ts');

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'flaky-rate-'));
  dirs.push(dir);
  return dir;
}

/**
 * Playwright-JSON отчёт: корень держит массив suites, suite — file + specs,
 * spec — tests[], test — results[].status. Повторы --repeat-each группируются
 * чекером по file :: title, поэтому N статусов в одном tests[] = N повторов.
 */
function flakeReport(specs: Array<{ file: string; title: string; statuses: string[] }>): string {
  return JSON.stringify({
    suites: specs.map((spec) => ({
      title: spec.file,
      file: spec.file,
      specs: [
        {
          title: spec.title,
          tests: spec.statuses.map((status) => ({
            title: spec.title,
            results: [{ status }],
          })),
        },
      ],
    })),
  });
}

function runChecker(args: string[]): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [checker, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.error) {
    throw result.error;
  }
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** named-причина (З11): одна строка повода, а не стек с кадрами «at …». */
function expectNotStack(result: { status: number | null; output: string }): void {
  expect(result.output).not.toMatch(/\n\s+at\s/);
}

it('flake.json отсутствует — exit 1, причина называет путь, не стек', () => {
  const missing = join(tempDir(), 'flake.json');
  const result = runChecker(['--report', missing, '--repeat', '5']);
  expect(result.status).toBe(1);
  expectNotStack(result);
  expect(result.output).toContain(missing);
  expect(result.output).toMatch(/отсутствует/);
  expect(result.output).toMatch(/playwright-шаг не записал flake\.json/);
  expect(result.output).toMatch(/flaky rate не вычислен/);
});

it('flake.json не JSON — exit 1, причина называет путь и битость, не стек', () => {
  const broken = join(tempDir(), 'flake.json');
  writeFileSync(broken, '{не json');
  const result = runChecker(['--report', broken, '--repeat', '5']);
  expect(result.status).toBe(1);
  expectNotStack(result);
  expect(result.output).toContain(broken);
  expect(result.output).toMatch(/не разбирается как JSON/);
  expect(result.output).toMatch(/flaky rate не вычислен/);
});

it('валидный отчёт, все passed — exit 0, обычная сводка чекера', () => {
  const report = join(tempDir(), 'flake.json');
  writeFileSync(
    report,
    flakeReport([
      {
        file: 'e2e/features/example/example.spec.ts',
        title: 'passes',
        statuses: ['passed', 'passed'],
      },
    ]),
  );
  const result = runChecker(['--report', report, '--repeat', '2']);
  expect(result.status).toBe(0);
  expect(result.output).toMatch(/flaky rate: 0\.00% \(0 из 1 тестов, порог < 1%, повторов 2\)/);
});

it('валидный отчёт с миксом passed/failed — exit 1 тем же порогом (G4)', () => {
  const report = join(tempDir(), 'flake.json');
  writeFileSync(
    report,
    flakeReport([
      {
        file: 'e2e/features/example/example.spec.ts',
        title: 'flaky between repeats',
        statuses: ['passed', 'failed'],
      },
    ]),
  );
  const result = runChecker(['--report', report, '--repeat', '2']);
  expect(result.status).toBe(1);
  expect(result.output).toMatch(/flaky rate 100\.00% >= 1% \(G4\)/);
  expect(result.output).toMatch(/падений вне карантина: 1/);
});

it('без --report — exit 1, назван обязательный флаг', () => {
  const result = runChecker(['--repeat', '5']);
  expect(result.status).toBe(1);
  expectNotStack(result);
  expect(result.output).toMatch(/флаг --report не передан/);
});
