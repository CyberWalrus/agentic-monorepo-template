import { serve } from '@hono/node-server';

import { createApp } from './app.ts';
import { InMemoryTaskRepository } from './tasks/repository.ts';

const port = Number(process.env['PORT'] ?? 3001);
const webOrigin = process.env['WEB_ORIGIN'] ?? 'http://localhost:3000';
const enableTestApi = process.env['ENABLE_TEST_API'] === '1';

if (enableTestApi && process.env['NODE_ENV'] === 'production') {
  throw new Error('ENABLE_TEST_API must never be set in production');
}

const app = createApp({ tasks: new InMemoryTaskRepository(), webOrigin, enableTestApi });

serve({ fetch: app.fetch, port }, (info) => {
  console.warn(`api listening on http://localhost:${info.port}`);
});
