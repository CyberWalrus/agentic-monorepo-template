import { defineConfig } from 'vitest/config';

/**
 * Node-проект для тестов гейтов и хуков агента (tools/test/).
 * Отдельно от задач Turborepo: корневой workspace не участвует в `turbo run test`
 * (для корневых задач нужен синтаксис `#task`), поэтому шаг называется `test:hooks`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tools/test/**/*.test.ts'],
  },
});
