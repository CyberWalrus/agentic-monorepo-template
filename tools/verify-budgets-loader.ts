/**
 * Чистая логика бюджетов времени verify (З6, B1) — без побочных эффектов,
 * чтобы ветки разбора и сравнения были покрыты юнит-тестами (tools/test/
 * verify-budgets.test.ts). verify.ts читает файл и зовёт parseBudgets;
 * бросок = битый файл, вызывающий превращает его в WARNING (или красный
 * при --enforce-budgets).
 */

export interface VerifyBudgets {
  fast: Record<string, number>;
  slow: Record<string, number>;
  totalFast: number;
  totalSlow: number;
}

export function parseBudgets(parsed: unknown): VerifyBudgets {
  if (!isRecord(parsed)) {
    throw new Error('expected an object');
  }
  const totalFast = parsed['totalFast'];
  const totalSlow = parsed['totalSlow'];
  if (typeof totalFast !== 'number' || typeof totalSlow !== 'number') {
    throw new Error('"totalFast" and "totalSlow" must be numbers');
  }
  return {
    fast: readNumberDict(parsed['fast'], 'fast'),
    slow: readNumberDict(parsed['slow'], 'slow'),
    totalFast,
    totalSlow,
  };
}

/** Бюджет шага в миллисекундах; slow-шаги берутся из slow-волны. */
export function budgetMsFor(
  stepName: string,
  isSlowStep: boolean,
  budgets: VerifyBudgets,
): number | undefined {
  const seconds = isSlowStep ? budgets.slow[stepName] : budgets.fast[stepName];
  return seconds === undefined ? undefined : seconds * 1000;
}

function readNumberDict(value: unknown, label: string): Record<string, number> {
  if (!isRecord(value)) {
    throw new Error(`"${label}" must be an object of numbers`);
  }
  const dict: Record<string, number> = {};
  for (const [key, seconds] of Object.entries(value)) {
    if (typeof seconds !== 'number') {
      throw new Error(`"${label}.${key}" must be a number`);
    }
    dict[key] = seconds;
  }
  return dict;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
