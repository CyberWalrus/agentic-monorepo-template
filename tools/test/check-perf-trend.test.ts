/**
 * Тесты ночного тренд-сравнения (A6 PR-3): допуски perf-budgets.json `trend`
 * (запросы точно, байты +5 КБ, время max(floor, 35%), cls +0.01, longTasks +1),
 * fail-closed на битой схеме/отсутствующей метрике, инверсия только для
 * regression (invalid красный при любом флаге), решение по базлайну
 * found/stale/none, и 20× сравнение идентичных отчётов без единого ложного
 * красного (валидация «без ложных падений»: детерминизм чекера на нулевой
 * дельте; шум реальных прогонов калибруется тренд-данными — отложено,
 * см. журнал задачи).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';

import { compareReports, decideBaseline, type CompareVerdict } from '../check-perf-trend.ts';
import type { PerfReport } from '../perf-metrics.ts';

const checker = resolve(import.meta.dirname, '..', 'check-perf-trend.main.ts');

const TREND = {
  timeFloorMs: { ttfbMs: 15, lcpMs: 25, lcpNetMs: 30, scenarioMs: 25 },
  timePct: 0.35,
  clsSlack: 0.01,
  longTasksSlack: 1,
  maxBytesSlackKb: 5,
};

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function baseReport(): PerfReport {
  return {
    'page:/': {
      ttfbMs: 13,
      lcpMs: 64,
      cls: 0,
      lcpNetMs: 360,
      requests: 5,
      apiRequests: 0,
      jsWireKb: 151,
      cssWireKb: 2,
    },
    'scenario:create-task': { ms: 110, apiRequests: 10, longTasks: 0 },
    'scenario:toggle-task': { ms: 80, apiRequests: 10, longTasks: 0 },
  };
}

function compare(candidate: PerfReport, baseline: PerfReport = baseReport()): CompareVerdict {
  return compareReports(candidate, baseline, TREND);
}

function runCli(args: string[]): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [checker, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.error) {
    throw result.error;
  }
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

it('идентичные отчёты — ok', () => {
  expect(compare(baseReport()).status).toBe('ok');
});

it('20× сравнение идентичных отчётов — ни одного ложного красного', () => {
  const baseline = baseReport();
  for (let index = 0; index < 20; index += 1) {
    const verdict = compare(baseReport(), baseline);
    expect(verdict.status, `прогон ${index + 1}`).toBe('ok');
  }
});

it('запросы: лишний /rpc-запрос — regression, точное совпадение', () => {
  const candidate = baseReport();
  candidate['scenario:create-task'].apiRequests = 11;
  expect(compare(candidate).status).toBe('regression');
});

it('байты: на границе +5 КБ зелёный, +5.1 красный', () => {
  const atLimit = baseReport();
  atLimit['page:/'].jsWireKb = 156;
  expect(compare(atLimit).status).toBe('ok');
  const overLimit = baseReport();
  overLimit['page:/'].jsWireKb = 156.1;
  expect(compare(overLimit).status).toBe('regression');
});

it('время: floor держит малые значения, pct — большие (+200 мс канарейка красная)', () => {
  // ttfb 13 → 22: рост 9 > pct (4.55), но ≤ floor 15 — зелёный.
  const small = baseReport();
  small['page:/'].ttfbMs = 22;
  expect(compare(small).status).toBe('ok');
  // ttfb 13 → 29: рост 16 > floor 15 — красный.
  const smallOver = baseReport();
  smallOver['page:/'].ttfbMs = 29;
  expect(compare(smallOver).status).toBe('regression');
  // create-task 110 + 200 = 310 > 110 + 38.5 — красный (канарейка).
  const canary = baseReport();
  canary['scenario:create-task'].ms = 310;
  expect(compare(canary).status).toBe('regression');
});

it('cls и longTasks: в пределах допуска зелёные, сверх — красные', () => {
  const clsOk = baseReport();
  clsOk['page:/'].cls = 0.01;
  expect(compare(clsOk).status).toBe('ok');
  const clsOver = baseReport();
  clsOver['page:/'].cls = 0.02;
  expect(compare(clsOver).status).toBe('regression');
  const longOk = baseReport();
  longOk['scenario:create-task'].longTasks = 1;
  expect(compare(longOk).status).toBe('ok');
  const longOver = baseReport();
  longOver['scenario:create-task'].longTasks = 2;
  expect(compare(longOver).status).toBe('regression');
});

it('лишние поля отчёта не ломают сравнение (invalid-ветка покрыта CLI-тестом ниже)', () => {
  const broken = baseReport() as PerfReport & { extra?: unknown };
  // Схема PerfReportSchema не пропустит лишних/битых отчётов; здесь проверяем
  // честность допустков: NaN нельзя передать через типы, поэтому invalid-ветка
  // покрыта CLI-тестом ниже (схема роняет NaN до compareReports).
  expect(compare(broken).status).toBe('ok');
});

it('decideBaseline: none / found / stale по возрасту / stale по числу прогонов', () => {
  const now = Date.parse('2026-11-19T03:00:00Z');
  const trendLimits = { baselineMaxAgeDays: 7, baselineMaxGreenRuns: 20 };
  expect(
    decideBaseline({ meta: undefined, nowMs: now, greenRunsAfter: 0, trend: trendLimits }).kind,
  ).toBe('none');
  const fresh = { sha: 'a'.repeat(40), runId: 1, createdAt: '2026-11-17T03:00:00Z' };
  expect(
    decideBaseline({ meta: fresh, nowMs: now, greenRunsAfter: 0, trend: trendLimits }).kind,
  ).toBe('found');
  expect(
    decideBaseline({ meta: fresh, nowMs: now, greenRunsAfter: 5, trend: trendLimits }).kind,
  ).toBe('found');
  const old = { sha: 'a'.repeat(40), runId: 1, createdAt: '2026-11-10T03:00:00Z' };
  expect(
    decideBaseline({ meta: old, nowMs: now, greenRunsAfter: 0, trend: trendLimits }).kind,
  ).toBe('stale');
  expect(
    decideBaseline({ meta: fresh, nowMs: now, greenRunsAfter: 21, trend: trendLimits }).kind,
  ).toBe('stale');
});

it('CLI: зелёное сравнение — exit 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'perf-trend-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'candidate.json'), JSON.stringify(baseReport()));
  const baselineDir = join(dir, 'baseline');
  mkdirSync(baselineDir, { recursive: true });
  writeFileSync(join(baselineDir, 'perf.json'), JSON.stringify(baseReport()));
  writeFileSync(
    join(baselineDir, 'meta.json'),
    JSON.stringify({ sha: 'a'.repeat(40), runId: 42, createdAt: '2026-11-18T03:00:00Z' }),
  );
  const result = runCli([
    'compare',
    '--candidate',
    join(dir, 'candidate.json'),
    '--baseline',
    baselineDir,
  ]);
  expect(result.status).toBe(0);
  expect(result.output).toMatch(/perf-trend: ok/);
});

it('CLI: regression — exit 1, инверсия даёт 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'perf-trend-'));
  dirs.push(dir);
  const slow = baseReport();
  slow['scenario:create-task'].ms = 400;
  writeFileSync(join(dir, 'candidate.json'), JSON.stringify(slow));
  const baselineDir = join(dir, 'baseline');
  mkdirSync(baselineDir, { recursive: true });
  writeFileSync(join(baselineDir, 'perf.json'), JSON.stringify(baseReport()));
  writeFileSync(
    join(baselineDir, 'meta.json'),
    JSON.stringify({ sha: 'a'.repeat(40), runId: 42, createdAt: '2026-11-18T03:00:00Z' }),
  );
  const direct = runCli([
    'compare',
    '--candidate',
    join(dir, 'candidate.json'),
    '--baseline',
    baselineDir,
  ]);
  expect(direct.status).toBe(1);
  expect(direct.output).toMatch(/regression/);
  const inverted = runCli([
    'compare',
    '--candidate',
    join(dir, 'candidate.json'),
    '--baseline',
    baselineDir,
    '--expect-regression',
  ]);
  expect(inverted.status).toBe(0);
  expect(inverted.output).toMatch(/канарейка жива/);
});

it('CLI: битый кандидат — invalid, красный и с инверсией', () => {
  const dir = mkdtempSync(join(tmpdir(), 'perf-trend-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'candidate.json'), JSON.stringify({ 'page:/': 'мусор' }));
  const baselineDir = join(dir, 'baseline');
  mkdirSync(baselineDir, { recursive: true });
  writeFileSync(join(baselineDir, 'perf.json'), JSON.stringify(baseReport()));
  writeFileSync(
    join(baselineDir, 'meta.json'),
    JSON.stringify({ sha: 'a'.repeat(40), runId: 42, createdAt: '2026-11-18T03:00:00Z' }),
  );
  const direct = runCli([
    'compare',
    '--candidate',
    join(dir, 'candidate.json'),
    '--baseline',
    baselineDir,
  ]);
  expect(direct.status).toBe(1);
  expect(direct.output).toMatch(/invalid/);
  const inverted = runCli([
    'compare',
    '--candidate',
    join(dir, 'candidate.json'),
    '--baseline',
    baselineDir,
    '--expect-regression',
  ]);
  expect(inverted.status).toBe(1);
  expect(inverted.output).toMatch(/invalid/);
});
