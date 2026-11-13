import { serve } from '@hono/node-server';

import { createApp } from './app.ts';
import { InMemoryTaskRepository } from './tasks/repository.ts';

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

const app = createApp({
  tasks: new InMemoryTaskRepository(),
  enableTestApi,
  // exactOptionalPropertyTypes: undefined нельзя передавать явно.
  ...(instanceId === undefined ? {} : { instanceId }),
});

// host фиксирован: URL гейтов — 127.0.0.1 (tools/ports.ts), localhost
// двусмысленен (Node любит ::1, слушатель может оказаться только на IPv4).
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  console.warn(`api listening on http://127.0.0.1:${info.port}`);
});
