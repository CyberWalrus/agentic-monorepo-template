/**
 * Телеметрия обвязки (c9.4): единый отчёт трендов из уже существующих
 * источников. Ядро без IO и CLI — импортируется тестами (шов
 * check-perf-trend(.main).ts): main-файл собирает данные через gh/git,
 * здесь чистая агрегация, окна, дельты и цели vision.
 *
 * Принципы (план-ревью c9.4):
 * - критерий приёмки: отчёт содержит все метрики vision, по которым данные
 *   уже собираются; у каждой метрики поле coverage — что измеряется и что
 *   честно не собирается («не собирается, чем закрыть»);
 * - absent-vs-zero: отсутствие артефакта — «нет данных», не ноль; ноль —
 *   только из фактического файла (denials: нет артефакта у зелёного прогона
 *   gate-integrity = 0 отказов CI-слоя);
 * - «сломано» — если свежайший ночной прогон окна не отдал артефакт, который
 *   после этого PR пишется всегда (flaky-rate, verify-durations,
 *   mutation-full), при том что в окне есть прогон с артефактом: problem в
 *   отчёт, CLI выходит 1 (З4/З11) — issue создаёт job report; артефакт
 *   perf-trend пишется только при успехе perf/baseline — его отсутствие
 *   «нет данных», не «сломано»;
 * - evals: прогоны с conclusion=skipped (нет секрета ANTHROPIC_API_KEY) —
 *   нейтральное «не собирается», не ноль и не проблема; null-метрики отчёта
 *   evals не схлопываются в ноль (tools/evals/report.ts);
 * - ненадёжные входы валидируются в main до ядра (Zod); в step-summary не
 *   попадают тексты PR и issue — только числа, id и статусы.
 */
import * as z from 'zod';

import { PerfReportSchema, type PerfReport } from './perf-metrics.ts';

export const WorkflowRunSchema = z.object({
  id: z.number().int().positive(),
  event: z.string(),
  conclusion: z.string(),
  runStartedAt: z.string(),
  updatedAt: z.string(),
});
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;

export const RatePointSchema = z.object({
  runId: z.number().int().positive(),
  date: z.string(),
  ratePct: z.number().nullable(),
  flaky: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type RatePoint = z.infer<typeof RatePointSchema>;

export const VerifyPointSchema = z.object({
  runId: z.number().int().positive(),
  date: z.string(),
  totalSec: z.number().nonnegative(),
});
export type VerifyPoint = z.infer<typeof VerifyPointSchema>;

export const PerfPointSchema = z.object({
  runId: z.number().int().positive(),
  date: z.string(),
  report: PerfReportSchema.nullable(),
});
export type PerfPoint = z.infer<typeof PerfPointSchema>;

export const MutationPointSchema = z.object({
  runId: z.number().int().positive(),
  date: z.string(),
  score: z.number().min(0).max(100),
});
export type MutationPoint = z.infer<typeof MutationPointSchema>;

export const DenialRecordSchema = z.object({
  date: z.string(),
  gate: z.string(),
  reason: z.string(),
});
export type DenialRecord = z.infer<typeof DenialRecordSchema>;

export const MergedPrSchema = z.object({
  number: z.number().int().positive(),
  body: z.string(),
  mergedAt: z.string(),
});
export type MergedPr = z.infer<typeof MergedPrSchema>;

export const EvalsPointSchema = z.object({
  runId: z.number().int().positive(),
  date: z.string(),
  conclusion: z.string(),
  /** totals.scenarios отчёта evals; null — артефакта нет (скип без секрета). */
  scenarios: z.number().int().nonnegative().nullable(),
  passed: z.number().int().nonnegative().nullable(),
  timeMs: z.number().nonnegative().nullable(),
  tokens: z.number().nonnegative().nullable(),
});
export type EvalsPoint = z.infer<typeof EvalsPointSchema>;

export const NightlyArtifactRunSchema = z.object({
  runId: z.number().int().positive(),
  date: z.string(),
  flakyRate: z.boolean(),
  verifyDurations: z.boolean(),
  mutationFull: z.boolean(),
});
export type NightlyArtifactRun = z.infer<typeof NightlyArtifactRunSchema>;

export const TaskConflictsSchema = z.object({
  branches: z.array(z.string()),
  conflictingPairs: z.array(z.tuple([z.string(), z.string()])),
});
export type TaskConflicts = z.infer<typeof TaskConflictsSchema>;

export interface TelemetryTargets {
  /** vision L3: PR CI p50 < 10 мин. */
  ciP50Min: number;
  /** vision L4: merge queue p50 < 15 мин. */
  mergeQueueP50Min: number;
  /** vision G4: flaky rate < 1 %. */
  flakyPct: number;
  /** verify-budgets.json totalSlow (сек) — enforce остаётся в гейте. */
  verifyTotalSlowSec: number;
  /** perf-budgets.json: maxMs по сценариям («scenario:<имя>»). */
  perfScenarioMaxMs: Record<string, number>;
  /** stryker.config.json thresholds.break. */
  mutationBreak: number;
}

export interface TelemetryInputs {
  nowIso: string;
  periodDays: number;
  targets: TelemetryTargets;
  /** Дата введения маркера агентного PR (этот PR) — до неё данных нет. */
  conventionSinceIso: string;
  ciRuns: WorkflowRun[];
  nightlyArtifactRuns: NightlyArtifactRun[];
  flakyPoints: RatePoint[];
  verifyPoints: VerifyPoint[];
  perfPoints: PerfPoint[];
  mutationPoints: MutationPoint[];
  denials: DenialRecord[];
  /** Подпись источника отказов (CI-артефакты или локальный журнал в --local). */
  denialsSource: string;
  /** Coverage-текст отказов: отличается между ночным и локальным режимом. */
  denialsCoverage: string;
  mergedPrs: MergedPr[];
  evalsPoints: EvalsPoint[];
  escapedDefectsMarkdown: string;
  taskConflicts: TaskConflicts;
  /** Проблемы, найденные main при сборе/разборе входов (З4: fail-closed). */
  problems: string[];
}

interface MetricBase {
  coverage: string;
  status: 'ok' | 'no-data';
}

export interface CiTimeMetric extends MetricBase {
  targets: { prP50Min: number; mergeQueueP50Min: number };
  pr: { runs: number; p50Min: number | null; p95Min: number | null };
  /** 0 прогонов merge_group за окно — контур не работает, не «пустой p50». */
  mergeQueue: {
    status: 'ok' | 'no-data';
    runs: number;
    p50Min: number | null;
    p95Min: number | null;
  };
  previousPr: { runs: number; p50Min: number | null; p95Min: number | null } | null;
  deltaPr: { p50Min: number | null; p95Min: number | null } | null;
}

export interface FlakyMetric extends MetricBase {
  targetPct: number;
  current: { runs: number; measured: number; meanPct: number | null };
  previous: { runs: number; measured: number; meanPct: number | null };
  deltaPp: number | null;
}

export interface VerifyMetric extends MetricBase {
  budgetSec: number;
  current: { runs: number; p50Sec: number | null; p95Sec: number | null };
  previous: { runs: number; p50Sec: number | null; p95Sec: number | null };
  delta: { p50Sec: number | null; p95Sec: number | null } | null;
}

export interface PerfScenarioStat {
  key: string;
  budgetMs: number;
  currentMedianMs: number | null;
  previousMedianMs: number | null;
  deltaMs: number | null;
}

export interface PerfMetric extends MetricBase {
  runs: number;
  measured: number;
  scenarios: PerfScenarioStat[];
}

export interface MutationMetric extends MetricBase {
  breakThreshold: number;
  current: { score: number; date: string; runId: number } | null;
  previous: { score: number; date: string; runId: number } | null;
  deltaPp: number | null;
}

export interface DenialsMetric extends MetricBase {
  source: string;
  current: { total: number; byGate: Record<string, number> };
  previous: { total: number };
  delta: number | null;
}

export interface AgentPrMetric extends MetricBase {
  marker: string;
  conventionSince: string;
  current: { merged: number; marked: number; sharePct: number | null };
  previous: { merged: number; marked: number; sharePct: number | null };
  deltaPp: number | null;
  notCollected: string;
}

export interface MergeConflictsMetric extends MetricBase {
  snapshot: string;
  branches: number;
  pairs: number;
  conflictingPairs: string[];
}

export interface EscapedDefectsMetric extends MetricBase {
  current: { inWindow: number; total: number };
  previous: { inWindow: number };
}

export interface EvalsMetric extends MetricBase {
  note: string | null;
  current: {
    runsTotal: number;
    runsSkippedNoSecret: number;
    runsMeasured: number;
    scenarios: number;
    passed: number;
    passRatePct: number | null;
    timeMs: number;
    tokens: number;
  };
  previous: { runsMeasured: number; scenarios: number; passed: number; passRatePct: number | null };
  deltaPp: number | null;
}

export interface TrendsReport {
  schema: 'trends-report/1';
  generatedAt: string;
  window: { since: string; until: string };
  previousWindow: { since: string; until: string };
  metrics: {
    ciTime: CiTimeMetric;
    flakyRate: FlakyMetric;
    verifyTime: VerifyMetric;
    perf: PerfMetric;
    mutationScore: MutationMetric;
    gateDenials: DenialsMetric;
    agentPrs: AgentPrMetric;
    taskMergeConflicts: MergeConflictsMetric;
    escapedDefects: EscapedDefectsMetric;
    evals: EvalsMetric;
  };
  problems: string[];
}

/** Квантиль отсортированного ряда: индекс round(q×(n−1)); пустой ряд — null. */
export function percentile(sortedValues: number[], q: number): number | null {
  if (sortedValues.length === 0) return null;
  const idx = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.round(q * (sortedValues.length - 1))),
  );
  return sortedValues[idx] ?? null;
}

export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Счёт мутаций по формуле mutation-testing-metrics (calculateMetrics.js):
 * totalDetected = killed + timeout; totalValid = totalDetected + survived +
 * noCoverage; score = totalValid > 0 ? detected/valid×100 : 100 (пустой домен).
 * Ignored, Pending, RuntimeError, CompileError в score не входят.
 */
export function mutationScoreFromMutants(statuses: string[]): {
  score: number;
  totalValid: number;
  totalInvalid: number;
  ignored: number;
  pending: number;
} {
  let killed = 0;
  let timeout = 0;
  let survived = 0;
  let noCoverage = 0;
  let invalid = 0;
  let ignored = 0;
  let pending = 0;
  for (const status of statuses) {
    switch (status) {
      case 'Killed':
        killed += 1;
        break;
      case 'Timeout':
        timeout += 1;
        break;
      case 'Survived':
        survived += 1;
        break;
      case 'NoCoverage':
        noCoverage += 1;
        break;
      case 'RuntimeError':
      case 'CompileError':
        invalid += 1;
        break;
      case 'Ignored':
        ignored += 1;
        break;
      case 'Pending':
        pending += 1;
        break;
      default:
        invalid += 1;
    }
  }
  const totalValid = killed + timeout + survived + noCoverage;
  const score = totalValid > 0 ? ((killed + timeout) / totalValid) * 100 : 100;
  return { score: round(score, 2), totalValid, totalInvalid: invalid, ignored, pending };
}

/**
 * Парсер реестра docs/escaped-defects.md: только основная таблица секции
 * «## Реестр» — до следующего заголовка «## » (секция «Копия из шаблона»
 * не считается, иначе счётчик задвоится). Дата — первая колонка строки.
 */
export function countEscapedDefects(markdown: string): { total: number; dates: string[] } {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === '## Реестр');
  if (start < 0) throw new Error('escaped-defects: нет секции «## Реестр»');
  const dates: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || line.startsWith('## ')) break;
    if (!line.startsWith('|')) continue;
    const firstCell = line.slice(1).split('|')[0]?.trim() ?? '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(firstCell)) dates.push(firstCell);
  }
  return { total: dates.length, dates };
}

const AGENT_PR_MARKER = 'PR создан агентом';

function fmt(value: number | null, suffix = ''): string {
  return value === null ? '—' : `${value}${suffix}`;
}
const AGENT_PR_MARKER_RE = /^-\s*\[x\]\s*PR создан агентом\s*$/im;

/** true — тело PR помечено чекбоксом маркера (тело наружу не выходит). */
export function isAgentPr(body: string): boolean {
  return AGENT_PR_MARKER_RE.test(body);
}

const DAY_MS = 86_400_000;

function windowStarts(nowMs: number, periodDays: number): { sinceMs: number; prevSinceMs: number } {
  const sinceMs = nowMs - periodDays * DAY_MS;
  return { sinceMs, prevSinceMs: sinceMs - periodDays * DAY_MS };
}

function inWindow(dateIso: string, fromMs: number, untilMs: number): boolean {
  const t = Date.parse(dateIso);
  return Number.isFinite(t) && t >= fromMs && t <= untilMs;
}

function stat(values: number[]): { runs: number; p50: number | null; p95: number | null } {
  const sorted = values.toSorted((a, b) => a - b);
  return { runs: sorted.length, p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95) };
}

function meanPct(points: RatePoint[]): number | null {
  const rates = points
    .map((point) => point.ratePct)
    .filter((rate): rate is number => rate !== null);
  if (rates.length === 0) return null;
  return round(rates.reduce((sum, rate) => sum + rate, 0) / rates.length);
}

function deltaOrNull(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  return round(current - previous);
}

/**
 * «Сломано» (З11): артефакты, которые после этого PR пишутся всегда
 * (if: always), обязаны быть у свежайшего прогона окна, если хоть один
 * прогон окна их отдал. Отсутствие у свежайшего — problem (красный CLI).
 */
const ALWAYS_ARTIFACTS: Array<{ key: keyof NightlyArtifactRun; label: string }> = [
  { key: 'flakyRate', label: 'flaky-rate (flake.json/flaky-rate.json)' },
  { key: 'verifyDurations', label: 'verify-durations' },
  { key: 'mutationFull', label: 'mutation-full' },
];

/** Длительности PR CI в минутах: завершённые прогоны без skipped/cancelled. */
function ciDurationMin(runs: WorkflowRun[]): number[] {
  const values: number[] = [];
  for (const run of runs) {
    if (run.conclusion === 'skipped' || run.conclusion === 'cancelled') continue;
    const started = Date.parse(run.runStartedAt);
    const updated = Date.parse(run.updatedAt);
    if (!Number.isFinite(started) || !Number.isFinite(updated) || updated < started) continue;
    values.push((updated - started) / 60_000);
  }
  return values;
}

/** Мс сценария из perf.json; новый сценарий без ветки здесь — медиана «—». */
function scenarioMs(report: PerfReport, key: string): number | null {
  switch (key) {
    case 'scenario:create-task':
      return report['scenario:create-task']['ms'];
    case 'scenario:toggle-task':
      return report['scenario:toggle-task']['ms'];
    default:
      return null;
  }
}

/** Медиана сценария по прогонам окна; отчёт null (красный perf) — мимо. */
function perfMedian(points: PerfPoint[], key: string): number | null {
  const values: number[] = [];
  for (const report of points.map((point) => point['report'])) {
    if (report === null) continue;
    const ms = scenarioMs(report, key);
    if (ms !== null) values.push(ms);
  }
  return percentile(
    values.toSorted((a, b) => a - b),
    0.5,
  );
}

/** Снимок последнего по времени прогона мутационного окна. */
function latestMutation(points: MutationPoint[]): MutationMetric['current'] {
  const sorted = points.toSorted((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const last = sorted[sorted.length - 1];
  return last === undefined ? null : { score: last.score, date: last.date, runId: last.runId };
}

export function buildTrendsReport(inputs: TelemetryInputs): TrendsReport {
  const nowMs = Date.parse(inputs.nowIso);
  if (!Number.isFinite(nowMs))
    throw new Error(`telemetry: nowIso не разбирается: ${inputs.nowIso}`);
  if (!Number.isInteger(inputs.periodDays) || inputs.periodDays < 1) {
    throw new Error(`telemetry: periodDays должен быть целым >= 1, получено ${inputs.periodDays}`);
  }
  const problems = [...inputs.problems];
  const { sinceMs, prevSinceMs } = windowStarts(nowMs, inputs.periodDays);

  // «Сломано» — fail-closed по артефактам if:always (ревью c9.4, absent-vs-zero).
  const nightlyRuns = inputs.nightlyArtifactRuns
    .filter((run) => inWindow(run.date, prevSinceMs, nowMs))
    .toSorted((a, b) => Date.parse(a.date) - Date.parse(b.date));
  for (const artifact of ALWAYS_ARTIFACTS) {
    const withArtifact = nightlyRuns.filter((run) => run[artifact.key] === true);
    if (withArtifact.length === 0) continue;
    const newest = nightlyRuns[nightlyRuns.length - 1];
    if (newest === undefined) continue;
    if (newest[artifact.key] !== true) {
      problems.push(
        `сводка: свежайший ночной прогон ${newest.runId} не отдал артефакт «${artifact.label}» — источник сломан (пишется always с c9.4; З11)`,
      );
    }
  }

  // CI: длительности завершённых прогонов (без skipped/cancelled).
  const prRuns = inputs.ciRuns.filter(
    (run) => run.event === 'pull_request' && inWindow(run.updatedAt, sinceMs, nowMs),
  );
  const prRunsPrev = inputs.ciRuns.filter(
    (run) => run.event === 'pull_request' && inWindow(run.updatedAt, prevSinceMs, sinceMs),
  );
  const mqRuns = inputs.ciRuns.filter(
    (run) => run.event === 'merge_group' && inWindow(run.updatedAt, sinceMs, nowMs),
  );
  const prStat = stat(ciDurationMin(prRuns));
  const prStatPrev = stat(ciDurationMin(prRunsPrev));
  const mqStat = stat(ciDurationMin(mqRuns));
  const ciTime: CiTimeMetric = {
    coverage:
      'время CI — workflow ci.yml: PR-канал event=pull_request, merge queue — event=merge_group; длительность = updated_at − run_started_at завершённого прогона (skipped/cancelled не считают). Цели — vision L3 p50 < 10 мин, L4 p50 < 15 мин (docs/vision.md, «Контуры проверки»)',
    status: prStat.runs > 0 || mqStat.runs > 0 ? 'ok' : 'no-data',
    targets: {
      prP50Min: inputs.targets.ciP50Min,
      mergeQueueP50Min: inputs.targets.mergeQueueP50Min,
    },
    pr: { runs: prStat.runs, p50Min: prStat.p50, p95Min: prStat.p95 },
    mergeQueue:
      mqStat.runs > 0
        ? { status: 'ok', runs: mqStat.runs, p50Min: mqStat.p50, p95Min: mqStat.p95 }
        : {
            status: 'no-data',
            runs: 0,
            p50Min: null,
            p95Min: null,
          },
    previousPr:
      prStatPrev.runs > 0
        ? { runs: prStatPrev.runs, p50Min: prStatPrev.p50, p95Min: prStatPrev.p95 }
        : null,
    deltaPr:
      prStatPrev.runs > 0
        ? {
            p50Min: deltaOrNull(prStat.p50, prStatPrev.p50),
            p95Min: deltaOrNull(prStat.p95, prStatPrev.p95),
          }
        : null,
  };

  // Flaky rate: числа гейта (--rate-out), не пересчёт телеметрией.
  const flakyCur = inputs.flakyPoints.filter((point) => inWindow(point.date, sinceMs, nowMs));
  const flakyPrev = inputs.flakyPoints.filter((point) =>
    inWindow(point.date, prevSinceMs, sinceMs),
  );
  const flakyCurMean = meanPct(flakyCur);
  const flakyPrevMean = meanPct(flakyPrev);
  const flakyRate: FlakyMetric = {
    coverage:
      'только E2E проекта functional: nightly flake-hunt (--repeat-each=5); rate — вычисленный гейтом tools/check-flaky-rate.ts (его --rate-out), телеметрия не пересчитывает сама; unit и статические проверки — не собирается, чем закрыть: repeat-волна на unit-гейт (отдельная задача); цель G4 < 1 % (vision)',
    status: flakyCur.length > 0 ? 'ok' : 'no-data',
    targetPct: inputs.targets.flakyPct,
    current: {
      runs: flakyCur.length,
      measured: flakyCur.filter((p) => p.ratePct !== null).length,
      meanPct: flakyCurMean,
    },
    previous: {
      runs: flakyPrev.length,
      measured: flakyPrev.filter((p) => p.ratePct !== null).length,
      meanPct: flakyPrevMean,
    },
    deltaPp: deltaOrNull(flakyCurMean, flakyPrevMean),
  };

  // Бюджет verify: тотальный из артефакта verify-durations; enforce — гейт.
  const verifyCur = inputs.verifyPoints.filter((point) => inWindow(point.date, sinceMs, nowMs));
  const verifyPrev = inputs.verifyPoints.filter((point) =>
    inWindow(point.date, prevSinceMs, sinceMs),
  );
  const verifyCurStat = stat(verifyCur.map((point) => point.totalSec));
  const verifyPrevStat = stat(verifyPrev.map((point) => point.totalSec));
  const verifyTime: VerifyMetric = {
    coverage:
      'pnpm verify --full --enforce-budgets в job verify-budgets (nightly); totalSec — общий из артефакта verify-durations-<run_id>; порог — verify-budgets.json totalSlow: enforce остаётся в гейте B1, телеметрия не считает его сама',
    status: verifyCurStat.runs > 0 ? 'ok' : 'no-data',
    budgetSec: inputs.targets.verifyTotalSlowSec,
    current: { runs: verifyCurStat.runs, p50Sec: verifyCurStat.p50, p95Sec: verifyCurStat.p95 },
    previous: { runs: verifyPrevStat.runs, p50Sec: verifyPrevStat.p50, p95Sec: verifyPrevStat.p95 },
    delta:
      verifyPrevStat.runs > 0
        ? {
            p50Sec: deltaOrNull(verifyCurStat.p50, verifyPrevStat.p50),
            p95Sec: deltaOrNull(verifyCurStat.p95, verifyPrevStat.p95),
          }
        : null,
  };

  // Perf: медианы сценариев по прогонам окна; отсутствие perf.json — no-data
  // (артефакт пишется только при успехе perf/baseline), не «сломано» и не ноль.
  const perfScenarioEntries = Object.entries(inputs.targets.perfScenarioMaxMs).toSorted(
    ([a], [b]) => (a < b ? -1 : 1),
  );
  const perfCur = inputs.perfPoints.filter((point) => inWindow(point.date, sinceMs, nowMs));
  const perfPrev = inputs.perfPoints.filter((point) => inWindow(point.date, prevSinceMs, sinceMs));
  const perf: PerfMetric = {
    coverage:
      'медианы сценариев по свежим прогонам окна; источник — артефакт perf-trend-<run_id> (e2e/reports/perf.json), который nightly пишет только при успешном perf+baseline, поэтому отсутствие = «нет данных», не «сломано»; бюджеты — perf-budgets.json; гейт сравнения A6 (check-perf-trend) не переносится и не ослабляется',
    status: perfCur.some((point) => point['report'] !== null) ? 'ok' : 'no-data',
    runs: perfCur.length,
    measured: perfCur.filter((point) => point['report'] !== null).length,
    scenarios: perfScenarioEntries.map(([key, budgetMs]) => {
      const currentMedianMs = perfMedian(perfCur, key);
      const previousMedianMs = perfMedian(perfPrev, key);
      return {
        key,
        budgetMs,
        currentMedianMs,
        previousMedianMs,
        deltaMs: deltaOrNull(currentMedianMs, previousMedianMs),
      };
    }),
  };

  // Mutation score: снимок последнего прогона окна (формула — см. счётчик).
  const mutationCur = inputs.mutationPoints.filter((point) => inWindow(point.date, sinceMs, nowMs));
  const mutationPrev = inputs.mutationPoints.filter((point) =>
    inWindow(point.date, prevSinceMs, sinceMs),
  );
  const mutationCurrent = latestMutation(mutationCur);
  const mutationPrevious = latestMutation(mutationPrev);
  const mutationScore: MutationMetric = {
    coverage:
      'полный score домена apps/api (nightly mutation-full, если: always); формула mutation-testing-metrics: (killed+timeout)/(killed+timeout+survived+noCoverage); «изменённого кода» PR — не собирается в тренд, чем закрыть: сбор per-PR артефактов mutation-report (ci.yml) — отдельная задача; порог break — stryker.config.json (enforce остаётся в гейте)',
    status: mutationCurrent !== null ? 'ok' : 'no-data',
    breakThreshold: inputs.targets.mutationBreak,
    current: mutationCurrent,
    previous: mutationPrevious,
    deltaPp:
      mutationCurrent !== null && mutationPrevious !== null
        ? round(mutationCurrent.score - mutationPrevious.score)
        : null,
  };

  // Отказы гейтов: только CI-слой; нет артефакта у зелёного прогона = 0.
  const denialsCur = inputs.denials.filter((record) => inWindow(record.date, sinceMs, nowMs));
  const denialsPrev = inputs.denials.filter((record) =>
    inWindow(record.date, prevSinceMs, sinceMs),
  );
  const byGate: Record<string, number> = {};
  for (const record of denialsCur) {
    byGate[record.gate] = (byGate[record.gate] ?? 0) + 1;
  }
  const sortedByGate: Record<string, number> = {};
  for (const gate of Object.keys(byGate).toSorted()) sortedByGate[gate] = byGate[gate] ?? 0;
  const gateDenials: DenialsMetric = {
    coverage: inputs.denialsCoverage,
    status: 'ok',
    source: inputs.denialsSource,
    current: { total: denialsCur.length, byGate: sortedByGate },
    previous: { total: denialsPrev.length },
    delta: round(denialsCur.length - denialsPrev.length),
  };

  // Доля агентных PR: чекбокс маркера; тела PR в отчёт не выходят.
  const agentShare = (
    prs: MergedPr[],
  ): { merged: number; marked: number; sharePct: number | null } => {
    const marked = prs.filter((pr) => isAgentPr(pr.body)).length;
    return {
      merged: prs.length,
      marked,
      sharePct: prs.length > 0 ? round((marked / prs.length) * 100) : null,
    };
  };
  const prsCur = inputs.mergedPrs.filter((pr) => inWindow(pr.mergedAt, sinceMs, nowMs));
  const prsPrev = inputs.mergedPrs.filter((pr) => inWindow(pr.mergedAt, prevSinceMs, sinceMs));
  const agentCur = agentShare(prsCur);
  const agentPrev = agentShare(prsPrev);
  const agentPrs: AgentPrMetric = {
    coverage:
      'доля смёрженных PR с чекбоксом «PR создан агентом» в описании (конвенция введена этим PR — до неё данных нет); тела PR в отчёт и summary не попадают — только счёт',
    status: agentCur.merged > 0 ? 'ok' : 'no-data',
    marker: `- [x] ${AGENT_PR_MARKER}`,
    conventionSince: inputs.conventionSinceIso,
    current: agentCur,
    previous: agentPrev,
    deltaPp: deltaOrNull(agentCur.sharePct, agentPrev.sharePct),
    notCollected:
      '«без ручных правок» — не собирается, чем закрыть: конвенция отметки ручных правок человека при приёмке PR (решение человека, отдельная задача)',
  };

  // Конфликты задач доски: снимок пар открытых задач с конфликтом (merge-tree).
  const taskMergeConflicts: MergeConflictsMetric = {
    coverage:
      'пары веток открытых задач доски (backlog/*.md → origin/task/<id>, существующие ссылки) с конфликтом слияния по git merge-tree --write-tree; снимок на момент отчёта, цели нет; «горячие» файлы (b7) — та же метрика сверху',
    status: 'ok',
    snapshot: inputs.nowIso,
    branches: inputs.taskConflicts.branches.length,
    pairs: (inputs.taskConflicts.branches.length * (inputs.taskConflicts.branches.length - 1)) / 2,
    conflictingPairs: inputs.taskConflicts.conflictingPairs.map(([a, b]) => `${a}..${b}`),
  };

  // Escaped defects: строки основной таблицы реестра.
  const defects = countEscapedDefects(inputs.escapedDefectsMarkdown);
  const escapedDefects: EscapedDefectsMetric = {
    coverage:
      'строки реестра docs/escaped-defects.md (только основная таблица «## Реестр» до «Копии из шаблона»); дата — первая колонка; цели нет — каждый случай требует гейта или записи «гейт невозможен»',
    status: 'ok',
    current: {
      inWindow: defects.dates.filter((date) => inWindow(`${date}T00:00:00Z`, sinceMs, nowMs))
        .length,
      total: defects.total,
    },
    previous: {
      inWindow: defects.dates.filter((date) => inWindow(`${date}T00:00:00Z`, prevSinceMs, sinceMs))
        .length,
    },
  };

  // Evals: скип без секрета — «не собирается», не ноль и не проблема.
  const evalsWindowStat = (points: EvalsPoint[]) => {
    const measured = points.filter((point) => point.scenarios !== null);
    const scenarios = measured.reduce((sum, point) => sum + (point.scenarios ?? 0), 0);
    const passed = measured.reduce((sum, point) => sum + (point.passed ?? 0), 0);
    const timeMs = measured.reduce((sum, point) => sum + (point.timeMs ?? 0), 0);
    const tokens = measured.reduce((sum, point) => sum + (point.tokens ?? 0), 0);
    return {
      runsTotal: points.length,
      runsSkippedNoSecret: points.filter((point) => point.conclusion === 'skipped').length,
      runsMeasured: measured.length,
      scenarios,
      passed,
      passRatePct: scenarios > 0 ? round((passed / scenarios) * 100) : null,
      timeMs,
      tokens,
    };
  };
  const evalsCur = inputs.evalsPoints.filter((point) => inWindow(point.date, sinceMs, nowMs));
  const evalsPrev = inputs.evalsPoints.filter((point) =>
    inWindow(point.date, prevSinceMs, sinceMs),
  );
  const evalsCurStat = evalsWindowStat(evalsCur);
  const evalsPrevStat = evalsWindowStat(evalsPrev);
  const evalsNoData = evalsCurStat.runsMeasured === 0;
  const evalsNote =
    evalsNoData && evalsCurStat.runsSkippedNoSecret > 0
      ? 'нет секрета ANTHROPIC_API_KEY — все прогоны окна скипнуты (evals.yml), метрика не собирается: это не ноль и не сломанный источник'
      : null;
  const evals: EvalsMetric = {
    coverage:
      'эталонные агентные прогоны (ADR 0016): артефакты evals-<run_id>, totals отчёта tools/evals/report.ts; null-метрики не схлопываются в ноль (c9.1); job скипается без секрета — период без прогонов честно помечен, а не занулён',
    status: evalsNoData ? 'no-data' : 'ok',
    note: evalsNote,
    current: evalsCurStat,
    previous: {
      runsMeasured: evalsPrevStat.runsMeasured,
      scenarios: evalsPrevStat.scenarios,
      passed: evalsPrevStat.passed,
      passRatePct: evalsPrevStat.passRatePct,
    },
    deltaPp: deltaOrNull(evalsCurStat.passRatePct, evalsPrevStat.passRatePct),
  };

  return {
    schema: 'trends-report/1',
    generatedAt: inputs.nowIso,
    window: { since: new Date(sinceMs).toISOString(), until: inputs.nowIso },
    previousWindow: {
      since: new Date(prevSinceMs).toISOString(),
      until: new Date(sinceMs).toISOString(),
    },
    metrics: {
      ciTime,
      flakyRate,
      verifyTime,
      perf,
      mutationScore,
      gateDenials,
      agentPrs,
      taskMergeConflicts,
      escapedDefects,
      evals,
    },
    problems,
  };
}

/**
 * GITHUB_STEP_SUMMARY: только числа, id и статусы — тексты PR/issue и
 * содержимое артефактов сюда не попадают (недоверенные данные, ревью c9.4).
 */
export function renderSummary(report: TrendsReport): string {
  const m = report.metrics;
  const lines: string[] = [
    '# Тренды обвязки (c9.4)',
    '',
    `Период: ${report.window.since} — ${report.window.until} (предыдущее окно: ${report.previousWindow.since} — ${report.previousWindow.until})`,
    '',
    '| Метрика | Окно | Пред. окно | Дельта | Цель |',
    '| ------- | ---- | ---------- | ------ | ---- |',
  ];
  lines.push(
    `| Время PR CI p50/p95, мин | ${fmt(m.ciTime.pr.p50Min, '/')}/${fmt(m.ciTime.pr.p95Min, '/')} (${m.ciTime.pr.runs} прог.) | ${
      m.ciTime.previousPr === null
        ? '—'
        : `${fmt(m.ciTime.previousPr.p50Min, '/')}/${fmt(m.ciTime.previousPr.p95Min, '/')}`
    } | ${m.ciTime.deltaPr === null ? '—' : `${fmt(m.ciTime.deltaPr.p50Min, '/')}/${fmt(m.ciTime.deltaPr.p95Min, '/')}`} | p50 < ${m.ciTime.targets.prP50Min} мин (L3) |`,
    `| Merge queue p50/p95, мин | ${m.ciTime.mergeQueue.status === 'ok' ? `${fmt(m.ciTime.mergeQueue.p50Min, '/')}/${fmt(m.ciTime.mergeQueue.p95Min, '/')} (${m.ciTime.mergeQueue.runs} прог.)` : `контур не работает (${m.ciTime.mergeQueue.runs} прог.)`} | — | — | p50 < ${m.ciTime.targets.mergeQueueP50Min} мин (L4) |`,
    `| Flaky rate (mean), % | ${fmt(m.flakyRate.current.meanPct, '%')} (${m.flakyRate.current.measured}/${m.flakyRate.current.runs} прог.) | ${fmt(m.flakyRate.previous.meanPct, '%')} | ${fmt(m.flakyRate.deltaPp, ' п.п.')} | < ${m.flakyRate.targetPct} % (G4) |`,
    `| Verify --full p50/p95, с | ${fmt(m.verifyTime.current.p50Sec, '/')}/${fmt(m.verifyTime.current.p95Sec, '/')} (${m.verifyTime.current.runs}) | ${fmt(m.verifyTime.previous.p50Sec, '/')}/${fmt(m.verifyTime.previous.p95Sec, '/')} | ${m.verifyTime.delta === null ? '—' : `${fmt(m.verifyTime.delta.p50Sec, '/')}/${fmt(m.verifyTime.delta.p95Sec, '/')}`} | бюджет ${m.verifyTime.budgetSec} с (З6) |`,
  );
  for (const scenario of m.perf.scenarios) {
    lines.push(
      `| Perf ${scenario.key}, медиана | ${fmt(scenario.currentMedianMs, ' мс')} | ${fmt(scenario.previousMedianMs, ' мс')} | ${fmt(scenario.deltaMs, ' мс')} | ≤ ${scenario.budgetMs} мс |`,
    );
  }
  lines.push(
    `| Mutation score | ${m.mutationScore.current === null ? '—' : `${m.mutationScore.current.score} % (run ${m.mutationScore.current.runId})`} | ${
      m.mutationScore.previous === null ? '—' : `${m.mutationScore.previous.score} %`
    } | ${fmt(m.mutationScore.deltaPp, ' п.п.')} | break > ${m.mutationScore.breakThreshold} (гейт) |`,
    `| Отказы гейтов (CI gate-integrity) | ${m.gateDenials.current.total} | ${m.gateDenials.previous.total} | ${m.gateDenials.delta} | — |`,
    `| Доля агентных PR | ${m.agentPrs.current.sharePct === null ? '—' : `${m.agentPrs.current.sharePct} % (${m.agentPrs.current.marked}/${m.agentPrs.current.merged})`} | ${
      m.agentPrs.previous.sharePct === null ? '—' : `${m.agentPrs.previous.sharePct} %`
    } | ${fmt(m.agentPrs.deltaPp, ' п.п.')} | — |`,
    `| Конфликты задач доски | ${m.taskMergeConflicts.conflictingPairs.length} из ${m.taskMergeConflicts.pairs} пар (${m.taskMergeConflicts.branches} веток) | — | — | — |`,
    `| Escaped defects | ${m.escapedDefects.current.inWindow} за окно, всего ${m.escapedDefects.current.total} | ${m.escapedDefects.previous.inWindow} | — | — |`,
    `| Evals pass rate | ${m.evals.current.passRatePct === null ? `— (${m.evals.current.runsSkippedNoSecret} скипнутых, ${m.evals.current.runsMeasured} с данными)` : `${m.evals.current.passRatePct} % (${m.evals.current.passed}/${m.evals.current.scenarios})`} | ${m.evals.previous.passRatePct === null ? '—' : `${m.evals.previous.passRatePct} %`} | ${fmt(m.evals.deltaPp, ' п.п.')} | — |`,
    '',
  );
  if (report.problems.length > 0) {
    lines.push(
      '## Проблемы источников (fail-closed)',
      '',
      ...report.problems.map((problem) => `- ${problem}`),
      '',
    );
  }
  lines.push('## Что не собирается (чем закрыть)', '');
  const allMetrics: AnyMetric[] = [
    m.ciTime,
    m.flakyRate,
    m.verifyTime,
    m.perf,
    m.mutationScore,
    m.gateDenials,
    m.agentPrs,
    m.taskMergeConflicts,
    m.escapedDefects,
    m.evals,
  ];
  for (const metric of allMetrics) {
    lines.push(`- ${metricCoverageLine(metric)}`);
  }
  if (m.evals.note !== null) lines.push(`- evals: ${m.evals.note}`);
  lines.push(
    '',
    '<!-- Тела PR/issue и содержимое артефактов в summary не вставляются (untrusted) -->',
  );
  return lines.join('\n');
}

type AnyMetric = { coverage: string; status: 'ok' | 'no-data'; note?: string | null };

function metricCoverageLine(metric: AnyMetric): string {
  return metric.status === 'no-data'
    ? `${metric.coverage} (статус: нет данных за окно${metric.note ? `; ${metric.note}` : ''})`
    : metric.coverage;
}
