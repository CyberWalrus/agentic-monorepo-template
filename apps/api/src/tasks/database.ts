import { fileURLToPath } from 'node:url';

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client, Pool } from 'pg';

// Путь миграций — один источник (З10 по духу): тесты изоляции передают его
// хелперу параметром, а не выводят заново отдельной строкой.
export const taskMigrationsFolder = fileURLToPath(new URL('./migrations/', import.meta.url));

// Сессионный advisory-лок миграций (c1.6). Значение закреплено литералом, а не
// вычисляется при старте: ключ обязан быть одинаковым во всех репликах и во
// всех версиях кода — реплики с разными ключами миграции не сериализуют.
// Значение — sha256('agentic-monorepo-template:tasks:migrations'), первые 13
// hex-символов числом (< 2**53); имя исключает пересечение с другими
// advisory-локами этой базы. Тест миграций повторяет число литералом нарочно:
// смена ключа в коде красит тест.
const taskMigrationsAdvisoryLockKey = 2344743159247074;

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

/** Применяет миграции из taskMigrationsFolder; идемпотентно, по журналу drizzle. */
export function migrateTaskDatabase(db: NodePgDatabase): Promise<void> {
  return migrate(db, { migrationsFolder: taskMigrationsFolder });
}

/**
 * То же, что `migrateTaskDatabase`, но под сессионным `pg_advisory_lock` на
 * выделенном соединении (c1.6). `migrate` drizzle 0.45 лока не берёт: две
 * реплики, стартовавшие одновременно против пустой базы, обе решат «миграций
 * нет» и вторая упадёт на `CREATE TABLE`. Лок и DDL живут в одной сессии
 * (drizzle поверх одиночного `Client`), поэтому:
 * - параллельный старт сериализуется: второй ждёт `pg_advisory_lock`, видит
 *   свежий журнал и не повторяет DDL;
 * - снятие гарантировано `finally`, и его дублирует сам Postgres: сессионный
 *   лок уходит при закрытии соединения, в том числе при падении процесса.
 * Соединение закрывается в любом исходе — миграция разовая, пула ей не нужно.
 */
export async function migrateTaskDatabaseExclusively(connectionString: string): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [taskMigrationsAdvisoryLockKey]);
    try {
      await migrate(drizzle(client), { migrationsFolder: taskMigrationsFolder });
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [taskMigrationsAdvisoryLockKey]);
    }
  } finally {
    await client.end();
  }
}
