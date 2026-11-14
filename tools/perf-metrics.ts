/**
 * Общий модуль метрик перфа (З8, A6 PR-1): форма отчёта perf.json и median.
 * Один источник для perf-теста (e2e/perf/tasks.perf.ts) и тренд-чекера nightly
 * (tools/check-perf-trend.ts, A6 PR-3) — не плодить вторые копии ключей и
 * схемы (ревью sanity). Схема отчёта с zod придёт в PR-3 вместе с чекером.
 */

interface PageMetrics {
  ttfbMs: number;
  lcpMs: number;
  cls: number;
  /** LCP под Fast 3G (CDP): начинает зависеть от веса страницы (roadmap A6 п.5). */
  lcpNetMs: number;
  /** Все сетевые запросы холодной загрузки (свежий контекст, тёплый кэш врёт). */
  requests: number;
  /** Из них к API (/rpc). */
  apiRequests: number;
  /** Wire-байты JS и CSS (CDP encodedDataLength, gzip на проводе). */
  jsWireKb: number;
  cssWireKb: number;
}

interface ScenarioMetrics {
  ms: number;
  /** Запросы к /rpc за время сценария. */
  apiRequests: number;
  /** Long tasks (>50 мс) за все повторы сценария при CPU×4. */
  longTasks: number;
}

export interface PerfReport {
  'page:/': PageMetrics;
  'scenario:create-task': ScenarioMetrics;
  'scenario:toggle-task': ScenarioMetrics;
}

export function median(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}
