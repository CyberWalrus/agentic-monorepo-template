/**
 * Общие хелперы формы отчётов раннеров (задача b9): вид отчёта определяется по
 * форме — Vitest (jest-совместимый JSON) или Playwright (JSON reporter) — а
 * данные полей приходят из недоверенного входа и чистятся перед печатью.
 * Вынесено из tools/check-test-report.ts, чтобы диагностика verify
 * (tools/verify-diagnostics.ts) переиспользовала их, а не копировала (З10).
 * Без зависимостей: модуль импортируют гейты и verify.
 */

/** Вид отчёта Playwright: JSON-ruunner пишет дерево `suites`. */
export function isPlaywrightReport(report: Record<string, unknown>): boolean {
  return Array.isArray(report['suites']);
}

/** Вид отчёта Vitest: jest-совместимый JSON со счётчиком и `testResults`. */
export function isVitestReport(report: Record<string, unknown>): boolean {
  return typeof report['numTotalTests'] === 'number' && Array.isArray(report['testResults']);
}

/**
 * Поля отчёта приходят из недоверенного входа: перевод строки подделает
 * строчки лога шага (log injection), управляющие символы — замусорят его.
 * Без regex: oxlint запрещает управляющие символы в регулярных выражениях.
 */
export function clean(value: string): string {
  let result = '';
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      result += code === 10 ? '\\n' : code === 9 ? '\\t' : `\\x${code.toString(16)}`;
    } else {
      result += char;
    }
  }
  return result;
}
