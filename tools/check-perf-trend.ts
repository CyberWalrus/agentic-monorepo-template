/**
 * Чистое ядро ночного тренд-сравнения (A6 PR-3, ADR 0006 уровень 2): сравнение
 * отчётов с допусками perf-budgets.json `trend` и решение по свежести
 * базлайна. Без gh и побочных эффектов — импортируется тестами. CLI
 * (fetch-baseline / compare / write-meta) — в check-perf-trend.main.ts.
 *
 * База — артефакт `perf-baseline` последнего зелёного nightly; обновляется
 * только зелёными прогонами. Допуски: запросы — точное совпадение, байты —
 * +maxPrGrowthKb, время — max(floor, pct×baseline), cls — +clsSlack,
 * longTasks — +longTasksSlack. STALE не отменяет сравнение — job идёт по
 * старой базе с issue; зелёный прогон обновляет базу и снимает STALE.
 */
import type { PerfReport } from './perf-metrics.ts';

export interface BaselineMeta {
  sha: string;
  runId: number;
  createdAt: string;
}

export interface CompareFailure {
  metric: string;
  detail: string;
}

export type CompareVerdict =
  | { status: 'ok' }
  | { status: 'regression'; failures: CompareFailure[] }
  | { status: 'invalid'; reason: string };

const pageOf = (report: PerfReport) => report['page:/'];
const scenarioOf = (report: PerfReport, name: 'create-task' | 'toggle-task') =>
  report[`scenario:${name}`];

/**
 * Сравнение кандидата с базой по допускам `trend`. Нарушение любой линии —
 * regression со списком нарушенных метрик; невалидные входы ловит схема
 * PerfReportSchema до этого вызова (З4: fail-closed на форме данных).
 */
export function compareReports(
  candidate: PerfReport,
  baseline: PerfReport,
  trend: {
    timeFloorMs: { ttfbMs: number; lcpMs: number; lcpNetMs: number; scenarioMs: number };
    timePct: number;
    clsSlack: number;
    longTasksSlack: number;
    maxBytesSlackKb: number;
  },
): CompareVerdict {
  const failures: CompareFailure[] = [];
  const page = pageOf(candidate);
  const pageBase = pageOf(baseline);

  const exact = (metric: string, value: number, allowed: number) => {
    if (value !== allowed) {
      failures.push({ metric, detail: `${value} != ${allowed} (точное совпадение)` });
    }
  };
  const slack = (metric: string, value: number, allowed: number, limit: number) => {
    if (value > limit) {
      failures.push({ metric, detail: `${value} > ${limit} (база ${allowed})` });
    }
  };
  const timed = (metric: string, value: number, allowed: number, floor: number) => {
    slack(metric, value, allowed, allowed + Math.max(floor, trend.timePct * allowed));
  };

  exact('page:/ requests', page.requests, pageBase.requests);
  exact('page:/ apiRequests', page.apiRequests, pageBase.apiRequests);
  slack(
    'page:/ jsWireKb',
    page.jsWireKb,
    pageBase.jsWireKb,
    pageBase.jsWireKb + trend.maxBytesSlackKb,
  );
  slack(
    'page:/ cssWireKb',
    page.cssWireKb,
    pageBase.cssWireKb,
    pageBase.cssWireKb + trend.maxBytesSlackKb,
  );
  timed('page:/ ttfbMs', page.ttfbMs, pageBase.ttfbMs, trend.timeFloorMs.ttfbMs);
  timed('page:/ lcpMs', page.lcpMs, pageBase.lcpMs, trend.timeFloorMs.lcpMs);
  timed('page:/ lcpNetMs', page.lcpNetMs, pageBase.lcpNetMs, trend.timeFloorMs.lcpNetMs);
  slack('page:/ cls', page.cls, pageBase.cls, pageBase.cls + trend.clsSlack);

  for (const name of ['create-task', 'toggle-task'] as const) {
    const scenario = scenarioOf(candidate, name);
    const base = scenarioOf(baseline, name);
    exact(`scenario:${name} apiRequests`, scenario.apiRequests, base.apiRequests);
    slack(
      `scenario:${name} longTasks`,
      scenario.longTasks,
      base.longTasks,
      base.longTasks + trend.longTasksSlack,
    );
    timed(`scenario:${name} ms`, scenario.ms, base.ms, trend.timeFloorMs.scenarioMs);
  }

  if (failures.length === 0) {
    return { status: 'ok' };
  }
  return { status: 'regression', failures };
}

export type BaselineDecision =
  | { kind: 'found' }
  | { kind: 'none' }
  | { kind: 'stale'; reason: string };

/**
 * Решение по скачанной базе: none — артефакта нет ни у одного успешного
 * прогона (первый запуск); stale — база старше baselineMaxAgeDays дней ИЛИ
 * новнее базы больше baselineMaxGreenRuns успешных прогонов (тихо сломанная
 * выгрузка артефактов). STALE не отменяет сравнение — сравнение идёт по
 * старой базе с issue; зелёный прогон обновляет базу и снимает STALE
 * (находка sanity-ревью A6.1: без этого канал клинит в вечный красный).
 */
export function decideBaseline(args: {
  meta: BaselineMeta | undefined;
  nowMs: number;
  greenRunsAfter: number;
  trend: { baselineMaxAgeDays: number; baselineMaxGreenRuns: number };
}): BaselineDecision {
  if (!args.meta) {
    return { kind: 'none' };
  }
  const ageDays = (args.nowMs - Date.parse(args.meta.createdAt)) / 86_400_000;
  if (ageDays > args.trend.baselineMaxAgeDays) {
    return {
      kind: 'stale',
      reason: `базе ${Math.round(ageDays)} дней (лимит ${args.trend.baselineMaxAgeDays})`,
    };
  }
  if (args.greenRunsAfter > args.trend.baselineMaxGreenRuns) {
    return {
      kind: 'stale',
      reason: `новнее базы ${args.greenRunsAfter} зелёных прогонов (лимит ${args.trend.baselineMaxGreenRuns}) — выгрузка артефакта сломана`,
    };
  }
  return { kind: 'found' };
}
