import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateTaskDatabase, taskMigrationsFolder } from '../../src/tasks/database.ts';
import { PostgresTaskRepository } from '../../src/tasks/postgres-repository.ts';
import * as schema from '../../src/tasks/schema.ts';

import { taskRepositoryContractChecks } from './contract.ts';
import {
  createPostgresTestDatabase,
  POSTGRES_TEST_IMAGE,
  type PostgresTestDatabase,
} from '../test-database.ts';

// Таймауты на уровне файла: **/vitest.config.ts защищён, дефолтный
// hookTimeout Vitest (10 с) холодный старт контейнера не проходит —
// особенно в CI, где образ ещё не в кэше демона.
const CONTAINER_TIMEOUT_MS = 120_000;

// Изоляция c1.4: база на воркер из шаблона. Контрактный набор — один из
// двух integration-файлов, каждый идёт в своём fork-воркере со своей базой,
// поэтому чистка таблицы перед проверкой не задевает соседа и локи
// (SHARED_DATA_LOCK) на этом уровне не нужны. Схема и её обоснование —
// docs/test-database-isolation.md.
let database: PostgresTestDatabase | undefined;

beforeAll(async () => {
  database = await createPostgresTestDatabase({
    image: POSTGRES_TEST_IMAGE,
    migrationsFolder: taskMigrationsFolder,
    migrate: migrateTaskDatabase,
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

// Прогон контрактного набора C1.1 против Postgres-реализации. Каждая
// проверка получает свежий изолированный экземпляр: таблица чистится
// перед созданием репозитория.
describe('TaskRepository contract: PostgresTaskRepository', () => {
  it.each(taskRepositoryContractChecks)('$name', async ({ check }) => {
    const { db } = taskDatabase();
    await db.delete(schema.tasks);

    await expect(check(new PostgresTaskRepository({ db }))).resolves.toBeUndefined();
  });
});
