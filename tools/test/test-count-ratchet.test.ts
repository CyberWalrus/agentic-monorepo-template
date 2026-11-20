/**
 * Канарейка a10: update поднимает базлайн до факта и отказывается понижать;
 * nightly-джоб храповика на месте; правило «поднимает автоматика» в архитектуре.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const repoDir = resolve(import.meta.dirname, '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'a10-ratchet-'));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function runUpdate(): { status: number | null; stdout: string } {
  const baseline = join(tmp, 'test-count-baseline.json');
  const run = spawnSync(
    'node',
    [
      join(repoDir, 'tools', 'check-test-count.ts'),
      '--cwd',
      tmp,
      '--baseline',
      baseline,
      '--update',
    ],
    { encoding: 'utf8', timeout: 60_000 },
  );
  return { status: run.status, stdout: run.stdout };
}

function writeFixture(baselineCount: number): void {
  mkdirSync(join(tmp, 'apps', 'api', 'reports'), { recursive: true });
  writeFileSync(join(tmp, 'apps', 'api', 'reports', 'vitest.json'), '{"numTotalTests": 48}');
  writeFileSync(
    join(tmp, 'test-count-baseline.json'),
    `${JSON.stringify({ 'apps/api/reports/vitest.json': baselineCount }, null, 2)}\n`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function baselineValue(): unknown {
  const parsed: unknown = JSON.parse(readFileSync(join(tmp, 'test-count-baseline.json'), 'utf8'));
  return isRecord(parsed) ? parsed['apps/api/reports/vitest.json'] : undefined;
}

it('update поднимает базлайн до факта (дифф непуст — PR храповика формируется)', () => {
  writeFixture(43);
  const run = runUpdate();
  expect(run.status).toBe(0);
  expect(baselineValue()).toBe(48);
  expect(run.stdout).toContain('raised');
});

it('update отказывается понижать (дифф пуст, отказ в выводе)', () => {
  writeFixture(100);
  const run = runUpdate();
  expect(run.status).toBe(0);
  expect(baselineValue()).toBe(100);
  expect(run.stdout).toContain('refused to lower');
});

it('проводка: nightly-джоб храповика и правило в architecture.md (a10)', () => {
  const nightly = readFileSync(join(repoDir, '.github', 'workflows', 'nightly.yml'), 'utf8');
  expect(nightly).toContain('test count ratchet');
  expect(nightly).toContain('pnpm test:count:update');
  const architecture = readFileSync(join(repoDir, 'docs', 'architecture.md'), 'utf8');
  expect(architecture).toContain('Числовые храповики поднимает автоматика');
});
