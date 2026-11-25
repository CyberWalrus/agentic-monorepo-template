/**
 * Тесты доверенного чекера дельта-гейта бандла (A6 PR-2, ADR 0013): успешный
 * замер — PASS; красный замер без label / с невалидным одобрением — FAIL
 * (fail-closed); нет check-run, не завершён, отменён — FAIL; на одном head SHA
 * берётся последний завершённый по completed_at; замер, сделанный до последней
 * смены base-ветки PR, — FAIL (e78).
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
  /** Узлы timelineItems(itemTypes: [BASE_REF_CHANGED_EVENT], last: 1); по умолчанию смен base не было. */
  baseChange?: unknown;
  /** check suite каждого check-run bundle-delta: [{ id, created_at }]. */
  suites?: unknown;
}

function run(fixture: Fixture): { status: number | null; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-gate-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'check-runs.json'), JSON.stringify(fixture.checkRuns));
  writeFileSync(
    join(dir, 'pr.json'),
    JSON.stringify({ labels: fixture.labels.map((name) => ({ name })), pushedAt: PUSH_AT }),
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
  writeFileSync(join(dir, 'base-change.json'), JSON.stringify(fixture.baseChange ?? []));
  writeFileSync(join(dir, 'suites.json'), JSON.stringify(fixture.suites ?? []));
  const owners = fixture.codeowners ?? OWNERS;
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'docs/CODEOWNERS'), owners);
  const result = spawnSync(
    process.execPath,
    [
      checker,
      'check-runs.json',
      'pr.json',
      'events.json',
      'head-commit.json',
      'base-change.json',
      'suites.json',
      ...CANDIDATES,
    ],
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

it('несколько завершённых check-run на одном head (перезапуск, reopen): берётся последний по completed_at', () => {
  const result = run({
    checkRuns: {
      check_runs: [failureRun('2026-11-17T01:00:00Z'), successRun('2026-11-17T02:00:00Z')],
    },
    labels: [],
  });
  expect(result.status).toBe(0);
  expect(result.output).toMatch(/PASS/);
});

it('инверсный: старее success, новее failure без label — FAIL', () => {
  const result = run({
    checkRuns: {
      check_runs: [successRun('2026-11-17T01:00:00Z'), failureRun('2026-11-17T02:00:00Z')],
    },
    labels: [],
  });
  expect(result.status).toBe(1);
  expect(result.output).toMatch(/FAIL/);
  expect(result.output).toMatch(/не стоит/);
});

// e78: ci.yml больше не слушает edited, а ci-base-change.yml диспатчит ci.yml с
// семантикой workflow_dispatch — без merge-ref и bundle-delta. После retarget на
// head SHA остаётся замер против прежней базы; bundle-approval обязан его
// заблокировать, иначе PR с ростом на новой базе проходит без label. Замер
// связан с временем создания через check suite run'а.
const SUITE = 7;
const inSuite = (checkRun: {
  name: string;
  status: string;
  conclusion: string;
  completed_at: string;
}) => ({ ...checkRun, check_suite: { id: SUITE } });
const measuredAt = (createdAt: string) => [{ id: SUITE, created_at: createdAt }];
const baseChangedAt = (createdAt: string) => [
  { createdAt, previousRefName: 'task/other', currentRefName: 'main' },
];
const RETARGETED_AT = '2026-11-17T03:00:00Z';

it('замер до смены base — FAIL (retarget не пересматривает bundle-delta, e78)', () => {
  const result = run({
    checkRuns: { check_runs: [inSuite(successRun('2026-11-17T02:00:00Z'))] },
    suites: measuredAt('2026-11-17T01:00:00Z'),
    baseChange: baseChangedAt(RETARGETED_AT),
    labels: [],
  });
  expect(result.status).toBe(1);
  expect(result.output).toMatch(/FAIL/);
  expect(result.output).toMatch(/прежней базе/);
  expect(result.output).toMatch(/task\/other → main/);
  expect(result.output).toMatch(/Update branch/);
});

it('замер после смены base (close → reopen на том же head) — PASS', () => {
  const result = run({
    checkRuns: { check_runs: [inSuite(successRun('2026-11-17T05:00:00Z'))] },
    suites: measuredAt('2026-11-17T04:00:00Z'),
    baseChange: baseChangedAt(RETARGETED_AT),
    labels: [],
  });
  expect(result.status).toBe(0);
  expect(result.output).toMatch(/PASS/);
});

it('замер и смена base в одну секунду — FAIL: порядок не известен', () => {
  const result = run({
    checkRuns: { check_runs: [inSuite(successRun('2026-11-17T05:00:00Z'))] },
    suites: measuredAt(RETARGETED_AT),
    baseChange: baseChangedAt(RETARGETED_AT),
    labels: [],
  });
  expect(result.status).toBe(1);
  expect(result.output).toMatch(/прежней базе/);
});

it('замер до смены base + свежий label — FAIL: одобрение прежней базы не переносится', () => {
  const result = run({
    checkRuns: { check_runs: [inSuite(failureRun('2026-11-17T02:00:00Z'))] },
    suites: measuredAt('2026-11-17T01:00:00Z'),
    baseChange: baseChangedAt(RETARGETED_AT),
    labels: ['bundle-growth-approved'],
  });
  expect(result.status).toBe(1);
  expect(result.output).toMatch(/прежней базе/);
});

it('смена base есть, время замера неизвестно (suite не найден) — FAIL (fail-closed)', () => {
  const result = run({
    checkRuns: { check_runs: [successRun('2026-11-17T05:00:00Z')] },
    suites: measuredAt('2026-11-17T04:00:00Z'),
    baseChange: baseChangedAt(RETARGETED_AT),
    labels: [],
  });
  expect(result.status).toBe(1);
  expect(result.output).toMatch(/время создания замера .* неизвестно/);
});

it('смена base есть, время смены не читается — FAIL (fail-closed)', () => {
  const result = run({
    checkRuns: { check_runs: [inSuite(successRun('2026-11-17T05:00:00Z'))] },
    suites: measuredAt('2026-11-17T04:00:00Z'),
    baseChange: [{ createdAt: 'не дата', previousRefName: 'task/other', currentRefName: 'main' }],
    labels: [],
  });
  expect(result.status).toBe(1);
  expect(result.output).toMatch(/время смены не читается/);
});

it('timed_out conclusion — FAIL (fail-closed)', () => {
  const result = run({
    checkRuns: {
      check_runs: [
        {
          name: 'bundle-delta',
          status: 'completed',
          conclusion: 'timed_out',
          completed_at: '2026-11-17T01:00:00Z',
        },
      ],
    },
    labels: [],
  });
  expect(result.status).toBe(1);
  expect(result.output).toMatch(/timed_out/);
});

it('pushedAt из pr.json главнее committer.date: label старше реального push — FAIL', () => {
  // committer.date автор подделывает (GIT_COMMITTER_DATE): подставлена дата ДО
  // label, чтобы старая проверка свежести прошла. pushedAt в pr.json ставит
  // GitHub и показывает, что push был ПОСЛЕ label — одобрение недействительно.
  const dir = mkdtempSync(join(tmpdir(), 'bundle-gate-'));
  dirs.push(dir);
  writeFileSync(
    join(dir, 'check-runs.json'),
    JSON.stringify({ check_runs: [failureRun('2026-11-17T01:00:00Z')] }),
  );
  writeFileSync(
    join(dir, 'pr.json'),
    JSON.stringify({
      labels: [{ name: 'bundle-growth-approved' }],
      pushedAt: '2026-11-17T03:00:00Z',
    }),
  );
  writeFileSync(
    join(dir, 'events.json'),
    JSON.stringify([
      {
        event: 'labeled',
        actor: { login: 'template-owner' },
        created_at: '2026-11-17T02:00:00Z',
        label: { name: 'bundle-growth-approved' },
      },
    ]),
  );
  // committer.date подделан «до label» — против старой механики прошло бы.
  writeFileSync(
    join(dir, 'head-commit.json'),
    JSON.stringify({ commit: { committer: { date: '2026-11-15T00:00:00Z' } } }),
  );
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'docs/CODEOWNERS'), OWNERS);
  writeFileSync(join(dir, 'base-change.json'), '[]');
  writeFileSync(join(dir, 'suites.json'), '[]');
  const result = spawnSync(
    process.execPath,
    [
      checker,
      'check-runs.json',
      'pr.json',
      'events.json',
      'head-commit.json',
      'base-change.json',
      'suites.json',
      ...CANDIDATES,
    ],
    { cwd: dir, encoding: 'utf8', timeout: 30_000 },
  );
  if (result.error) {
    throw result.error;
  }
  const output = `${result.stdout}${result.stderr}`;
  expect(result.status).toBe(1);
  expect(output).toMatch(/до последнего push/);
  expect(output).toMatch(/2026-11-17T03:00:00Z/);
});
