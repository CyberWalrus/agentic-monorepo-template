import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  connectTaskDatabase,
  TASK_POOL_OPTIONS,
  taskMigrationsFolder,
} from '../src/tasks/database.ts';

import {
  createPostgresTestDatabase,
  POSTGRES_TEST_IMAGE,
  type PostgresTestDatabase,
} from './test-database.ts';

// Таймауты на уровне файла: **/vitest.config.ts защищён, дефолтный
// hookTimeout Vitest (10 с) холодный старт контейнера не проходит (как в C1.2).
const CONTAINER_TIMEOUT_MS = 120_000;

let database: PostgresTestDatabase | undefined;

beforeAll(async () => {
  database = await createPostgresTestDatabase({
    image: POSTGRES_TEST_IMAGE,
    migrationsFolder: taskMigrationsFolder,
    migrate: () => Promise.resolve(),
  });
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  // beforeAll может упасть до присвоения (Docker недоступен): не добавляем
  // к его объяснению криптичную ошибку очистки (rev test-quality 2026-11-15).
  if (database !== undefined) {
    await database.close();
  }
});

// Доступ к базе из проверок: beforeAll к этому моменту отработал.
function taskDatabase(): PostgresTestDatabase {
  if (database === undefined) {
    throw new Error('beforeAll did not start the Postgres test database');
  }
  return database;
}

describe('connectTaskDatabase pool options', () => {
  it(
    'applies the statement timeout on the server side, so the database itself cuts off a hung query',
    async () => {
      const connection = await connectTaskDatabase(taskDatabase().connectionString);
      try {
        // SHOW читает сессионное значение: Pool обязан передать
        // statement_timeout каждому клиенту (c1.7).
        const result = await connection.db.execute<{ statement_timeout: string }>(
          sql`show statement_timeout`,
        );
        expect(result.rows[0]?.['statement_timeout']).toBe(
          `${TASK_POOL_OPTIONS.statement_timeout / 1000}s`,
        );
      } finally {
        await connection.close();
      }
    },
    CONTAINER_TIMEOUT_MS,
  );
});
