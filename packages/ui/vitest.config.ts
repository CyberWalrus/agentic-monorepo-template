import react from '@vitejs/plugin-react';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

const isVisualRun = process.argv.some((arg) => arg.includes('visual'));

if (isVisualRun && process.platform !== 'linux' && !process.env['ALLOW_HOST_SCREENSHOTS']) {
  throw new Error(
    'Visual tests must run inside the Playwright Docker image so baselines match CI. Use `pnpm visual` from the repo root.',
  );
}

// Фабрика, а не общий объект: Vitest мутирует instances (проставляет имена проектов).
const browser = () => ({
  enabled: true,
  headless: true,
  provider: playwright(),
  instances: [{ browser: 'chromium' as const }],
});

export default defineConfig({
  plugins: [react()],
  test: {
    // e59: пороги покрытия unit-проекта — компенсирующий контур слепой зоны мутаций (ADR 0022:
    // StrykerJS не активирует мутантов в browser mode). Значения — факт вниз до целого минус 2 п.п.
    // (ADR 0009): lines 100, branches 96.29, functions 100, statements 100. Считает шаг `test`
    // verify (--coverage в скрипте test пакета); замер и саботаж — backlog/done/e59.md.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.tsx'],
      thresholds: { lines: 98, branches: 94, functions: 98, statements: 98 },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.tsx'],
          exclude: ['src/**/*.visual.test.tsx'],
          browser: browser(),
        },
      },
      {
        extends: true,
        test: {
          name: 'visual',
          include: ['src/**/*.visual.test.tsx'],
          browser: {
            ...browser(),
            viewport: { width: 1280, height: 720 },
            expect: {
              toMatchScreenshot: {
                comparatorName: 'pixelmatch',
                comparatorOptions: { threshold: 0.1, allowedMismatchedPixelRatio: 0 },
                // Без суффикса платформы: базлайны существуют только для Linux-образа.
                resolveScreenshotPath: ({ root, testFileName, arg, browserName, ext }) =>
                  `${root}/src/__screenshots__/${testFileName}/${arg}-${browserName}${ext}`,
              },
            },
          },
        },
      },
    ],
  },
});
