import { readFileSync } from 'node:fs';

import * as z from 'zod';

const PageBudgetSchema = z.object({
  maxTtfbMs: z.number().positive(),
  maxLcpMs: z.number().positive(),
  maxCls: z.number().nonnegative(),
  // Детерминированные метрики (A6 PR-1): запросы, wire-байты, LCP под Fast 3G.
  maxRequests: z.number().int().nonnegative(),
  maxApiRequests: z.number().int().nonnegative(),
  maxJsWireKb: z.number().nonnegative(),
  maxCssWireKb: z.number().nonnegative(),
  maxLcpNetMs: z.number().positive(),
});

const ScenarioBudgetSchema = z.object({
  maxMs: z.number().positive(),
  // Число запросов к /rpc и long tasks (>50 мс) за сценарий (A6 PR-1).
  maxApiRequests: z.number().int().nonnegative(),
  maxLongTasks: z.number().int().nonnegative(),
});

export const PerfBudgetsSchema = z.object({
  web: z.object({
    bundle: z.object({
      maxTotalJsGzipKb: z.number().positive(),
      maxLargestJsChunkGzipKb: z.number().positive(),
      maxTotalCssGzipKb: z.number().positive(),
      // Дельта-гейт PR (A6 PR-2): рост total JS gzip от merge-base за один PR.
      maxPrGrowthKb: z.number().positive(),
    }),
    pages: z.record(z.string(), PageBudgetSchema),
    scenarios: z.record(z.string(), ScenarioBudgetSchema),
  }),
  api: z.object({
    maxP95Ms: z.number().positive(),
    maxErrorRate: z.number().min(0).max(1),
  }),
});

export type PerfBudgets = z.infer<typeof PerfBudgetsSchema>;

/** Читает и валидирует /perf-budgets.json: опечатка в пороге не должна молча отключать проверку. */
export function loadPerfBudgets(): PerfBudgets {
  const raw: unknown = JSON.parse(
    readFileSync(new URL('../perf-budgets.json', import.meta.url), 'utf8'),
  );
  return PerfBudgetsSchema.parse(raw);
}
