import { serve } from '@hono/node-server';

import { createApp } from './app.ts';
import { InMemoryTaskRepository } from './tasks/repository.ts';

const port = Number(process.env['PORT'] ?? 3001);
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

serve({ fetch: app.fetch, port }, (info) => {
  console.warn(`api listening on http://localhost:${info.port}`);
});
