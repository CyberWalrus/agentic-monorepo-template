/**
 * Общий модуль метрик перфа (З8, A6 PR-1): форма отчёта perf.json, median и
 * zod-схема (A6 PR-3). Один источник для perf-теста (e2e/perf/tasks.perf.ts —
 * валидирует отчёт перед записью) и тренд-чекера nightly
 * (tools/check-perf-trend.ts) — не плодить вторые копии ключей и схемы
 * (ревью sanity).
 */
import * as z from 'zod';

export interface PageMetrics {
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

export interface ScenarioMetrics {
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

// z.number() отвергает NaN, но не Infinity: 1e999 в JSON парсится как
// Infinity и делал бы метрику вечно зелёной в сравнении (находка
// security-ревью A6.1) — поэтому finite-гуард на каждое число. NaN же
// делает отчёт невалидным: пропуск секции (пустой список повторов) краснит
// perf-тест и тренд-чекер, а не молчит (З4).
const finite = () => z.number().refine(Number.isFinite, 'конечное число');

export const PerfReportSchema = z.object({
  'page:/': z.object({
    ttfbMs: finite(),
    lcpMs: finite(),
    cls: finite(),
    lcpNetMs: finite(),
    requests: finite(),
    apiRequests: finite(),
    jsWireKb: finite(),
    cssWireKb: finite(),
  }),
  'scenario:create-task': z.object({
    ms: finite(),
    apiRequests: finite(),
    longTasks: finite(),
  }),
  'scenario:toggle-task': z.object({
    ms: finite(),
    apiRequests: finite(),
    longTasks: finite(),
  }),
});
