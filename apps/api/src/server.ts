import { serve } from '@hono/node-server';

import { createApp } from './app.ts';
import { connectTaskDatabase, migrateTaskDatabase } from './tasks/database.ts';
import { PostgresTaskRepository } from './tasks/postgres-repository.ts';
import { InMemoryTaskRepository, type TaskRepository } from './tasks/repository.ts';
import { resolveServerStorage } from './server-config.ts';

// Порт обязателен: его вычисляет tools/ports.ts (pnpm dev / e2e-конфиг / CI).
// Фиксированного дефолта нет — два worktree не должны делить порт (З9, A5).
const port = Number(process.env['PORT']);
if (!Number.isInteger(port) || port <= 0) {
  throw new Error(
    'PORT is empty or not a number: run through `pnpm dev`, the e2e webServer or `node tools/ports.ts --env`',
  );
}
const enableTestApi = process.env['ENABLE_TEST_API'] === '1';
// Идентификатор прогона e2e (З9, A5): без него /health отвечает instance: null,
// и global setup Playwright не пустит тесты против этого процесса.
const instanceId = process.env['INSTANCE_ID'];

if (enableTestApi && process.env['NODE_ENV'] === 'production') {
  throw new Error('ENABLE_TEST_API must never be set in production');
}

// DATABASE_URL включает Postgres; решение с guard'ом опасной комбинации —
// в server-config.ts (там же объяснение). Дефолт — in-memory: pnpm dev,
// E2E и перф не требуют Docker до задачи C1.5.
const storage = resolveServerStorage({
  databaseUrl: process.env['DATABASE_URL'],
  enableTestApi,
  testApiWithDatabase: process.env['ENABLE_TEST_API_WITH_DATABASE'] === '1',
});

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
  enableTestApi,
  // exactOptionalPropertyTypes: undefined нельзя передавать явно.
  ...(instanceId === undefined ? {} : { instanceId }),
});

// host фиксирован: URL гейтов — 127.0.0.1 (tools/ports.ts), localhost
// двусмысленен (Node любит ::1, слушатель может оказаться только на IPv4).
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  console.warn(`api listening on http://127.0.0.1:${info.port}`);
});
