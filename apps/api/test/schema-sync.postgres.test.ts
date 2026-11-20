import { sql } from 'drizzle-orm';
import { pushSchema } from 'drizzle-kit/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateTaskDatabase, taskMigrationsFolder } from '../src/tasks/database.ts';
import * as schema from '../src/tasks/schema.ts';

import {
  createPostgresTestDatabase,
  POSTGRES_TEST_IMAGE,
  type PostgresTestDatabase,
} from './test-database.ts';

// Таймауты на уровне файла: **/vitest.config.ts защищён, дефолтный
// hookTimeout Vitest (10 с) холодный старт контейнера не проходит —
// особенно в CI, где образ ещё не в кэше демона.
const CONTAINER_TIMEOUT_MS = 120_000;

// Вторая волна гейта «схема совпадает с миграциями» (c1.3, ADR 0017):
// база здесь — применение всех миграций с нуля (хелпер c1.4 применяет их
// к базе-шаблону), и drizzle-kit pushSchema сверяет её со схемой кода.
// Файловая волна (src/tasks/schema-sync.ts) снапшоты не видит сквозь
// ручной SQL; эта — видит.
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

describe('schema-sync: миграции с нуля совпадают со схемой кода', () => {
  it('после применения всех миграций pushSchema не находит расхождений с schema.ts', async () => {
    const { db } = taskDatabase();

    const diff = await pushSchema(schema, db);

    expect(diff.statementsToExecute).toEqual([]);
    expect(diff.hasDataLoss).toBe(false);
  });

  it('колонка, появившаяся в базе мимо миграций и схемы, красит проверку', async () => {
    const { db } = taskDatabase();
    await db.execute(sql`ALTER TABLE "tasks" ADD COLUMN "c13_orphan_probe" boolean`);
    try {
      const diff = await pushSchema(schema, db);

      expect(
        diff.statementsToExecute.some((statement) => statement.includes('c13_orphan_probe')),
      ).toBe(true);
    } finally {
      await db.execute(sql`ALTER TABLE "tasks" DROP COLUMN IF EXISTS "c13_orphan_probe"`);
    }
  });

  it('изменение данных без изменения схемы проверку не красит (data-only миграция)', async () => {
    const { db } = taskDatabase();
    // Ровно то, что делает expand/contract-шаг «наполнить данные»: форма
    // базы не меняется, и гейт формы обязан остаться зелёным.
    await db.execute(sql`
      INSERT INTO "tasks" ("id", "title", "completed", "created_at")
      VALUES ('00000000-0000-0000-0000-000000000001', 'c1.3 data-only probe', false, now())
    `);

    const diff = await pushSchema(schema, db);

    expect(diff.statementsToExecute).toEqual([]);
  });
});
