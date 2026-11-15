import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateTaskDatabase, taskMigrationsFolder } from '../../src/tasks/database.ts';
import { PostgresTaskRepository } from '../../src/tasks/postgres-repository.ts';
import * as schema from '../../src/tasks/schema.ts';

import {
  createPostgresTestDatabase,
  POSTGRES_TEST_IMAGE,
  type PostgresTestDatabase,
} from '../test-database.ts';

// Реализационно-специфичные тесты PostgresTaskRepository: инъекция часов и
// генератора идентификаторов (З13, детерминизм через параметры), точность
// timestamptz на границе и запись в постоянное хранилище. Второй
// integration-файл (рядом с контрактным набором): свой fork-воркер, своя
// база из шаблона — изоляция c1.4, локи не нужны.
const CONTAINER_TIMEOUT_MS = 120_000;

let database: PostgresTestDatabase | undefined;

beforeAll(async () => {
  database = await createPostgresTestDatabase({
    image: POSTGRES_TEST_IMAGE,
    migrationsFolder: taskMigrationsFolder,
    migrate: migrateTaskDatabase,
  });
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
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

describe('PostgresTaskRepository', () => {
  it('creates a task with the injected id generator and clock', async () => {
    const { db } = taskDatabase();
    await db.delete(schema.tasks);
    const repository = new PostgresTaskRepository({
      db,
      now: () => new Date('2026-11-01T10:00:00.000Z'),
      generateId: () => '00000000-0000-4000-8000-000000000001',
    });

    const task = await repository.create('Write tests');

    expect(task).toEqual({
      id: '00000000-0000-4000-8000-000000000001',
      title: 'Write tests',
      completed: false,
      createdAt: '2026-11-01T10:00:00.000Z',
    });
    expect((await repository.list()).map((stored) => stored.id)).toEqual([task.id]);
  });

  it('persists tasks across repository instances on the same database', async () => {
    const { db } = taskDatabase();
    await db.delete(schema.tasks);
    const writer = new PostgresTaskRepository({ db });
    const reader = new PostgresTaskRepository({ db });

    const created = await writer.create('Survives instances');

    // Экземпляр-читатель видит запись другого экземпляра: данные лежат в
    // хранилище, а не в памяти экземпляра (rev test-quality 2026-11-15).
    expect((await reader.list()).map((task) => task.id)).toEqual([created.id]);
    expect((await reader.toggle(created.id))?.completed).toBe(true);
    expect((await writer.list()).find((task) => task.id === created.id)?.completed).toBe(true);
  });
});
