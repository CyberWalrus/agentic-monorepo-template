import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  connectTaskDatabase,
  migrateTaskDatabase,
  migrateTaskDatabaseExclusively,
  taskMigrationsFolder,
} from '../src/tasks/database.ts';

import {
  createPostgresTestDatabase,
  POSTGRES_TEST_IMAGE,
  type PostgresTestDatabase,
} from './test-database.ts';

// Таймауты на уровне файла: **/vitest.config.ts защищён, дефолтный
// hookTimeout Vitest (10 с) холодный старт контейнера не проходит —
// особенно в CI, где образ ещё не в кэше демона (как в C1.2).
const CONTAINER_TIMEOUT_MS = 120_000;
// Столько файлов миграций в taskMigrationsFolder: журнал после полного
// применения обязан содержать ровно столько записей (ровно один раз).
const MIGRATION_COUNT = 2;
// Грэйс негативного утверждения «миграция ещё не началась»: покуда держатель
// не отпустил advisory-лок, мигратор не может пойти дальше — это свойство
// Postgres, а не тайминг. 500 мс достаточно соединению установиться.
const LOCK_GRACE_MS = 500;
// Ключ advisory-лока из src/tasks/database.ts повторён литералом нарочно
// (c1.6): тест закрепляет значение как контракт. Смена ключа в коде красит
// этот тест — реплики с разными ключами миграции не сериализуют.
const LOCK_KEY = 2344743159247074n;

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

/** Сколько миграций журнал drizzle считает применёнными в этой базе. */
async function appliedMigrations(connectionString: string): Promise<number> {
  const connection = await connectTaskDatabase(connectionString);
  try {
    const result = await connection.db.execute<{ count: number }>(
      sql`select count(*)::int as count from drizzle.__drizzle_migrations`,
    );
    return result.rows[0]?.['count'] ?? 0;
  } finally {
    await connection.close();
  }
}

describe('migrateTaskDatabaseExclusively', () => {
  it(
    'lets two parallel starts succeed against an empty database, applying each migration exactly once',
    async () => {
      const empty = await taskDatabase().createEmptyDatabase();
      try {
        await expect(
          Promise.all([
            migrateTaskDatabaseExclusively(empty.connectionString),
            migrateTaskDatabaseExclusively(empty.connectionString),
          ]),
        ).resolves.toEqual([undefined, undefined]);

        // Оба старта зелёные и журнал честный: вторая реплика дождалась лока,
        // увидела применённые миграции и ничего не добавила.
        expect(await appliedMigrations(empty.connectionString)).toBe(MIGRATION_COUNT);
      } finally {
        await empty.close();
      }
    },
    CONTAINER_TIMEOUT_MS,
  );

  it(
    'waits for an external holder of the pinned advisory lock key instead of racing it',
    async () => {
      const empty = await taskDatabase().createEmptyDatabase();
      const holder = await connectTaskDatabase(empty.connectionString);
      try {
        // Чужой держатель того же ключа — реплика из другой версии кода.
        await holder.db.execute(sql`select pg_advisory_lock(${LOCK_KEY})`);

        const migration = migrateTaskDatabaseExclusively(empty.connectionString);

        // Держатель ещё не отпустил: миграция обязана ждать, а не упасть на DDL.
        // Гонка миграции с грэйсом: если миграция уложилась в грэйс, лок не
        // сработал — это и есть красный тест (свойство Postgres, не тайминг).
        const settledWithinGrace = await Promise.race([
          migration.then(() => 'settled' as const),
          new Promise<undefined>((resolveGrace) => {
            setTimeout(() => resolveGrace(undefined), LOCK_GRACE_MS);
          }),
        ]);
        expect(settledWithinGrace).toBeUndefined();

        await holder.db.execute(sql`select pg_advisory_unlock(${LOCK_KEY})`);
        await migration;
      } finally {
        await holder.close();
        await empty.close();
      }
    },
    CONTAINER_TIMEOUT_MS,
  );

  it(
    'applies nothing new on an already migrated database',
    async () => {
      const empty = await taskDatabase().createEmptyDatabase();
      try {
        await migrateTaskDatabaseExclusively(empty.connectionString);
        const afterFirst = await appliedMigrations(empty.connectionString);

        // Повторный старт (рестарт реплики): журнал не растёт.
        await migrateTaskDatabaseExclusively(empty.connectionString);

        expect(await appliedMigrations(empty.connectionString)).toBe(afterFirst);
        expect(afterFirst).toBe(MIGRATION_COUNT);
      } finally {
        await empty.close();
      }
    },
    CONTAINER_TIMEOUT_MS,
  );
});
