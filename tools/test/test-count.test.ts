/**
 * Канарейка храповика числа тестов (A3, п.3, З7): число тестов в пакете
 * не уменьшается без явного подтверждения. Гейт warning-only: падение числа
 * тестов или понижение базлайна относительно merge-base даёт предупреждение
 * (имя файла и оба числа), но не блокирует; решение о блокировке за человеком.
 * `--update` поднимает базлайн и добавляет новые отчёты, понижать не умеет.
 * Базлайн — map «путь отчёта → число тестов»: сам же перечисляет, что храповик
 * смотрит. Отсутствующий отчёт (turbo --affected не гонял пакет) молча
 * пропускается — сравнивается только то, что реально гонялось.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const repoDir = resolve(import.meta.dirname, '..', '..');
const checker = join(repoDir, 'tools', 'check-test-count.ts');

const tmpDirs: string[] = [];
let gitCounter = 0;

afterAll(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function vitestReport(total: number): string {
  return JSON.stringify({ numTotalTests: total, testResults: [] });
}

interface Fixture {
  dir: string;
  /** Пишет отчёт (путь относительно корня фикстуры) и базлайн. */
  write(baseline: unknown, reports: Record<string, number>): void;
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'a3-count-'));
  tmpDirs.push(dir);
  const write = (baseline: unknown, reports: Record<string, number>): void => {
    const payload = typeof baseline === 'string' ? baseline : JSON.stringify(baseline, null, 2);
    writeFileSync(join(dir, 'test-count-baseline.json'), payload);
    for (const [path, total] of Object.entries(reports)) {
      const reportPath = join(dir, path);
      mkdirSync(resolve(reportPath, '..'), { recursive: true });
      writeFileSync(reportPath, vitestReport(total));
    }
  };
  return { dir, write };
}

/** Fixture-репо с git-историей: базлайн в merge-base, изменённый в HEAD. */
function gitFixture(baselineAtBase: string, baselineAtHead: string): string {
  const dir = mkdtempSync(join(tmpdir(), `a3-count-git-${(gitCounter += 1)}-`));
  tmpDirs.push(dir);
  const git = (args: string[]): void => {
    const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 30_000 });
    if (result.error || result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    }
  };
  git(['init', '-q']);
  git(['config', 'user.email', 'canary@example.com']);
  git(['config', 'user.name', 'canary']);
  writeFileSync(join(dir, 'test-count-baseline.json'), baselineAtBase);
  git(['add', '.']);
  git(['commit', '-qm', 'base']);
  writeFileSync(join(dir, 'test-count-baseline.json'), baselineAtHead);
  git(['add', '.']);
  git(['commit', '-qm', 'head']);
  return dir;
}

const BASELINE = { 'apps/api/reports/vitest.json': 18, 'reports/vitest-hooks.json': 5 };

it('равные и выросшие числа — без предупреждений, рост подсказывает update', () => {
  const f = fixture();
  f.write(BASELINE, { 'apps/api/reports/vitest.json': 18, 'reports/vitest-hooks.json': 5 });
  const equal = runChecker(f.dir);
  expect(equal.status).toBe(0);
  expect(equal.output).toMatch(/ok/);
  expect(equal.output).not.toMatch(/WARNING/);

  f.write(BASELINE, { 'apps/api/reports/vitest.json': 21, 'reports/vitest-hooks.json': 5 });
  const grown = runChecker(f.dir);
  expect(grown.status).toBe(0);
  expect(grown.output).not.toMatch(/WARNING/);
  expect(grown.output).toMatch(/update/);
});

it('падение числа тестов — WARNING с именем файла и обоими числами, exit 0', () => {
  const f = fixture();
  f.write(BASELINE, { 'apps/api/reports/vitest.json': 15, 'reports/vitest-hooks.json': 5 });
  const result = runChecker(f.dir);
  expect(result.status).toBe(0);
  expect(result.output).toMatch(/WARNING/);
  expect(result.output).toContain('apps/api/reports/vitest.json');
  expect(result.output).toContain('18');
  expect(result.output).toContain('15');
});

it('отсутствующий отчёт (не затронут в --affected) молча пропускается', () => {
  const f = fixture();
  f.write(BASELINE, { 'apps/api/reports/vitest.json': 18, 'packages/ui/reports/vitest.json': 11 });
  const result = runChecker(f.dir);
  expect(result.status).toBe(0);
  expect(result.output).not.toMatch(/ui/);
});

it('понижение базлайна против merge-base — WARNING с именем файла', () => {
  const dir = gitFixture(
    JSON.stringify({ 'apps/api/reports/vitest.json': 18 }),
    JSON.stringify({ 'apps/api/reports/vitest.json': 10 }),
  );
  mkdirSync(join(dir, 'apps/api/reports'), { recursive: true });
  writeFileSync(join(dir, 'apps/api/reports/vitest.json'), vitestReport(10));
  // В fixture-репо нет origin/main — база задаётся явно.
  const result = runChecker(dir, ['--merge-base', 'HEAD~1']);
  expect(result.status).toBe(0);
  expect(result.output).toMatch(/WARNING/);
  expect(result.output).toMatch(/baseline.*lowered|lowered.*baseline|понижен/i);
  expect(result.output).toContain('test-count-baseline.json');
});

it('битый и отсутствующий базлайн — WARNING, не красный (гейт warning-only)', () => {
  const broken = fixture();
  broken.write('{nope', {});
  const brokenResult = runChecker(broken.dir);
  expect(brokenResult.status).toBe(0);
  expect(brokenResult.output).toMatch(/WARNING/);

  const missing = fixture();
  const missingResult = runChecker(missing.dir);
  expect(missingResult.status).toBe(0);
  expect(missingResult.output).toMatch(/WARNING/);
  expect(missingResult.output).toMatch(/update/);
});

it('--update поднимает числа и добавляет новые отчёты, понижать отказывается', () => {
  const f = fixture();
  f.write(
    { 'apps/api/reports/vitest.json': 18, 'reports/vitest-hooks.json': 5 },
    {
      'apps/api/reports/vitest.json': 21,
      'reports/vitest-hooks.json': 3,
      'packages/ui/reports/vitest.json': 11,
    },
  );
  const result = runChecker(f.dir, ['--update']);
  expect(result.status).toBe(0);
  const parsed: unknown = JSON.parse(readFileSync(join(f.dir, 'test-count-baseline.json'), 'utf8'));
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('baseline fixture lost its shape');
  }
  const entries = Object.entries(parsed);
  if (!entries.every(([, value]) => typeof value === 'number')) {
    throw new Error('baseline fixture lost its shape');
  }
  const baseline: Record<string, number> = Object.fromEntries(entries);
  // Рост подхвачен, новый отчёт добавлен, падение (5 → 3) не записано.
  expect(baseline['apps/api/reports/vitest.json']).toBe(21);
  expect(baseline['packages/ui/reports/vitest.json']).toBe(11);
  expect(baseline['reports/vitest-hooks.json']).toBe(5);
  expect(result.output).toMatch(/refus|not lowered|не понижа/i);
});

function runChecker(cwd: string, args: string[] = []): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [checker, '--cwd', cwd, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.error) {
    throw result.error;
  }
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}
