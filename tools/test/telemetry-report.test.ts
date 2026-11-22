/**
 * Тесты телеметрии обвязки (c9.4): окна/дельты/квантили ядра, absent-vs-zero
 * и правило «сломано» по if:always-артефактам (ревью c9.4), скип evals без
 * секрета ≠ ноль, маркер агентного PR, парсер реестра escaped-defects (только
 * основная таблица — «Копия из шаблона» не считается), формула mutation score
 * (mutation-testing-metrics), propagate проблем и summary без текстов PR
 * (untrusted-входы). CLI-смок: --local в фикстурном git-репо пишет отчёт,
 * находит конфликт пары task-веток и честно красится на недоступных
 * источниках (З4/З11) — без сети и gh.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import * as z from 'zod';

import {
  buildTrendsReport,
  countEscapedDefects,
  isAgentPr,
  mutationScoreFromMutants,
  percentile,
  renderSummary,
  type TelemetryInputs,
} from '../telemetry-report.ts';

const cli = resolve(import.meta.dirname, '..', 'telemetry-report.main.ts');

const dirs: string[] = [];

const NOW = '2026-11-22T12:00:00.000Z';
// Окна: текущее [2026-10-23T12:00Z, NOW], предыдущее [2026-09-23T12:00Z, 2026-10-23T12:00Z).
const CUR = '2026-11-01T00:00:00Z';
const CUR2 = '2026-11-10T00:00:00Z';
const PREV = '2026-09-28T00:00:00Z';
const OLD = '2026-09-01T00:00:00Z';
// Полные ISO-даты для длительностей CI (started/updated).
const CUR_AT = '2026-11-01T10:00:00Z';
const PREV_AT = '2026-09-28T10:00:00Z';

const DEFECTS_MD = `# Реестр пропущенных дефектов

## Реестр

| Дата       | Что прошло | Как обнаружено | Контур | Чем закрыто | Гейт |
| ---------- | ---------- | -------------- | ------ | ----------- | ---- |
| 2026-11-01 | дефект A   | тест           | unit   | PR #1       | да   |
| 2026-10-01 | дефект B   | канарейка      | docs   | PR #2       | нет  |
| 2026-09-28 | дефект C   | e2e            | api    | PR #3       | да   |
| 2026-09-01 | дефект D   | человек        | ui     | PR #4       | нет  |

## Копия из шаблона

| Дата | Что прошло |
| ---- | ---------- |
| 2026-11-02 | копия 1 |
| 2026-11-03 | копия 2 |
`;

function baseInputs(overrides: Partial<TelemetryInputs> = {}): TelemetryInputs {
  return {
    nowIso: NOW,
    periodDays: 30,
    targets: {
      ciP50Min: 10,
      mergeQueueP50Min: 15,
      flakyPct: 1,
      verifyTotalSlowSec: 720,
      perfScenarioMaxMs: { 'scenario:create-task': 600, 'scenario:toggle-task': 400 },
      mutationBreak: 75,
    },
    conventionSinceIso: '2026-11-22',
    ciRuns: [],
    nightlyArtifactRuns: [],
    flakyPoints: [],
    verifyPoints: [],
    perfPoints: [],
    mutationPoints: [],
    denials: [],
    denialsSource: 'CI gate-integrity (артефакты gate-denials)',
    denialsCoverage: 'только CI-слой (ревью c9.4)',
    mergedPrs: [],
    evalsPoints: [],
    escapedDefectsMarkdown: DEFECTS_MD,
    taskConflicts: { branches: [], conflictingPairs: [] },
    problems: [],
    ...overrides,
  };
}

function ciRun(
  id: number,
  event: string,
  started: string,
  updated: string,
  conclusion = 'success',
): TelemetryInputs['ciRuns'][number] {
  return { id, event, conclusion, runStartedAt: started, updatedAt: updated };
}

function mkPerfReport(createMs: number): TelemetryInputs['perfPoints'][number]['report'] {
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
    'scenario:create-task': { ms: createMs, apiRequests: 10, longTasks: 0 },
    'scenario:toggle-task': { ms: 80, apiRequests: 10, longTasks: 0 },
  };
}

it('percentile: ближайший ранг по round(q×(n−1)), пустой ряд — null', () => {
  const sorted = [4, 7, 12];
  expect(percentile(sorted, 0.5)).toBe(7);
  expect(percentile(sorted, 0.95)).toBe(12);
  expect(percentile([], 0.5)).toBeNull();
});

it('mutation score: формула mutation-testing-metrics — detected/(detected+survived+noCoverage)', () => {
  // (8 killed + 1 timeout) / (8 + 1 + 1 survived) = 90.
  expect(
    mutationScoreFromMutants([
      'Killed',
      'Killed',
      'Killed',
      'Killed',
      'Killed',
      'Killed',
      'Killed',
      'Killed',
      'Timeout',
      'Survived',
    ]).score,
  ).toBe(90);
  // NoCoverage в знаменателе: 9/10 = 90.
  expect(mutationScoreFromMutants([...Array(9).fill('Killed'), 'NoCoverage']).score).toBe(90);
  // Ignored и CompileError не входят ни в числитель, ни в знаменатель: 5/5 = 100.
  expect(
    mutationScoreFromMutants([...Array(5).fill('Killed'), 'Ignored', 'CompileError', 'Pending'])
      .score,
  ).toBe(100);
  // Пустой домен — 100 (DEFAULT_SCORE официального пакета).
  expect(mutationScoreFromMutants([]).score).toBe(100);
});

it('escaped-defects: только таблица «## Реестр», «Копия из шаблона» не считается', () => {
  const defects = countEscapedDefects(DEFECTS_MD);
  expect(defects.total).toBe(4);
  expect(defects.dates).toEqual(['2026-11-01', '2026-10-01', '2026-09-28', '2026-09-01']);
  expect(() => countEscapedDefects('# нет секции реестра\n')).toThrow('## Реестр');
});

it('маркер агентного PR: только установленный чекбокс; регистр и пробелы терпимы', () => {
  expect(isAgentPr('Описание\n- [x] PR создан агентом\nЕщё текст')).toBe(true);
  expect(isAgentPr('- [X]  PR создан агентом')).toBe(true);
  expect(isAgentPr('- [ ] PR создан агентом')).toBe(false);
  expect(isAgentPr('- [x] PR создан агентом (без шаблона — не тот маркер)')).toBe(false);
  expect(isAgentPr('Ревьюеры-агенты сделали агентное ревью')).toBe(false);
});

it('время CI: p50/p95, skipped/cancelled не считают, merge queue без прогонов — «контур не работает»', () => {
  const report = buildTrendsReport(
    baseInputs({
      ciRuns: [
        ciRun(1, 'pull_request', '2026-11-01T10:00:00Z', '2026-11-01T10:12:00Z'), // 12 мин
        ciRun(2, 'pull_request', '2026-11-01T10:00:00Z', '2026-11-01T10:07:00Z'), // 7 мин
        ciRun(3, 'pull_request', '2026-11-01T10:00:00Z', '2026-11-01T10:04:00Z'), // 4 мин
        ciRun(4, 'pull_request', '2026-11-01T10:00:00Z', '2026-11-01T10:30:00Z', 'cancelled'),
        ciRun(5, 'merge_group', '2026-11-01T10:00:00Z', '2026-11-01T10:30:00Z', 'skipped'),
      ],
    }),
  );
  expect(report.metrics.ciTime.pr).toEqual({ runs: 3, p50Min: 7, p95Min: 12 });
  expect(report.metrics.ciTime.mergeQueue).toEqual({
    status: 'no-data',
    runs: 0,
    p50Min: null,
    p95Min: null,
  });
  expect(report.metrics.ciTime.targets).toEqual({ prP50Min: 10, mergeQueueP50Min: 15 });
});

it('время CI: дельта к предыдущему окну', () => {
  const report = buildTrendsReport(
    baseInputs({
      ciRuns: [
        ciRun(1, 'pull_request', CUR_AT, '2026-11-01T10:12:00Z'),
        ciRun(2, 'pull_request', PREV_AT, '2026-09-28T10:08:00Z'),
      ],
    }),
  );
  expect(report.metrics.ciTime.previousPr).toEqual({ runs: 1, p50Min: 8, p95Min: 8 });
  expect(report.metrics.ciTime.deltaPr).toEqual({ p50Min: 4, p95Min: 4 });
});

it('flaky rate: среднее по числам гейта, null-прогон в measured не входит', () => {
  const report = buildTrendsReport(
    baseInputs({
      flakyPoints: [
        { runId: 1, date: CUR, ratePct: 0.5, flaky: 1, total: 200 },
        { runId: 2, date: CUR2, ratePct: null, flaky: 0, total: 200 },
        { runId: 3, date: PREV, ratePct: 1.5, flaky: 3, total: 200 },
        { runId: 4, date: OLD, ratePct: 99, flaky: 99, total: 100 },
      ],
    }),
  );
  const flaky = report.metrics.flakyRate;
  expect(flaky.current).toEqual({ runs: 2, measured: 1, meanPct: 0.5 });
  expect(flaky.previous).toEqual({ runs: 1, measured: 1, meanPct: 1.5 });
  expect(flaky.deltaPp).toBe(-1);
  expect(flaky.targetPct).toBe(1);
});

it('бюджет verify: p50/p95 totalSec и порог из targets, enforce остаётся в гейте', () => {
  const report = buildTrendsReport(
    baseInputs({
      verifyPoints: [
        { runId: 1, date: CUR, totalSec: 400 },
        { runId: 2, date: CUR2, totalSec: 500 },
        { runId: 3, date: PREV, totalSec: 380 },
      ],
    }),
  );
  expect(report.metrics.verifyTime.current).toEqual({ runs: 2, p50Sec: 500, p95Sec: 500 });
  expect(report.metrics.verifyTime.previous).toEqual({ runs: 1, p50Sec: 380, p95Sec: 380 });
  expect(report.metrics.verifyTime.delta).toEqual({ p50Sec: 120, p95Sec: 120 });
  expect(report.metrics.verifyTime.budgetSec).toBe(720);
});

it('perf: медианы сценариев, отчёт null — no-data, а не «сломано» и не ноль', () => {
  const report = buildTrendsReport(
    baseInputs({
      perfPoints: [
        { runId: 1, date: CUR, report: mkPerfReport(110) },
        { runId: 2, date: CUR2, report: mkPerfReport(95) },
        { runId: 3, date: PREV, report: null },
      ],
    }),
  );
  const perf = report.metrics.perf;
  // runs — только прогоны текущего окна (2 из 3 точек; PREV — прошлое окно).
  expect(perf.runs).toBe(2);
  expect(perf.measured).toBe(2);
  const create = perf.scenarios.find((scenario) => scenario.key === 'scenario:create-task');
  expect(create).toEqual({
    key: 'scenario:create-task',
    budgetMs: 600,
    currentMedianMs: 110,
    previousMedianMs: null,
    deltaMs: null,
  });
});

it('mutation: снимок последнего прогона окна и дельта к прошлому окну', () => {
  const report = buildTrendsReport(
    baseInputs({
      mutationPoints: [
        { runId: 1, date: CUR, score: 91 },
        { runId: 2, date: CUR2, score: 92 },
        { runId: 3, date: PREV, score: 88 },
      ],
    }),
  );
  expect(report.metrics.mutationScore.current).toEqual({ score: 92, date: CUR2, runId: 2 });
  expect(report.metrics.mutationScore.previous).toEqual({ score: 88, date: PREV, runId: 3 });
  expect(report.metrics.mutationScore.deltaPp).toBe(4);
  expect(report.metrics.mutationScore.breakThreshold).toBe(75);
});

it('absent-vs-zero: свежайший прогон без if:always-артефакта при наличии у ранних — «сломано»', () => {
  const report = buildTrendsReport(
    baseInputs({
      nightlyArtifactRuns: [
        { runId: 1, date: CUR, flakyRate: true, verifyDurations: true, mutationFull: true },
        { runId: 2, date: CUR2, flakyRate: false, verifyDurations: false, mutationFull: false },
        { runId: 3, date: OLD, flakyRate: false, verifyDurations: false, mutationFull: false },
      ],
    }),
  );
  expect(report.problems).toHaveLength(3);
  for (const problem of report.problems) {
    expect(problem).toContain('не отдал артефакт');
    expect(problem).toContain('сломан');
  }
});

it('absent-vs-zero: все if:always-артефакты на месте — проблем нет; прогон вне окна не мешает', () => {
  const report = buildTrendsReport(
    baseInputs({
      nightlyArtifactRuns: [
        { runId: 1, date: CUR, flakyRate: true, verifyDurations: false, mutationFull: false },
        { runId: 2, date: CUR2, flakyRate: true, verifyDurations: false, mutationFull: false },
        { runId: 3, date: OLD, flakyRate: false, verifyDurations: false, mutationFull: false },
      ],
    }),
  );
  expect(report.problems).toHaveLength(0);
});

it('denials: счётчик по гейтам отсортирован, дельта окон; ноль без записей — не проблема', () => {
  const report = buildTrendsReport(
    baseInputs({
      denials: [
        { date: CUR, gate: 'guard-bash', reason: 'baseline-update' },
        { date: CUR, gate: 'protect-paths', reason: 'protected-path-write' },
        { date: CUR, gate: 'guard-bash', reason: 'force-push' },
        { date: PREV, gate: 'protect-paths', reason: 'protected-path-write' },
      ],
    }),
  );
  const denials = report.metrics.gateDenials;
  expect(denials.current.total).toBe(3);
  expect(denials.current.byGate).toEqual({ 'guard-bash': 2, 'protect-paths': 1 });
  expect(denials.previous.total).toBe(1);
  expect(denials.delta).toBe(2);
  expect(denials.source).toContain('gate-integrity');
});

it('агентные PR: доля по чекбоксу, тела в отчёт не попадают, пустое окно — share null', () => {
  const report = buildTrendsReport(
    baseInputs({
      mergedPrs: [
        { number: 1, body: '- [x] PR создан агентом\nЧто-то СЕКРЕТНОЕ-ТЕЛО-PR', mergedAt: CUR },
        { number: 2, body: 'обычный PR человека', mergedAt: CUR },
        { number: 3, body: 'обычный PR человека', mergedAt: CUR },
        { number: 4, body: '- [x] PR создан агентом', mergedAt: PREV },
      ],
    }),
  );
  const agent = report.metrics.agentPrs;
  expect(agent.current).toEqual({ merged: 3, marked: 1, sharePct: 33.33 });
  expect(agent.previous).toEqual({ merged: 1, marked: 1, sharePct: 100 });
  expect(agent.deltaPp).toBe(-66.67);
  expect(agent.notCollected).toContain('без ручных правок');
  const empty = buildTrendsReport(baseInputs());
  expect(empty.metrics.agentPrs.current.sharePct).toBeNull();
  expect(empty.metrics.agentPrs.status).toBe('no-data');
});

it('escaped-defects: окна считаются по датам реестра; копия шаблона не задваивает', () => {
  const report = buildTrendsReport(baseInputs());
  expect(report.metrics.escapedDefects.current).toEqual({ inWindow: 1, total: 4 });
  expect(report.metrics.escapedDefects.previous).toEqual({ inWindow: 2 });
});

it('evals: только скипнутые прогоны — «не собирается: нет секрета», не ноль и не проблема', () => {
  const report = buildTrendsReport(
    baseInputs({
      evalsPoints: [
        {
          runId: 1,
          date: CUR,
          conclusion: 'skipped',
          scenarios: null,
          passed: null,
          timeMs: null,
          tokens: null,
        },
      ],
    }),
  );
  const evals = report.metrics.evals;
  expect(evals.status).toBe('no-data');
  expect(evals.note).toContain('секрета');
  expect(evals.current.scenarios).toBe(0);
});

it('evals: смешанное окно — pass rate по измеренным прогонам, дельта по окнам', () => {
  const report = buildTrendsReport(
    baseInputs({
      evalsPoints: [
        {
          runId: 1,
          date: CUR,
          conclusion: 'success',
          scenarios: 2,
          passed: 1,
          timeMs: 300,
          tokens: 1000,
        },
        {
          runId: 2,
          date: CUR2,
          conclusion: 'skipped',
          scenarios: null,
          passed: null,
          timeMs: null,
          tokens: null,
        },
        {
          runId: 3,
          date: PREV,
          conclusion: 'success',
          scenarios: 2,
          passed: 2,
          timeMs: 200,
          tokens: 800,
        },
      ],
    }),
  );
  const evals = report.metrics.evals;
  expect(evals.status).toBe('ok');
  expect(evals.current.passRatePct).toBe(50);
  expect(evals.current.runsSkippedNoSecret).toBe(1);
  expect(evals.previous.passRatePct).toBe(100);
  expect(evals.deltaPp).toBe(-50);
});

it('конфликты задач доски: снимок пар с конфликтом', () => {
  const report = buildTrendsReport(
    baseInputs({
      taskConflicts: {
        branches: ['origin/task/a', 'origin/task/b', 'origin/task/c'],
        conflictingPairs: [['origin/task/a', 'origin/task/b']],
      },
    }),
  );
  expect(report.metrics.taskMergeConflicts.pairs).toBe(3);
  expect(report.metrics.taskMergeConflicts.conflictingPairs).toEqual([
    'origin/task/a..origin/task/b',
  ]);
});

it('проблемы main пробрасываются в отчёт; renderSummary не содержит тел PR (untrusted)', () => {
  const report = buildTrendsReport(
    baseInputs({
      problems: ['искусственная проблема источника'],
      mergedPrs: [{ number: 1, body: 'СЕКРЕТНОЕ-ТЕЛО-PR-ИНЪЕКЦИЯ', mergedAt: CUR }],
    }),
  );
  expect(report.problems).toEqual(['искусственная проблема источника']);
  const summary = renderSummary(report);
  expect(summary).toContain('Тренды обвязки');
  expect(summary).toContain('Что не собирается');
  expect(summary).not.toContain('СЕКРЕТНОЕ-ТЕЛО-PR-ИНЪЕКЦИЯ');
});

it('CLI-смок (--local, фикстурный git-репо): отчёт написан, конфликт пары task-веток найден, недоступные источники честно красят (З4/З11)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'telemetry-cli-'));
  dirs.push(dir);
  const git = (args: string[]): string => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} упал: ${result.stderr}`);
    return result.stdout;
  };
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs/escaped-defects.md'), DEFECTS_MD);
  // Открытые задачи доски: пары конфликтов считаются только для них.
  mkdirSync(join(dir, 'backlog'), { recursive: true });
  writeFileSync(
    join(dir, 'backlog/a.md'),
    '---\ntitle: A\ntype: change\npriority: low\ndepends_on:\ntouches: docs/**\nneeds_human:\n---\n\n# A\n',
  );
  writeFileSync(
    join(dir, 'backlog/b.md'),
    '---\ntitle: B\ntype: change\npriority: low\ndepends_on:\ntouches: docs/**\nneeds_human:\n---\n\n# B\n',
  );
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@example.invalid']);
  git(['config', 'user.name', 't']);
  writeFileSync(join(dir, 'common.txt'), 'base\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'base']);
  git(['checkout', '-qb', 'task/a']);
  writeFileSync(join(dir, 'common.txt'), 'from-a\n');
  git(['commit', '-qam', 'a']);
  git(['checkout', '-qb', 'task/b', 'main']);
  writeFileSync(join(dir, 'common.txt'), 'from-b\n');
  git(['commit', '-qam', 'b']);
  const shaA = git(['rev-parse', 'task/a']).trim();
  const shaB = git(['rev-parse', 'task/b']).trim();
  mkdirSync(join(dir, '.git/refs/remotes/origin/task'), { recursive: true });
  git(['update-ref', 'refs/remotes/origin/task/a', shaA]);
  git(['update-ref', 'refs/remotes/origin/task/b', shaB]);

  const out = join(dir, 'reports', 'trends.json');
  const result = spawnSync(
    process.execPath,
    [cli, '--local', '--period-days', '30', '--out', out],
    {
      cwd: dir,
      encoding: 'utf8',
    },
  );
  // В фикстуре нет origin/verify-budgets.json — проблема честная, CLI красный.
  expect(result.status).toBe(1);
  const SmokeReportSchema = z.object({
    schema: z.literal('trends-report/1'),
    problems: z.array(z.string()),
    metrics: z.object({
      taskMergeConflicts: z.object({
        conflictingPairs: z.array(z.string()),
        pairs: z.number(),
      }),
      verifyTime: z.object({ status: z.enum(['ok', 'no-data']) }),
    }),
  });
  const report = SmokeReportSchema.parse(JSON.parse(readFileSync(out, 'utf8')));
  expect(report.schema).toBe('trends-report/1');
  expect(report.metrics.taskMergeConflicts.pairs).toBe(1);
  expect(report.metrics.taskMergeConflicts.conflictingPairs).toEqual([
    'origin/task/a..origin/task/b',
  ]);
  expect(report.metrics.verifyTime.status).toBe('no-data');
  expect(report.problems.length).toBeGreaterThan(0);
});

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});
