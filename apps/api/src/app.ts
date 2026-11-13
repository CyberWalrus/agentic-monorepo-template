import { OpenAPIHandler } from '@orpc/openapi/fetch';
import { RPCHandler } from '@orpc/server/fetch';
import { TaskSchema } from '@repo/contracts';
import { Hono } from 'hono';
import * as z from 'zod';

import { router } from './router.ts';
import type { TaskRepository } from './tasks/repository.ts';

export interface AppOptions {
  tasks: TaskRepository;
  /**
   * Включает `/__test__/*` для подготовки данных в E2E.
   * Никогда не включается в production: см. `server.ts`.
   */
  enableTestApi?: boolean;
  /**
   * Идентификатор прогона e2e для `/health` (З9, A5): global setup Playwright
   * сверяет его с токеном прогона, чтобы тест не смотрел в чужой сервер.
   */
  instanceId?: string;
}

export function createApp({ tasks, enableTestApi = false, instanceId }: AppOptions) {
  const app = new Hono();
  const context = { tasks };
  const rpcHandler = new RPCHandler(router);
  const openApiHandler = new OpenAPIHandler(router);

  // Без CORS (ADR 0005): браузер ходит в `/rpc` своего web-сервера (один
  // origin), остальные клиенты API (k6, фикстуры, OpenAPI) — не браузерные.

  app.get('/health', (c) => c.json({ status: 'ok', instance: instanceId ?? null }));

  app.use('/rpc/*', async (c, next) => {
    const { matched, response } = await rpcHandler.handle(c.req.raw, { prefix: '/rpc', context });
    if (matched) {
      return c.newResponse(response.body, response);
    }
    return next();
  });

  app.use('/api/*', async (c, next) => {
    const { matched, response } = await openApiHandler.handle(c.req.raw, {
      prefix: '/api',
      context,
    });
    if (matched) {
      return c.newResponse(response.body, response);
    }
    return next();
  });

  if (enableTestApi) {
    const ResetBodySchema = z.object({ tasks: TaskSchema.array() });

    app.post('/__test__/reset', async (c) => {
      const body: unknown = await c.req.json().catch(() => undefined);
      const parsed = ResetBodySchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: 'Invalid seed data', issues: parsed.error.issues }, 400);
      }
      await tasks.reset(parsed.data.tasks);
      return c.body(null, 204);
    });
  }

  return app;
}
