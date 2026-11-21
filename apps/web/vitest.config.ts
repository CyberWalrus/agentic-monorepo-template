import react from '@vitejs/plugin-react';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    // b2.3: пороги только для node-части (чистые модули b2.1): .tsx-компоненты
    // покрывает браузерный проект, они вне включения.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/routeTree.gen.ts'],
      thresholds: { lines: 78, branches: 86, functions: 62, statements: 78 },
    },
    projects: [
      {
        extends: true,
        test: { name: 'node', include: ['src/**/*.test.ts'], environment: 'node' },
      },
      {
        extends: true,
        test: {
          name: 'browser',
          include: ['src/**/*.test.tsx'],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});
