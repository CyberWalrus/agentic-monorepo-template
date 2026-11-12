import { readFileSync } from 'node:fs';

import * as z from 'zod';

const PageBudgetSchema = z.object({
  maxTtfbMs: z.number().positive(),
  maxLcpMs: z.number().positive(),
  maxCls: z.number().nonnegative(),
});

export const PerfBudgetsSchema = z.object({
  web: z.object({
    bundle: z.object({
      maxTotalJsGzipKb: z.number().positive(),
      maxLargestJsChunkGzipKb: z.number().positive(),
      maxTotalCssGzipKb: z.number().positive(),
    }),
    pages: z.record(z.string(), PageBudgetSchema),
    scenarios: z.record(z.string(), z.object({ maxMs: z.number().positive() })),
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
