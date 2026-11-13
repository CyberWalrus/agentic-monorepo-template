/**
 * Запрет запуска визуальных тестов мимо Docker-образа (З4, A8): базлайны без
 * суффикса платформы существуют только для Linux-образа Playwright, поэтому
 * «missing» базлайн, записанный на macOS-хосте, молча разошёлся бы с CI.
 * Используется конфигом Playwright (e2e вне скоупа правила границ
 * product-not-to-tools — прецедент tools/ports.ts). Конфиг Vitest UI держит
 * ту же проверку инлайн (пакет импортировать tools/ не может), её живость
 * закрепляет wiring-тест в tools/test/visual-guard.test.ts.
 *
 * VISUAL_UPDATE=1 — единственный способ включить запись базлайнов, легален
 * только внутри образа (`pnpm visual:update`); без него запись выключена
 * всегда, включая локальные прогоны вне CI.
 */

export interface VisualRunInput {
  argv: string[];
  platform: string;
  /** Значение ALLOW_HOST_SCREENSHOTS — задокументированный лаз для триажа. */
  allowEnv: string | undefined;
}

export const HOST_SCREENSHOTS_MESSAGE =
  'Visual tests must run inside the Playwright Docker image so baselines match CI. Use `pnpm visual` from the repo root.';

/** Эвристика как в packages/ui/vitest.config.ts: «visual» в аргументах запуска. */
function visualRequested(argv: string[]): boolean {
  return argv.some((arg) => arg.includes('visual'));
}

/** Бросает до любых побочных эффектов конфига — запрет не должен создавать файлов. */
export function assertVisualRunAllowed(input: VisualRunInput): void {
  if (visualRequested(input.argv) && input.platform !== 'linux' && !input.allowEnv) {
    throw new Error(HOST_SCREENSHOTS_MESSAGE);
  }
}

/** Запись базлайнов включена только явным VISUAL_UPDATE=1 (человек, внутри образа). */
export function snapshotsUpdateMode(env: { VISUAL_UPDATE?: string }): 'all' | 'none' {
  return env['VISUAL_UPDATE'] === '1' ? 'all' : 'none';
}
