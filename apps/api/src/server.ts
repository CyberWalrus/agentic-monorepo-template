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

// host фиксирован: URL гейтов — 127.0.0.1 (tools/ports.ts), localhost
// двусмысленен (Node любит ::1, слушатель может оказаться только на IPv4).
serve({ fetch: app.fetch, port: env.port, hostname: '127.0.0.1' }, (info) => {
  console.warn(`api listening on http://127.0.0.1:${info.port}`);
});
