import { serve } from '@hono/node-server';

import { createApp } from './app.ts';
import { connectTaskDatabase, migrateTaskDatabase } from './tasks/database.ts';
import { PostgresTaskRepository } from './tasks/postgres-repository.ts';
import { InMemoryTaskRepository, type TaskRepository } from './tasks/repository.ts';
import { loadServerEnv, resolveServerStorage } from './server-config.ts';

// Окружение валидируется в server-config.ts — единственном читателе env в
// apps/api (C3.0): невалидное окружение роняет старт со списком переменных.
const env = loadServerEnv();

// DATABASE_URL включает Postgres; решение с guard'ом опасной комбинации —
// в server-config.ts (там же объяснение). Дефолт — in-memory: pnpm dev,
// E2E и перф не требуют Docker до задачи C1.5.
const storage = resolveServerStorage(env);

let tasks: TaskRepository;
if (storage.kind === 'postgres') {
  const database = await connectTaskDatabase(storage.connectionString);
  // Миграции применяются на старте: поднятый сервер всегда соответствует схеме.
  await migrateTaskDatabase(database.db);
  console.warn('api storage: postgres (migrations applied)');
  tasks = new PostgresTaskRepository({ db: database.db });
} else {
  tasks = new InMemoryTaskRepository();
}

const app = createApp({
  tasks,
  enableTestApi: env.enableTestApi,
  // exactOptionalPropertyTypes: undefined нельзя передавать явно.
  ...(env.instanceId === undefined ? {} : { instanceId: env.instanceId }),
});

// Хост — из окружения (server-config.ts): локально 127.0.0.1 (URL гейтов —
// 127.0.0.1, localhost двусмысленен: Node любит ::1), в контейнере 0.0.0.0.
const server = serve({ fetch: app.fetch, port: env.port, hostname: env.host }, (info) => {
  console.warn(`api listening on http://${env.host}:${info.port}`);
});

// SIGTERM — docker stop, SIGINT — Ctrl+C: слушатель закрывается, активные
// запросы доигрывают; принудительный таймаут — дело оркестратора (docker -t).
const shutdown = (signal: string): void => {
  console.warn(`api received ${signal}, closing`);
  server.close(() => process.exit(0));
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
