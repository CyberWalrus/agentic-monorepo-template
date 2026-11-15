import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import {
  connectTaskDatabase,
  migrateTaskDatabase,
  type TaskDatabase,
} from '../../src/tasks/database.ts';
import { PostgresTaskRepository } from '../../src/tasks/postgres-repository.ts';
import * as schema from '../../src/tasks/schema.ts';

import { taskRepositoryContractChecks } from './contract.ts';

// Таймауты на уровне файла: **/vitest.config.ts защищён, дефолтный
// hookTimeout Vitest (10 с) холодный старт контейнера не проходит —
// особенно в CI, где образ ещё не в кэше демона.
const CONTAINER_TIMEOUT_MS = 120_000;

// Digest закреплён (решение c1.2): прогон воспроизводим. Порт контейнера
// случайный — два worktree не пересекаются (З9). Контейнер поднимает сам
// тест (Решение c1.2): внешний сервис и services: в CI отклонены.
const POSTGRES_IMAGE =
  'postgres:17-alpine@sha256:d3244e8ce3f165ee3c93d9c4a4b1d0fe48b3a89e2287b717fdcbbde92d405065';

let container: StartedPostgreSqlContainer;
let database: TaskDatabase;

beforeAll(async () => {
  try {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withStartupTimeout(CONTAINER_TIMEOUT_MS)
      .start();
  } catch (error) {
    throw new Error(
      'Не удалось запустить контейнер Postgres: набору TaskRepository на Postgres нужен работающий Docker (образ postgres:17-alpine тест поднимает сам). Запусти Docker и повтори.',
      { cause: error },
    );
  }
  database = await connectTaskDatabase(container.getConnectionUri());
  // Миграции применяются автоматически — критерий приёмки c1.2.
  await migrateTaskDatabase(database.db);
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await database.close();
  await container.stop();
});

// Прогон контрактного набора C1.1 против Postgres-реализации. Каждая
// проверка получает свежий изолированный экземпляр: таблица чистится
// перед созданием репозитория.
describe('TaskRepository contract: PostgresTaskRepository', () => {
  it.each(taskRepositoryContractChecks)('$name', async ({ check }) => {
    await database.db.delete(schema.tasks);

    await expect(check(new PostgresTaskRepository({ db: database.db }))).resolves.toBeUndefined();
  });
});

// Реализационно-специфичное: инъекция часов и генератора идентификаторов
// (З13, детерминизм через параметры) и точность timestamptz на границе.
describe('PostgresTaskRepository', () => {
  it('creates a task with the injected id generator and clock', async () => {
    await database.db.delete(schema.tasks);
    const repository = new PostgresTaskRepository({
      db: database.db,
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
});
