import { fileURLToPath } from 'node:url';

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

const migrationsFolder = fileURLToPath(new URL('./migrations/', import.meta.url));

export interface TaskDatabase {
  db: NodePgDatabase;
  close(): Promise<void>;
}

/**
 * Пул подключений + drizzle поверх него. Вызывающий закрывает через `close()`.
 * Строку подключения задаёт DATABASE_URL (server.ts) или контейнер теста.
 * Опция `{ schema }` не нужна: репозиторий обращается к таблицам через
 * явный `schema.tasks`, а не через relational `db.query`.
 */
export async function connectTaskDatabase(connectionString: string): Promise<TaskDatabase> {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool);
  return { db, close: () => pool.end() };
}

/** Применяет миграции из src/tasks/migrations; идемпотентно, по журналу drizzle. */
export function migrateTaskDatabase(db: NodePgDatabase): Promise<void> {
  return migrate(db, { migrationsFolder });
}
