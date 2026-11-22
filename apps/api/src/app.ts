import { OpenAPIHandler } from '@orpc/openapi/fetch';
import { RPCHandler } from '@orpc/server/fetch';
import type { AnyRouter } from '@orpc/server';
import {
  TaskIdInputSchema,
  TaskSchema,
  WORKSPACE_HEADER,
  ERROR_MESSAGES,
  parseWorkspaceId,
} from '@repo/contracts';
import { bodyLimit } from 'hono/body-limit';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { randomUUID } from 'node:crypto';
import * as z from 'zod';

import type { Actor, AppContext } from './authorization.ts';
import { proceduresWithoutAuthorization } from './authorization.ts';
import {
  createLogBuffer,
  createLogger,
  isSafeRequestId,
  requestIdOf,
  serializeError,
  type LogSink,
} from './observability.ts';
import { router as defaultRouter } from './router.ts';
import { assertTestApiNotInProduction } from './server-config.ts';
import type { TaskRepository } from './tasks/repository.ts';

/**
 * Потолок тела и таймаут запроса (c1.7): произвольный JSON на /rpc и /api
 * не читается без границ. Значения — константы кода, а не env-ручки: потолок —
 * свойство контракта, а не настройка развёртывания (решение c1.7). Условие
 * возврата: реальному потребителю понадобится другой потолок — заводим
 * переменную окружения с валидацией в env-модуле (server-config.ts).
 * bodyLimit: заголовок задачи ограничен 200 символами — МиБ с запасом.
 * Таймаут больше statement_timeout пула (tasks/database.ts): медленная СУБД
 * сначала отвечает ошибкой через oRPC, 504 остаётся зависаниям вне БД.
 */
export const REQUEST_BODY_LIMIT_BYTES = 1_048_576;
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Гонка «обработчик vs таймер»: ответ ограничен по времени, даже если
 * обработчик завис. Сам обработчик при победе таймера не прерывается —
 * RPCHandler этой версии oRPC сигнал не принимает; работу в БД добивает
 * statement_timeout пула (tasks/database.ts), так что вечно не висит (c1.7).
 * Проигравшая гонкой ветка продолжает слушаться Promise.race: её поздний
 * отказ не становится unhandledRejection.
 */
function requestTimeout(ms: number) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<Response>((resolve) => {
      timer = setTimeout(() => resolve(c.json({ error: 'Request timed out' }, 504)), ms);
    });
    try {
      return await Promise.race([next(), expired]);
    } finally {
      clearTimeout(timer);
    }
  };
}

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
   * Никогда не включается в production: двойной guard — loadServerEnv
   * и проверка внутри createApp (c1.7).
   */
  enableTestApi?: boolean;
  /**
   * Идентификатор прогона e2e для `/health` (З9, A5): global setup Playwright
   * сверяет его с токеном прогона, чтобы тест не смотрел в чужой сервер.
   */
  instanceId?: string;
  /**
   * Приёмник структурного лога (C4.1): по записи на событие, JSON на stdout.
   * Тесты подменяют коллектирующим sink-ом; тела запросов не логируются.
   */
  log?: LogSink;
  /** З13: генерация requestId и время приходят через параметры. */
  generateRequestId?: () => string;
  now?: () => Date;
  /**
   * Потолок тела запроса в байтах (c1.7). Дефолт — константа ниже; инъекция —
   * для тестов мидлвари, не env-ручка: потолок — свойство контракта
   * (решение c1.7).
   */
  bodyLimitBytes?: number;
  /**
   * Таймаут запроса в миллисекундах (c1.7); дефолт — константа ниже.
   * Инъекция — для тестов мидлвари: дефолтный таймаут в тесте ждал бы секунд.
   */
  requestTimeoutMs?: number;
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
  log: logSink,
  generateRequestId = randomUUID,
  now = () => new Date(),
  bodyLimitBytes = REQUEST_BODY_LIMIT_BYTES,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
}: AppOptions) {
  // Дубль-guard тестового API (c1.7): loadServerEnv — первый рубеж, этот —
  // второй для входов мимо него. До любых маршрутов: приложение с /__test__/*
  // в production не поднимается вовсе.
  assertTestApiNotInProduction(enableTestApi);

  // Подменённый роутер без мидлвари отдал бы процедуры мимо авторизации:
  // падаем на старте, а не молча обслуживаем (ревью безопасности C2.2).
  const bypassed = proceduresWithoutAuthorization(router);
  if (bypassed.length > 0) {
    throw new Error(
      `Router procedures without the authorization middleware: ${bypassed.join(', ')}`,
    );
  }

  // Кольцевой буфер лога (C4): только с тест-API (в проде ENABLE_TEST_API
  // запрещён на старте — server-config.ts). Записи 'unhandled' могут нести
  // данные запроса (см. onError ниже) — буфер живёт и отдаётся ровно так же
  // недолго и локально, как сам тест-API, ретенции у него нет.
  const logBuffer = enableTestApi ? createLogBuffer() : null;
  const sink: LogSink | undefined =
    logBuffer === null
      ? logSink
      : (record) => {
          logSink?.(record);
          logBuffer.write(record);
        };

  const log = createLogger({
    ...(sink === undefined ? {} : { sink }),
    now,
  });

  const app = new Hono<{ Variables: { requestId: string } }>();

  // Структурный лог и идентификатор запроса (C4.1): id из заголовка безопасной
  // формы или свежий uuid; возвращается в ответе и попадает в каждое событие
  // запроса. Путь — без query (токен из ?token= не должен дойти до лога),
  // тела не читаются и не логируются.
  app.use('*', async (c, next) => {
    const requestId = requestIdOf(c.req.raw, generateRequestId);
    c.set('requestId', requestId);
    const startedAtMs = now().getTime();

    await next();

    c.res.headers.set('x-request-id', requestId);
    const path = new URL(c.req.raw.url).pathname;
    const status = c.res.status;
    const level = status < 400 ? 'info' : 'warn';
    log(level, 'request', {
      requestId,
      method: c.req.method,
      path,
      status,
      durationMs: now().getTime() - startedAtMs,
    });
  });

  // Непойманное (мимо oRPC: тестовый API, Hono-маршруты) — событие с явно
  // сериализованной ошибкой; наружу уходит только статичный текст каталога.
  // Внимание: message/stack непойманного могут нести данные запроса (текст
  // DB-ошибки, snippet парсера) — записи 'unhandled' считать потенциально
  // чувствительными при появлении ретенции/выгрузки логов. Тело ответа —
  // не форма oRPC-ошибок (эти маршруты вне openapi): у задокументированных
  // операций 500 отдаёт механизм oRPC с текстом каталога.
  app.onError((error, c) => {
    log('error', 'unhandled', {
      requestId: c.get('requestId'),
      method: c.req.method,
      path: new URL(c.req.raw.url).pathname,
      error: serializeError(error),
    });
    return c.json({ error: ERROR_MESSAGES.INTERNAL }, 500);
  });

  const buildContext = (request: Request): AppContext => ({
    tasks,
    actor: resolveActor ? resolveActor(request) : null,
    ownerOf: ownerOfThroughRepository(tasks),
    // Рабочее пространство запроса (ADR 0020): отсутствующий или невалидный
    // заголовок — «ничей» scope, поведение продуктовых клиентов не меняется.
    workspaceId: parseWorkspaceId(request.headers.get(WORKSPACE_HEADER)),
  });
  const rpcHandler = new RPCHandler(router);
  const openApiHandler = new OpenAPIHandler(router);

  // Без CORS (ADR 0005): браузер ходит в `/rpc` своего web-сервера (один
  // origin), остальные клиенты API (k6, фикстуры, OpenAPI) — не браузерные.

  // Границы произвольного JSON (c1.7): тело сверх потолка — 413 до чтения
  // (hono-мидлварь проверяет content-length и стрим), зависший обработчик —
  // 504 по таймеру. Тексты статичные, без данных запроса — как каталог
  // ошибок (C4.1); операции oRPC эти ответы не объявляют — это слой HTTP
  // до транспорта.
  const bodyLimitGuard = bodyLimit({
    maxSize: bodyLimitBytes,
    onError: (c) => c.json({ error: 'Payload too large' }, 413),
  });
  const timeoutGuard = requestTimeout(requestTimeoutMs);

  app.get('/health', (c) => c.json({ status: 'ok', instance: instanceId ?? null }));

  app.use('/rpc/*', bodyLimitGuard, timeoutGuard);
  app.use('/api/*', bodyLimitGuard, timeoutGuard);

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

  // logBuffer !== null ⇔ enableTestApi: буфер создаётся только с тест-API.
  if (logBuffer !== null) {
    // strictObject вместо z.object (c1.7): z.object молча стрипает лишние
    // ключи, и опечатка в e2e-фикстуре сидировала бы «почти то, что задумано».
    // Форма задачи переиспользует shape контракта: seed-задача — та же Task.
    const ResetBodySchema = z.strictObject({
      tasks: z.strictObject(TaskSchema.shape).array(),
    });
    const RequestIdsSchema = z
      .array(z.string())
      .min(1)
      .refine((ids) => ids.every(isSafeRequestId));

    app.use('/__test__/*', bodyLimitGuard, timeoutGuard);

    app.post('/__test__/reset', async (c) => {
      const body: unknown = await c.req.json().catch(() => undefined);
      const parsed = ResetBodySchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: 'Invalid seed data', issues: parsed.error.issues }, 400);
      }
      // С workspace-заголовком seed заменяет содержимое одного рабочего
      // пространства (изоляция параллельных E2E-сценариев, ADR 0020); без него
      // — легаси-глобальный сброс для точечных сценариев. Осторожно: глобальный
      // сброс при параллельном прогоне стирает данные соседних workspace.
      const workspaceId = parseWorkspaceId(c.req.raw.headers.get(WORKSPACE_HEADER));
      await tasks.reset(parsed.data.tasks, workspaceId ?? undefined);
      return c.body(null, 204);
    });

    // Срез лога по идентификаторам запроса (C4): фикстура E2E собирает
    // x-request-id из ответов сценария и здесь забирает только его записи —
    // логи падения не смешиваются с соседними параллельными тестами.
    app.get('/__test__/logs', (c) => {
      const parsed = RequestIdsSchema.safeParse(c.req.queries('requestId'));
      if (!parsed.success) {
        return c.json({ error: 'Invalid requestId query', issues: parsed.error.issues }, 400);
      }
      const wanted = new Set(parsed.data);
      const records = logBuffer
        .records()
        .filter(
          (record) => typeof record['requestId'] === 'string' && wanted.has(record['requestId']),
        );
      return c.json({ records });
    });
  }

  return app;
}
