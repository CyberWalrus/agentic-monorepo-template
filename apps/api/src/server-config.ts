/**
 * Решение по хранилищу на старте сервера — чистая функция с unit-тестами:
 * server.ts исключён из coverage и мутаций, а гард здесь защищает опасное
 * действие — `/__test__/reset` со срезанием настоящей базы.
 */
export interface ServerEnv {
  databaseUrl: string | undefined;
  enableTestApi: boolean;
  /** ENABLE_TEST_API_WITH_DATABASE=1 — явное подтверждение опасной комбинации. */
  testApiWithDatabase: boolean;
}

export type ServerStorage = { kind: 'memory' } | { kind: 'postgres'; connectionString: string };

/**
 * DATABASE_URL включает Postgres, иначе — in-memory (pnpm dev, E2E и перф
 * не требуют Docker до задачи C1.5). Сброс данных через test-API против
 * настоящей базы стирает её содержимое: комбинация требует отдельного
 * явного флага, молчаливого включения нет.
 */
export function resolveServerStorage(env: ServerEnv): ServerStorage {
  if (env.databaseUrl === undefined || env.databaseUrl === '') {
    return { kind: 'memory' };
  }
  if (env.enableTestApi && !env.testApiWithDatabase) {
    throw new Error(
      'ENABLE_TEST_API=1 with DATABASE_URL must also set ENABLE_TEST_API_WITH_DATABASE=1: /__test__/reset wipes the real database',
    );
  }
  return { kind: 'postgres', connectionString: env.databaseUrl };
}
