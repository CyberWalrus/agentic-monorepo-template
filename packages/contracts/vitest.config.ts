import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // b2.3: пороги покрытия контрактов (значения — факт минус 2 п.п., ADR 0009).
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      thresholds: { lines: 98, branches: 98, functions: 98, statements: 98 },
    },
  },
});
