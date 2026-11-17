import { OpenAPIHandler } from '@orpc/openapi/fetch';
import { RPCHandler } from '@orpc/server/fetch';
import type { AnyRouter } from '@orpc/server';
import { TaskIdInputSchema, TaskSchema } from '@repo/contracts';
import { Hono } from 'hono';
import * as z from 'zod';

import type { Actor, AppContext } from './authorization.ts';
import { proceduresWithoutAuthorization } from './authorization.ts';
import { router as defaultRouter } from './router.ts';
import type { TaskRepository } from './tasks/repository.ts';

export interface AppOptions {
  tasks: TaskRepository;
  /**
   * Роутер для обработчиков RPC и OpenAPI. По умолчанию — реальный router;
   * подменяется только в тестах транспортов на фикстурном контракте.
   */
  router?: AnyRouter;
  /**
   * Кто действует в этом запросе. Аутентификации в шаблоне ещё нет:
   * по умолчанию актора нет (null), источник появится с реальной
   * аутентификацией. Тесты подменяют, чтобы гонять акторов по HTTP.
   */
  resolveActor?: (request: Request) => Actor | null;
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

/**
 * Порт «владелец ресурса процедуры» на репозитории задач (C2.3): владелец
 * читается по id из input. Незнакомая форма input — null: политика «owner»
 * отвечает отказом (fail-closed), как и для задачи без владельца. При второй
 * owner-области диспетчеризация переезжает с формы input на путь процедуры
 * (мидлварь уже держит procedure; условие возврата C2.2).
 */
function ownerOfThroughRepository(tasks: TaskRepository): AppContext['ownerOf'] {
  return async (input) => {
    const parsed = TaskIdInputSchema.safeParse(input);
    if (!parsed.success) {
      return null;
    }
    return tasks.ownerOf(parsed.data.id);
  };
}

export function createApp({
  tasks,
  router = defaultRouter,
  resolveActor,
  enableTestApi = false,
  instanceId,
}: AppOptions) {
  // Подменённый роутер без мидлвари отдал бы процедуры мимо авторизации:
  // падаем на старте, а не молча обслуживаем (ревью безопасности C2.2).
  const bypassed = proceduresWithoutAuthorization(router);
  if (bypassed.length > 0) {
    throw new Error(
      `Router procedures without the authorization middleware: ${bypassed.join(', ')}`,
    );
  }

  const app = new Hono();
  const buildContext = (request: Request): AppContext => ({
    tasks,
    actor: resolveActor ? resolveActor(request) : null,
    ownerOf: ownerOfThroughRepository(tasks),
  });
  const rpcHandler = new RPCHandler(router);
  const openApiHandler = new OpenAPIHandler(router);

  // Без CORS (ADR 0005): браузер ходит в `/rpc` своего web-сервера (один
  // origin), остальные клиенты API (k6, фикстуры, OpenAPI) — не браузерные.

  app.get('/health', (c) => c.json({ status: 'ok', instance: instanceId ?? null }));

  app.use('/rpc/*', async (c, next) => {
    const { matched, response } = await rpcHandler.handle(c.req.raw, {
      prefix: '/rpc',
      context: buildContext(c.req.raw),
    });
    if (matched) {
      return c.newResponse(response.body, response);
    }
    return next();
  });

  app.use('/api/*', async (c, next) => {
    const { matched, response } = await openApiHandler.handle(c.req.raw, {
      prefix: '/api',
      context: buildContext(c.req.raw),
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
