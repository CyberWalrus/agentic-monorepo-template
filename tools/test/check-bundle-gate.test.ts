/**
 * Тесты доверенного чекера дельта-гейта бандла (A6 PR-2, ADR 0013): успешный
 * замер — PASS; красный замер без label / с невалидным одобрением — FAIL
 * (fail-closed); нет check-run, не завершён, отменён — FAIL; при retarget
 * берётся последний завершённый по completed_at.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const repoDir = resolve(import.meta.dirname, '..', '..');
const checker = join(repoDir, 'tools', 'check-bundle-gate.ts');

const PUSH_AT = '2026-11-16T00:00:00Z';
const LABELED_AT = '2026-11-17T00:00:00Z';
const CANDIDATES = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];
const OWNERS = '* @template-owner\n';

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Fixture {
  checkRuns: unknown;
  labels: string[];
  labeledActor?: string;
  labeledAt?: string;
  codeowners?: string;
}

function run(fixture: Fixture): { status: number | null; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-gate-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'check-runs.json'), JSON.stringify(fixture.checkRuns));
  writeFileSync(
    join(dir, 'pr.json'),
    JSON.stringify({ labels: fixture.labels.map((name) => ({ name })) }),
  );
  writeFileSync(
    join(dir, 'events.json'),
    JSON.stringify([
      {
        event: 'labeled',
        actor: { login: fixture.labeledActor ?? 'template-owner' },
        created_at: fixture.labeledAt ?? LABELED_AT,
        label: { name: 'bundle-growth-approved' },
      },
    ]),
  );
  writeFileSync(
    join(dir, 'head-commit.json'),
    JSON.stringify({ commit: { committer: { date: PUSH_AT } } }),
  );
  const owners = fixture.codeowners ?? OWNERS;
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'docs/CODEOWNERS'), owners);
  const result = spawnSync(
    process.execPath,
    [checker, 'check-runs.json', 'pr.json', 'events.json', 'head-commit.json', ...CANDIDATES],
    { cwd: dir, encoding: 'utf8', timeout: 30_000 },
  );
  if (result.error) {
    throw result.error;
  }
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const successRun = (completedAt: string) => ({
  name: 'bundle-delta',
  status: 'completed',
  conclusion: 'success',
  completed_at: completedAt,
});
const failureRun = (completedAt: string) => ({
  name: 'bundle-delta',
  status: 'completed',
  conclusion: 'failure',
  completed_at: completedAt,
});

it('успешный bundle-delta — PASS без всякого label', () => {
  const result = run({
    checkRuns: { check_runs: [successRun('2026-11-17T01:00:00Z')] },
    labels: [],
  });
  expect(result.status).toBe(0);
  expect(result.output).toMatch(/bundle-gate: PASS/);
});

it('красный bundle-delta + свежий label от владельца — PASS по одобрению', () => {
  const result = run({
    checkRuns: { check_runs: [failureRun('2026-11-17T01:00:00Z')] },
    labels: ['bundle-growth-approved'],
  });
  expect(result.status).toBe(0);
  expect(result.output).toMatch(/bundle-gate: PASS/);
  expect(result.output).toMatch(/рост бандла одобрен/);
});

it('красный bundle-delta без label — FAIL', () => {
  const result = run({
    checkRuns: { check_runs: [failureRun('2026-11-17T01:00:00Z')] },
    labels: [],
  });
  expect(result.status).toBe(1);
  expect(result.output).toMatch(/bundle-gate: FAIL/);
  expect(result.output).toMatch(/label bundle-growth-approved не стоит/);
});

it('label поставил не владелец — FAIL', () => {
  const result = run({
    checkRuns: { check_runs: [failureRun('2026-11-17T01:00:00Z')] },
    labels: ['bundle-growth-approved'],
    labeledActor: 'not-an-owner',
  });
  expect(result.status).toBe(1);
  expect(result.output).toMatch(/не входит в глобальных владельцев/);
});

it('label поставлен до последнего push — FAIL (свежесть)', () => {
  const result = run({
    checkRuns: { check_runs: [failureRun('2026-11-17T01:00:00Z')] },
    labels: ['bundle-growth-approved'],
    labeledAt: '2026-11-15T00:00:00Z',
  });
  expect(result.status).toBe(1);
  expect(result.output).toMatch(/до последнего push/);
});

it('check-run не найден — FAIL (fail-closed)', () => {
  const result = run({ checkRuns: { check_runs: [] }, labels: [] });
  expect(result.status).toBe(1);
  expect(result.output).toMatch(/не найден/);
});

it('check-run не завершён — FAIL (fail-closed)', () => {
  const result = run({
    checkRuns: {
      check_runs: [
        { name: 'bundle-delta', status: 'in_progress', conclusion: null, completed_at: null },
      ],
    },
    labels: [],
  });
  expect(result.status).toBe(1);
  expect(result.output).toMatch(/не завершён/);
});

it('cancelled conclusion — FAIL (fail-closed)', () => {
  const result = run({
    checkRuns: {
      check_runs: [
        {
          name: 'bundle-delta',
          status: 'completed',
          conclusion: 'cancelled',
          completed_at: '2026-11-17T01:00:00Z',
        },
      ],
    },
    labels: [],
  });
  expect(result.status).toBe(1);
  expect(result.output).toMatch(/cancelled/);
});

it('retarget: берётся последний завершённый по completed_at', () => {
  const result = run({
    checkRuns: {
      check_runs: [failureRun('2026-11-17T01:00:00Z'), successRun('2026-11-17T02:00:00Z')],
    },
    labels: [],
  });
  expect(result.status).toBe(0);
  expect(result.output).toMatch(/PASS/);
});
