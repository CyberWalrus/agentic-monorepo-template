import { once } from 'node:events';
import { connect } from 'node:net';

import { createORPCClient, ORPCError } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { oc } from '@orpc/contract';
import { implement } from '@orpc/server';
import type { ContractRouterClient } from '@orpc/contract';
import { serve } from '@hono/node-server';
import { contract, ocAccess, type Contract } from '@repo/contracts';
import * as z from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';

// e56: фикстуры провода, из которых строится спека. Скрипт контрактов, а не
// публичный экспорт: фикстуры описывают HTTP-слой, в контракт процедур не входят.
import {
  errorResponses,
  generateSpec,
  type WireResponse,
} from '../../../packages/contracts/scripts/openapi-spec.ts';
import { createApp, REQUEST_BODY_LIMIT_BYTES, REQUEST_TIMEOUT_MS } from './app.ts';
import { authorizationMiddleware, type Actor, type AppContext } from './authorization.ts';
import type { LogRecord, LogSink } from './observability.ts';
import { InMemoryTaskRepository } from './tasks/repository.ts';

const UNKNOWN_ID = '00000000-0000-4000-8000-999999999999';

const actorFromHeader = (request: Request): Actor | null => {
  const id = request.headers.get('x-actor-id');
  return id === null ? null : { id };
};

function setup({
  enableTestApi = false,
  instanceId,
  log,
  bodyLimitBytes,
  requestTimeoutMs,
  workspace,
}: {
  enableTestApi?: boolean;
  instanceId?: string;
  log?: LogSink;
  bodyLimitBytes?: number;
  requestTimeoutMs?: number;
  /** Заголовок `x-workspace-id` клиента (ADR 0020); undefined — запрос без заголовка. */
  workspace?: string;
} = {}) {
  const app = createApp({
    tasks: new InMemoryTaskRepository(),
    enableTestApi,
    // exactOptionalPropertyTypes: undefined нельзя передавать явно.
    ...(instanceId === undefined ? {} : { instanceId }),
    ...(log === undefined ? {} : { log }),
    ...(bodyLimitBytes === undefined ? {} : { bodyLimitBytes }),
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
  });
  const client: ContractRouterClient<Contract> = createORPCClient(
    new RPCLink({
      url: 'http://api.test/rpc',
      fetch: async (request) => app.fetch(request),
      ...(workspace === undefined ? {} : { headers: { 'x-workspace-id': workspace } }),
    }),
  );
  return { app, client };
}

const PROCEDURE_SITES = [
  { name: 'RPC', path: '/rpc/ping' },
  { name: 'OpenAPI', path: '/api/fixture/ping' },
] as const;

/**
 * Три места регистрации ограждений в `createApp` (e74): проверка формы, срок
 * и потолок обязаны стоять на каждом — таблица не даёт забыть одно из них.
 */
const GUARDED_SITES = [...PROCEDURE_SITES, { name: 'test API', path: '/__test__/reset' }] as const;

/** Тело объявлено заголовком, а поток запрос дать не может — для каждого места ограждений. */
const DECLARED_WITHOUT_STREAM = GUARDED_SITES.flatMap((site) => [
  { ...site, via: 'content-length', headers: { 'content-length': '11' } },
  { ...site, via: 'transfer-encoding', headers: { 'transfer-encoding': 'chunked' } },
]);

/**
 * Приложение на фикстурном роутере (e74): одна процедура без входной схемы —
 * шпион показывает, вызвана ли процедура. У процедур настоящего роутера вход
 * обязателен: пустое тело отбила бы валидация транспорта раньше обработчика.
 */
function setupGuards({
  bodyLimitBytes,
  requestTimeoutMs,
}: { bodyLimitBytes?: number; requestTimeoutMs?: number } = {}) {
  const ping = vi.fn<() => string>(() => 'pong');
  const fixtureContract = {
    ping: ocAccess
      .route({ method: 'POST', path: '/fixture/ping', summary: 'Answers at once' })
      .meta({ access: { type: 'public' } })
      .output(z.string()),
  };
  const os = implement(fixtureContract).$context<AppContext>().use(authorizationMiddleware);
  const tasks = new InMemoryTaskRepository();
  const reset = vi.spyOn(tasks, 'reset');
  const app = createApp({
    tasks,
    router: os.router({ ping: os.ping.handler(ping) }),
    enableTestApi: true,
    // exactOptionalPropertyTypes: ключ не передаётся вовсе, когда значение не введено.
    ...(bodyLimitBytes === undefined ? {} : { bodyLimitBytes }),
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
  });
  return {
    app,
    /** Ни одна процедура не вызвана: ни фикстурная, ни сброс тестового API. */
    expectNothingRan: () => {
      expect(ping).not.toHaveBeenCalled();
      expect(reset).not.toHaveBeenCalled();
    },
    ping,
  };
}

/**
 * Тело, которое клиент начал и не закончил; `release` закрывает поток —
 * проигравшая гонку ветка ограждений отпускается, висящих промисов тест не
 * оставляет.
 */
function stalledBody(): { stream: ReadableStream<Uint8Array>; release: () => void } {
  const gate: { release?: () => void } = {};
  const stream = new ReadableStream<Uint8Array>({
    // Клиент прислал заголовки и молчит: потолок ждёт первый байт тела.
    pull: (controller) =>
      new Promise<void>((resolve) => {
        gate.release = () => {
          controller.close();
          resolve();
        };
      }),
  });
  return { stream, release: () => gate.release?.() };
}

/**
 * Request с подменённым геттером `method` — так @hono/node-server собирает
 * TRACE: GET без потока. undici сам такой Request не даёт собрать: `new Request`
 * с методом TRACE бросает TypeError.
 */
function withMethod(request: Request, method: string): Request {
  Object.defineProperty(request, 'method', { value: method, configurable: true });
  return request;
}

/**
 * Настоящий адаптер на свободном порту: порт 0 выдаёт система, параллельные
 * прогоны не пересекаются.
 */
async function listen(app: ReturnType<typeof createApp>): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not report a TCP port');
  }
  return {
    port: address.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Сырой HTTP-обмен одним кадром: кадр пишется целиком, соединение клиент не
 * закрывает — ответ читается до закрытия соединения сервером. Страховка от
 * зависшего обмена — своя ошибка вместо таймаута Vitest. `firstByteAfterMs` —
 * сколько прошло от записи кадра до первого байта ответа (NaN — ответа не было).
 */
async function rawExchange(
  port: number,
  frame: string,
  watchdogMs: number,
): Promise<{ raw: string; firstByteAfterMs: number }> {
  const socket = connect(port, '127.0.0.1');
  return new Promise<{ raw: string; firstByteAfterMs: number }>((resolve, reject) => {
    const startedAt = performance.now();
    const received: Uint8Array[] = [];
    let firstByteAfterMs: number | undefined;
    socket.setTimeout(watchdogMs, () => {
      socket.destroy(new Error('raw exchange timed out'));
    });
    socket.on('data', (chunk: Buffer) => {
      firstByteAfterMs ??= performance.now() - startedAt;
      received.push(new Uint8Array(chunk));
    });
    socket.once('close', () => {
      resolve({
        raw: Buffer.concat(received).toString('utf8'),
        firstByteAfterMs: firstByteAfterMs ?? Number.NaN,
      });
    });
    socket.once('error', reject);
    socket.once('connect', () => socket.write(frame));
  });
}

describe('RPC transport', () => {
  it('creates, lists and toggles tasks through the typed client', async () => {
    const { client } = setup();

    const created = await client.tasks.create({ title: '  Ship it  ' });
    const toggled = await client.tasks.toggle({ id: created.id });
    const list = await client.tasks.list();

    expect(created.title).toBe('Ship it');
    expect(toggled.completed).toBe(true);
    expect(list).toEqual([toggled]);
  });

  it('rejects an empty title with a validation error', async () => {
    const { client } = setup();

    await expect(client.tasks.create({ title: '   ' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('returns a typed NOT_FOUND error with the catalog message for an unknown task', async () => {
    const { client } = setup();

    const error = await client.tasks.toggle({ id: UNKNOWN_ID }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code: 'NOT_FOUND', message: 'Resource not found' });
  });
});

describe('workspace scoping (ADR 0020)', () => {
  it('scopes RPC procedures to the workspace of the request header', async () => {
    const scoped = setup({ workspace: 'ws-a' });
    const ownerless = setup();

    const created = await scoped.client.tasks.create({ title: 'In workspace' });

    expect(await scoped.client.tasks.list()).toEqual([created]);
    // Запрос без заголовка — «ничей» scope: рабочие пространства невидимы.
    expect(await ownerless.client.tasks.list()).toEqual([]);
  });

  it('treats a malformed workspace header as the ownerless scope', async () => {
    const app = createApp({ tasks: new InMemoryTaskRepository(), enableTestApi: true });
    const clientWith = (workspace?: string): ContractRouterClient<Contract> =>
      createORPCClient(
        new RPCLink({
          url: 'http://api.test/rpc',
          fetch: async (request) => app.fetch(request),
          ...(workspace === undefined ? {} : { headers: { 'x-workspace-id': workspace } }),
        }),
      );
    const seeded = {
      id: '00000000-0000-4000-8000-000000000001',
      title: 'Ownerless',
      completed: false,
      createdAt: '2026-11-01T10:00:00.000Z',
    };
    await app.request('/__test__/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tasks: [seeded] }),
    });

    // Мусорный заголовок не становится ключом данных: тот же «ничей» scope,
    // что и у запроса без заголовка (ADR 0020).
    expect(await clientWith('bad value with spaces').tasks.list()).toEqual([seeded]);
    expect(await clientWith().tasks.list()).toEqual([seeded]);
    expect(await clientWith('ws-a').tasks.list()).toEqual([]);
  });

  it('seeds into the workspace of the reset header and leaves other scopes intact', async () => {
    const tasks = new InMemoryTaskRepository();
    const app = createApp({ tasks, enableTestApi: true });
    const clientFor = (workspace?: string): ContractRouterClient<Contract> =>
      createORPCClient(
        new RPCLink({
          url: 'http://api.test/rpc',
          fetch: async (request) => app.fetch(request),
          ...(workspace === undefined ? {} : { headers: { 'x-workspace-id': workspace } }),
        }),
      );
    const seeded = {
      id: '00000000-0000-4000-8000-000000000001',
      title: 'Seeded',
      completed: false,
      createdAt: '2026-11-01T10:00:00.000Z',
    };

    const response = await app.request('/__test__/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workspace-id': 'ws-a' },
      body: JSON.stringify({ tasks: [seeded] }),
    });

    expect(response.status).toBe(204);
    expect(await clientFor('ws-a').tasks.list()).toEqual([seeded]);
    // Соседнее рабочее пространство и «ничей» scope ничего не видят.
    expect(await clientFor('ws-b').tasks.list()).toEqual([]);
    expect(await clientFor().tasks.list()).toEqual([]);
  });

  it('keeps the headerless reset a global wipe for point scenarios', async () => {
    const scoped = setup({ enableTestApi: true, workspace: 'ws-a' });
    await scoped.app.request('/__test__/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workspace-id': 'ws-a' },
      body: JSON.stringify({
        tasks: [
          {
            id: '00000000-0000-4000-8000-000000000001',
            title: 'Seeded',
            completed: false,
            createdAt: '2026-11-01T10:00:00.000Z',
          },
        ],
      }),
    });

    const response = await scoped.app.request('/__test__/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tasks: [] }),
    });

    expect(response.status).toBe(204);
    expect(await scoped.client.tasks.list()).toEqual([]);
  });

  it('answers NOT_FOUND for a task of another workspace', async () => {
    const tasks = new InMemoryTaskRepository();
    const app = createApp({ tasks });
    const clientFor = (workspace?: string): ContractRouterClient<Contract> =>
      createORPCClient(
        new RPCLink({
          url: 'http://api.test/rpc',
          fetch: async (request) => app.fetch(request),
          ...(workspace === undefined ? {} : { headers: { 'x-workspace-id': workspace } }),
        }),
      );
    const created = await clientFor('ws-a').tasks.create({ title: 'Foreign' });

    const error = await clientFor('ws-b')
      .tasks.toggle({ id: created.id })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code: 'NOT_FOUND' });
    // Своя задача не потерялась: чужой toggle её не задел.
    expect(await clientFor('ws-a').tasks.list()).toEqual([created]);
  });
});

describe('OpenAPI transport', () => {
  it('serves the same procedures as REST', async () => {
    const { app } = setup();

    const createResponse = await app.request('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'From REST' }),
    });
    const listResponse = await app.request('/api/tasks');

    expect(createResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual([await createResponse.json()]);
  });

  it('responds 404 for toggling an unknown task', async () => {
    const { app } = setup();

    const response = await app.request(`/api/tasks/${UNKNOWN_ID}/toggle`, { method: 'POST' });

    expect(response.status).toBe(404);
    // код таксономии виден и в теле REST-ответа: различение по коду на обоих
    // транспортах, текст — из каталога (C4.1)
    expect(await response.json()).toMatchObject({
      code: 'NOT_FOUND',
      message: 'Resource not found',
    });
  });
});

describe('HTTP concerns', () => {
  it('responds 404 for unknown RPC procedures and REST routes', async () => {
    const { app } = setup();

    const rpc = await app.request('/rpc/tasks/unknown', { method: 'POST', body: '{}' });
    const rest = await app.request('/api/unknown');

    expect(rpc.status).toBe(404);
    expect(rest.status).toBe(404);
  });

  it('reports health without an instance when started outside e2e', async () => {
    const { app } = setup();

    const response = await app.request('/health');

    expect(await response.json()).toEqual({ status: 'ok', instance: null });
  });

  it('reports the instance id of the e2e run that started it', async () => {
    const { app } = setup({ instanceId: 'run-token' });

    const response = await app.request('/health');

    expect(await response.json()).toEqual({ status: 'ok', instance: 'run-token' });
  });

  it('sends no CORS headers to any origin: browsers use the same-origin proxy (ADR 0005)', async () => {
    const { app } = setup();

    const web = await app.request('/health', { headers: { origin: 'http://localhost:3000' } });
    const foreign = await app.request('/health', { headers: { origin: 'https://evil.example' } });

    expect(web.headers.get('access-control-allow-origin')).toBeNull();
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('request guards', () => {
  // Дефолты закреплены как контракт (c1.7): рост значения — осознанная правка
  // этого теста, а не дрейф; поведение ниже гоняется на инъекциях ради скорости.
  it('pins the defaults of the body limit and the request timeout', () => {
    expect(REQUEST_BODY_LIMIT_BYTES).toBe(1_048_576);
    expect(REQUEST_TIMEOUT_MS).toBe(30_000);
  });

  it('rejects a body over the limit with 413 before the procedure runs', async () => {
    const { app, client } = setup({ bodyLimitBytes: 1024 });
    await client.tasks.create({ title: 'Keep me' });

    const response = await app.request('/rpc/tasks/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x'.repeat(2048) }),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'Payload too large' });
    // Отклонённое тело не дошло до процедуры: данные не тронуты.
    expect(await client.tasks.list()).toHaveLength(1);
  });

  it('lets a request within the limit through to the procedure', async () => {
    const { app, client } = setup({ bodyLimitBytes: 1024 });

    const response = await app.request('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Within the limit' }),
    });

    expect(response.status).toBe(200);
    expect((await client.tasks.list()).map((task) => task.title)).toEqual(['Within the limit']);
  });

  it('bounds the reset body with the same guard as the API routes', async () => {
    const { app } = setup({ enableTestApi: true, bodyLimitBytes: 64 });

    const response = await app.request('/__test__/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tasks: [], padding: 'x'.repeat(128) }),
    });

    expect(response.status).toBe(413);
  });

  it('answers 504 when the handler exceeds the request timeout', async () => {
    const slowContract = {
      stall: ocAccess
        .route({ method: 'GET', path: '/fixture/stall', summary: 'Never answers in time' })
        .meta({ access: { type: 'public' } })
        .output(z.string()),
    };
    const os = implement(slowContract).$context<AppContext>().use(authorizationMiddleware);
    const router = os.router({
      // Хендлер отвечает позже таймаута: гонку обязан выиграть таймер.
      stall: os.stall.handler(
        () => new Promise<string>((resolve) => setTimeout(() => resolve('too late'), 500)),
      ),
    });
    const app = createApp({
      tasks: new InMemoryTaskRepository(),
      router,
      requestTimeoutMs: 50,
    });

    const response = await app.request('/api/fixture/stall');

    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: 'Request timed out' });
  });

  it('clears the pending timeout timer once the request settles', async () => {
    const { app } = setup({ requestTimeoutMs: 60_000 });
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    await app.request('/api/tasks');

    // Гигиена таймера: обработавшийся запрос не оставляет висящий таймер,
    // который выстрелит на уже законченном контексте (мутационный прогон c1.7).
    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });

  // Проверка формы запроса (e74) — fail-closed, по методу и заголовкам, а не по
  // `request.body`: потолок запрос без потока пропускает не читая, а адаптер
  // именно так собирает TRACE с телом. Поэтому форма стоит раньше потолка.

  it.each(DECLARED_WITHOUT_STREAM)(
    'rejects a body declared by $via that the request cannot yield: 400 before the $name procedure runs',
    async ({ path, headers }) => {
      const { app, expectNothingRan } = setupGuards({ bodyLimitBytes: 64 });

      const response = await app.request(path, { method: 'POST', headers, body: null });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Request body is not readable' });
      expectNothingRan();
    },
  );

  it.each(
    PROCEDURE_SITES.flatMap((site) => [
      { ...site, declared: 'content-length: 0', headers: { 'content-length': '0' } },
      { ...site, declared: 'no body headers', headers: {} },
    ]),
  )(
    'lets a request with $declared through the $name guards to the procedure as before',
    async ({ path, headers }) => {
      const { app, ping } = setupGuards({ bodyLimitBytes: 64 });

      const response = await app.request(path, { method: 'POST', headers, body: null });

      expect(response.status).toBe(200);
      expect(ping).toHaveBeenCalledTimes(1);
    },
  );

  it('lets a request with an empty body through the test API guards to the reset handler as before', async () => {
    const { app } = setupGuards({ bodyLimitBytes: 64 });

    const response = await app.request('/__test__/reset', {
      method: 'POST',
      headers: { 'content-length': '0' },
      body: null,
    });

    // Тело не объявлено — ограждения пропускают; пустое тело отбивает сам обработчик.
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'Invalid seed data' });
  });

  it.each(GUARDED_SITES)(
    'answers 504 at $name when a body without content-length stalls below the limit',
    async ({ path }) => {
      const { app, expectNothingRan } = setupGuards({ bodyLimitBytes: 64, requestTimeoutMs: 50 });
      const stalled = stalledBody();

      const response = await app.request(path, {
        method: 'POST',
        body: stalled.stream,
        duplex: 'half',
      });

      // Срок накрывает чтение тела: без content-length потолок читает тело до
      // конца раньше, чем вызовет следующий шаг, — таймер обязан стоять раньше.
      expect(response.status).toBe(504);
      expect(await response.json()).toEqual({ error: 'Request timed out' });
      expectNothingRan();
      // Проигравшая ветка отпущена: висящих промисов тест не оставляет.
      stalled.release();
    },
  );

  it('answers 405, 400, 413 and 504 with one body form: a single error text, nothing from the request', async () => {
    const { app } = setupGuards({ bodyLimitBytes: 10, requestTimeoutMs: 20 });
    const stalled = stalledBody();
    const requests = [
      // Так адаптер собирает TRACE: GET без потока и геттер method.
      withMethod(
        new Request('http://api.local/rpc/ping', { headers: { 'content-length': '11' } }),
        'TRACE',
      ),
      new Request('http://api.local/api/fixture/ping', {
        method: 'POST',
        headers: { 'content-length': '11' },
        body: null,
      }),
      new Request('http://api.local/__test__/reset', {
        method: 'POST',
        body: 'x'.repeat(11),
      }),
      new Request('http://api.local/rpc/ping', {
        method: 'POST',
        body: stalled.stream,
        duplex: 'half',
      }),
    ];

    try {
      const settled = await Promise.all(
        requests.map(async (request) => {
          const response = await app.request(request);
          const body: unknown = await response.json();
          return {
            status: response.status,
            contentType: response.headers.get('content-type'),
            body,
          };
        }),
      );

      // Один ключ и только текст ошибки — одинаково у всех четырёх; данных
      // запроса (включая тело сверх потолка) в ответе нет (C4.1).
      expect(settled).toEqual([
        {
          status: 405,
          contentType: expect.stringMatching(/^application\/json/),
          body: { error: 'Method not allowed' },
        },
        {
          status: 400,
          contentType: expect.stringMatching(/^application\/json/),
          body: { error: 'Request body is not readable' },
        },
        {
          status: 413,
          contentType: expect.stringMatching(/^application\/json/),
          body: { error: 'Payload too large' },
        },
        {
          status: 504,
          contentType: expect.stringMatching(/^application\/json/),
          body: { error: 'Request timed out' },
        },
      ]);
    } finally {
      stalled.release();
    }
  });
});

// e56: формы ответов на проводе — дословно. Из этих же фикстур строится спека
// (packages/contracts/scripts/openapi-spec.ts): расходится рантайм — красный
// здесь, расходится спека — красный в openapi-spec.test.ts. Операция — та, что
// документирована: POST /api/tasks.
describe('error responses on the wire', () => {
  const JSON_HEADERS = { 'content-type': 'application/json' };
  const WIRE_CASES: readonly {
    name: string;
    expected: WireResponse;
    send: () => RequestInit;
  }[] = [
    {
      name: 'a malformed JSON body',
      expected: errorResponses.malformedBody,
      send: () => ({ method: 'POST', headers: JSON_HEADERS, body: '{"title": ' }),
    },
    {
      name: 'a body over the limit',
      expected: errorResponses.payloadTooLarge,
      send: () => ({
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ title: 'x'.repeat(2048) }),
      }),
    },
  ];

  for (const { name, expected, send } of WIRE_CASES) {
    it(`answers ${name} with the status and body the spec is built from`, async () => {
      const { app } = setup({ bodyLimitBytes: 1024 });

      const response = await app.request('/api/tasks', send());

      expect(response.headers.get('content-type')).toMatch(/^application\/json/);
      expect({ status: response.status, body: await response.json() }).toEqual(expected);
    });
  }

  it('answers a stalled body with the status and body the spec is built from', async () => {
    const { app } = setup({ bodyLimitBytes: 1024, requestTimeoutMs: 50 });
    const stalled = stalledBody();

    try {
      const response = await app.request('/api/tasks', {
        method: 'POST',
        body: stalled.stream,
        duplex: 'half',
      });

      expect(response.headers.get('content-type')).toMatch(/^application\/json/);
      expect({ status: response.status, body: await response.json() }).toEqual(
        errorResponses.requestTimedOut,
      );
    } finally {
      // Проигравшая ветка отпущена: висящих промисов тест не оставляет.
      stalled.release();
    }
  });

  it('answers an invalid body with the zod issues the spec documents', async () => {
    const { app } = setup();

    const response = await app.request('/api/tasks', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: '   ' }),
    });

    // В issue на проводе есть и другие поля (code, origin…) — спека описывает минимум
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject(errorResponses.validationFailed.body);
  });
});

// Дыра воспроизводится только на настоящем адаптере: node-server собирает
// TRACE как GET без потока (`request.body === null`), хотя тело в соединении
// есть; через `app.request()` такой запрос не собрать (см. withMethod).
describe('on a real HTTP server', () => {
  // Тела валидны для своих процедур и с запасом выше потолка: до правки TRACE
  // с таким телом доходил до транспорта — лимит для него не действовал.
  it.each([
    { name: 'RPC', path: '/rpc/tasks/create', body: { json: { title: 'Poked by TRACE' } } },
    { name: 'OpenAPI', path: '/api/tasks', body: { title: 'Poked by TRACE' } },
    {
      name: 'test API',
      path: '/__test__/reset',
      body: {
        tasks: [
          {
            id: '00000000-0000-4000-8000-000000000001',
            title: 'Poked by TRACE',
            completed: false,
            createdAt: '2026-11-01T10:00:00.000Z',
          },
        ],
      },
    },
  ])(
    'answers 405 to a TRACE with a body over the limit at $name before the procedure runs',
    async ({ path, body }) => {
      const { app, client } = setup({ enableTestApi: true, bodyLimitBytes: 64 });
      const { port, close } = await listen(app);

      try {
        // Хвостовые пробелы — валидный JSON: 200 байт при потолке 64.
        const { raw } = await rawExchange(
          port,
          `TRACE ${path} HTTP/1.1\r\nHost: api.local\r\nContent-Type: application/json\r\nContent-Length: 200\r\nConnection: close\r\n\r\n${JSON.stringify(body).padEnd(200)}`,
          2_000,
        );

        // Ни создание задачи, ни сидирование не выполнены: процедура не вызвана.
        expect(await client.tasks.list()).toEqual([]);
        expect(raw).toMatch(/^HTTP\/1\.1 405 /);
        expect(raw).toContain('{"error":"Method not allowed"}');
      } finally {
        await close();
      }
    },
  );

  // e56 (ревью): адаптер не передаёт поток тела методам GET и HEAD, и
  // объявленное тело отбивает ограждение формы — до потолка (200 байт при
  // потолке 64 не дают 413) и до процедуры. Этот 400 спека описывает у
  // методов без тела; проверка на каждой GET-операции настоящего контракта.
  it('answers a GET with a declared body with the 400 the spec documents', async () => {
    const app = createApp({ tasks: new InMemoryTaskRepository(), bodyLimitBytes: 64 });
    const { port, close } = await listen(app);
    const spec = await generateSpec(contract);
    const gets = Object.entries(spec.paths ?? {}).filter(([, item]) => item?.get !== undefined);

    try {
      expect(gets.map(([path]) => path)).toEqual(['/tasks']);
      await Promise.all(
        gets.map(async ([path, item]) => {
          const { raw } = await rawExchange(
            port,
            `GET /api${path} HTTP/1.1\r\nHost: api.local\r\nContent-Type: application/json\r\nContent-Length: 200\r\nConnection: close\r\n\r\n${' '.repeat(200)}`,
            2_000,
          );
          const documented = Object.keys(item?.get?.responses ?? {});

          expect(raw).toMatch(/^HTTP\/1\.1 400 /);
          expect(raw).toContain(JSON.stringify(errorResponses.unreadableBody.body));
          expect(documented).toContain('400');
          expect(documented).not.toContain('413');
        }),
      );
    } finally {
      await close();
    }
  });

  it('answers 504 to a stalled chunked body in about the request timeout', async () => {
    const { app, expectNothingRan } = setupGuards({ bodyLimitBytes: 64, requestTimeoutMs: 200 });
    const { port, close } = await listen(app);

    try {
      // Chunked-тело ниже потолка остановилось на 10 байтах: клиент молчит и
      // держит соединение, `Connection: close` не просит.
      const { raw, firstByteAfterMs } = await rawExchange(
        port,
        'POST /rpc/ping HTTP/1.1\r\nHost: api.local\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\na\r\n0123456789\r\n',
        3_000,
      );

      expect(raw).toMatch(/^HTTP\/1\.1 504 /);
      expect(raw).toContain('{"error":"Request timed out"}');
      expectNothingRan();
      // Раньше срока ответа не бывает — это таймер. Сверху — запас к порядку
      // величины: до правки ответ ждал бы requestTimeout Node (300 с по умолчанию).
      expect(firstByteAfterMs).toBeGreaterThanOrEqual(200);
      expect(firstByteAfterMs).toBeLessThan(2_000);
    } finally {
      await close();
    }
  });
});

describe('test API', () => {
  const seeded = {
    id: '00000000-0000-4000-8000-000000000001',
    title: 'Seeded',
    completed: false,
    createdAt: '2026-11-01T10:00:00.000Z',
  };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is not exposed unless explicitly enabled', async () => {
    const app = createApp({ tasks: new InMemoryTaskRepository() });

    const response = await app.request('/__test__/reset', { method: 'POST', body: '{"tasks":[]}' });

    expect(response.status).toBe(404);
  });

  it('refuses to start in production even when enabled directly, bypassing loadServerEnv', () => {
    // Второй рубеж (c1.7): другой вход мог бы поднять приложение с
    // enableTestApi: true мимо env-схемы — createApp проверяет сам.
    vi.stubEnv('NODE_ENV', 'production');

    expect(() => createApp({ tasks: new InMemoryTaskRepository(), enableTestApi: true })).toThrow(
      'ENABLE_TEST_API must never be set in production',
    );
  });

  it('starts with the test API enabled outside production', () => {
    vi.stubEnv('NODE_ENV', 'development');

    expect(() =>
      createApp({ tasks: new InMemoryTaskRepository(), enableTestApi: true }),
    ).not.toThrow();
  });

  it('replaces data when enabled', async () => {
    const { app, client } = setup({ enableTestApi: true });
    await client.tasks.create({ title: 'Will be removed' });

    const response = await app.request('/__test__/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tasks: [seeded] }),
    });

    expect(response.status).toBe(204);
    expect(await client.tasks.list()).toEqual([seeded]);
  });

  it('rejects malformed seed data and keeps existing tasks', async () => {
    const { app, client } = setup({ enableTestApi: true });
    const existing = await client.tasks.create({ title: 'Keep me' });

    const response = await app.request('/__test__/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tasks: [{ id: 'nope' }] }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'Invalid seed data',
      issues: expect.arrayContaining([expect.objectContaining({ path: ['tasks', 0, 'id'] })]),
    });
    expect(await client.tasks.list()).toEqual([existing]);
  });

  // e53: роутер валидирует только форму задачи. Дубликат id в наборе и id
  // чужого рабочего пространства проходят схему — сбой видит хранилище, и
  // такой reset обязан закончиться 500 с данными на месте.
  it('answers 500 and keeps existing tasks when the repository rejects the seed', async () => {
    const app = createApp({ tasks: new InMemoryTaskRepository(), enableTestApi: true });
    const clientFor = (workspace: string): ContractRouterClient<Contract> =>
      createORPCClient(
        new RPCLink({
          url: 'http://api.test/rpc',
          fetch: async (request) => app.fetch(request),
          headers: { 'x-workspace-id': workspace },
        }),
      );
    const reset = async (tasks: (typeof seeded)[]): Promise<Response> =>
      app.request('/__test__/reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-workspace-id': 'ws-a' },
        body: JSON.stringify({ tasks }),
      });
    const neighbour = await clientFor('ws-b').tasks.create({ title: 'Neighbour' });
    const existing = await clientFor('ws-a').tasks.create({ title: 'Keep me' });

    const duplicate = await reset([seeded, { ...seeded, title: 'Twin' }]);

    expect(duplicate.status).toBe(500);
    expect(await duplicate.json()).toEqual({ error: 'Internal server error' });
    expect(await clientFor('ws-a').tasks.list()).toEqual([existing]);

    const foreign = await reset([{ ...neighbour, title: 'Imposter' }]);

    expect(foreign.status).toBe(500);
    expect(await clientFor('ws-a').tasks.list()).toEqual([existing]);
    expect(await clientFor('ws-b').tasks.list()).toEqual([neighbour]);
  });

  it('rejects an unknown top-level field loudly instead of silently stripping it', async () => {
    const { app, client } = setup({ enableTestApi: true });
    const existing = await client.tasks.create({ title: 'Keep me' });

    // z.object здесь стрипнул бы ключ: сидирование прошло бы «успешно» с
    // не тем, что задумала фикстура (c1.7).
    const response = await app.request('/__test__/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskz: [seeded] }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'Invalid seed data',
      issues: expect.arrayContaining([expect.objectContaining({ path: [] })]),
    });
    expect(await client.tasks.list()).toEqual([existing]);
  });

  it('rejects an unknown field inside a seeded task instead of stripping it', async () => {
    const { app, client } = setup({ enableTestApi: true });
    const existing = await client.tasks.create({ title: 'Keep me' });

    const response = await app.request('/__test__/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tasks: [{ ...seeded, complated: seeded.completed }] }),
    });

    expect(response.status).toBe(400);
    // zod v4 прикладывает unrecognized_keys к пути объекта-нарушителя,
    // сам лишний ключ — в `keys` issue.
    expect(await response.json()).toMatchObject({
      error: 'Invalid seed data',
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'unrecognized_keys', path: ['tasks', 0] }),
      ]),
    });
    expect(await client.tasks.list()).toEqual([existing]);
  });

  it.each([
    ['invalid JSON', 'not json'],
    ['a body without tasks', '{}'],
  ])('rejects %s instead of wiping data', async (_case, body) => {
    const { app, client } = setup({ enableTestApi: true });
    await client.tasks.create({ title: 'Keep me' });

    const response = await app.request('/__test__/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });

    expect(response.status).toBe(400);
    expect(await client.tasks.list()).toHaveLength(1);
  });
});

describe('test API log slice', () => {
  it('is not exposed unless the test API is enabled', async () => {
    const app = createApp({ tasks: new InMemoryTaskRepository() });

    const response = await app.request('/__test__/logs?requestId=scenario-request-1');

    expect(response.status).toBe(404);
  });

  it('returns the records of the given request ids and none of the neighbors', async () => {
    const records: LogRecord[] = [];
    const log: LogSink = (record) => records.push(record);
    const { app } = setup({ enableTestApi: true, log });

    // три «параллельных» запроса с разными идентификаторами: два — свой сценарий, один — сосед
    await app.request('/health', { headers: { 'x-request-id': 'scenario-request-1' } });
    await app.request('/api/tasks', { headers: { 'x-request-id': 'scenario-request-2' } });
    await app.request('/health', { headers: { 'x-request-id': 'neighbor-request-9' } });

    const response = await app.request(
      '/__test__/logs?requestId=scenario-request-1&requestId=scenario-request-2',
    );

    expect(response.status).toBe(200);
    // срез — в точности записи основного лога этих двух идентификаторов:
    // соседний при параллельной записи в общий буфер не попадает
    const ownIds = new Set(['scenario-request-1', 'scenario-request-2']);
    expect(await response.json()).toEqual({
      records: records.filter(
        (record) => typeof record['requestId'] === 'string' && ownIds.has(record['requestId']),
      ),
    });
  });

  it('finds records by the generated id returned in the response header', async () => {
    const { app } = setup({ enableTestApi: true });

    const response = await app.request('/health');
    const requestId = response.headers.get('x-request-id');
    const sliceResponse = await app.request(`/__test__/logs?requestId=${requestId}`);

    expect(sliceResponse.status).toBe(200);
    const slice = z
      .object({ records: z.array(z.object({ requestId: z.string() })).length(1) })
      .parse(await sliceResponse.json());
    expect(slice.records[0]?.requestId).toBe(requestId);
  });

  it('rejects missing or malformed request ids instead of returning the whole buffer', async () => {
    const { app } = setup({ enableTestApi: true });

    const responses = [
      await app.request('/__test__/logs'),
      await app.request('/__test__/logs?requestId=bad id with spaces'),
      await app.request('/__test__/logs?requestId=../../etc/passwd'),
    ];

    const bodies = await Promise.all(responses.map((response) => response.json()));
    expect(responses.map((response) => response.status)).toEqual([400, 400, 400]);
    for (const body of bodies) {
      expect(body).toMatchObject({ error: 'Invalid requestId query' });
    }
  });

  it('rejects a query mixing a valid id with a malformed one', async () => {
    const { app } = setup({ enableTestApi: true });

    const response = await app.request(
      '/__test__/logs?requestId=scenario-request-1&requestId=bad id with spaces',
    );

    expect(response.status).toBe(400);
  });
});

function setupFixture({ actorId }: { actorId?: string } = {}) {
  const fixtureContract = {
    whoAmI: ocAccess
      .route({ method: 'GET', path: '/fixture/who', summary: 'Name of the acting actor' })
      .meta({ access: { type: 'public' } })
      .output(z.string()),
    ownerEcho: ocAccess
      .route({ method: 'GET', path: '/fixture/owner', summary: 'Owner-only echo' })
      .meta({ access: { type: 'owner' } })
      .output(z.string()),
  };

  const os = implement(fixtureContract).$context<AppContext>().use(authorizationMiddleware);
  const router = os.router({
    whoAmI: os.whoAmI.handler(({ context }) => context.actor?.id ?? 'anonymous'),
    ownerEcho: os.ownerEcho.handler(() => 'domain must not run'),
  });

  const app = createApp({
    tasks: new InMemoryTaskRepository(),
    router,
    resolveActor: actorFromHeader,
  });

  const headers = actorId === undefined ? {} : { 'x-actor-id': actorId };
  const client: ContractRouterClient<typeof fixtureContract> = createORPCClient(
    new RPCLink({
      url: 'http://api.test/rpc',
      headers,
      fetch: async (request) => app.fetch(request),
    }),
  );
  return { app, client };
}

describe('authorization over both transports', () => {
  it('plumbs the resolved actor into procedures over RPC', async () => {
    const { client } = setupFixture({ actorId: 'user-7' });

    await expect(client.whoAmI()).resolves.toBe('user-7');
  });

  it('resolves no actor by default over RPC', async () => {
    const { client } = setupFixture();

    await expect(client.whoAmI()).resolves.toBe('anonymous');
  });

  it('denies an owner procedure over RPC with a typed FORBIDDEN', async () => {
    const { client } = setupFixture({ actorId: 'user-7' });

    const error = await client.ownerEcho().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code: 'FORBIDDEN', message: 'Access denied' });
  });

  it('responds 403 for an owner procedure over REST with or without an actor', async () => {
    const { app } = setupFixture({ actorId: 'user-7' });

    const anonymous = await app.request('/api/fixture/owner');
    const acting = await app.request('/api/fixture/owner', { headers: { 'x-actor-id': 'user-7' } });

    expect(anonymous.status).toBe(403);
    expect(acting.status).toBe(403);
  });

  it('serves a public procedure over REST regardless of the actor', async () => {
    const { app } = setupFixture({ actorId: 'user-7' });

    const response = await app.request('/api/fixture/who', { headers: { 'x-actor-id': 'user-7' } });

    expect(response.status).toBe(200);
    expect(await response.json()).toBe('user-7');
  });

  it('refuses to serve a router built without the authorization middleware', () => {
    const bareContract = {
      group: {
        bare: oc
          .route({ method: 'GET', path: '/bare', summary: 'No policy at all' })
          .output(z.string()),
      },
      other: {
        bare: oc
          .route({ method: 'GET', path: '/other', summary: 'No policy either' })
          .output(z.string()),
      },
    };
    const osBare = implement(bareContract).$context<AppContext>();
    const bareRouter = osBare.router({
      group: { bare: osBare.group.bare.handler(() => 'x') },
      other: { bare: osBare.other.bare.handler(() => 'x') },
    });

    expect(() => createApp({ tasks: new InMemoryTaskRepository(), router: bareRouter })).toThrow(
      'Router procedures without the authorization middleware: group.bare, other.bare',
    );
  });
});

/**
 * tasks.remove — первая owner-процедура домена (C2.3): доступ по таблице
 * перебора покрывает owner-access-table.test.ts, здесь — поведение обоих
 * транспортов и проводка «актор → владелец созданной задачи».
 */
function setupWithOwnedTask() {
  const tasks = new InMemoryTaskRepository();
  const app = createApp({ tasks, resolveActor: actorFromHeader });
  const clientFor = (actorId?: string): ContractRouterClient<Contract> =>
    createORPCClient(
      new RPCLink({
        url: 'http://api.test/rpc',
        headers: actorId === undefined ? {} : { 'x-actor-id': actorId },
        fetch: async (request) => app.fetch(request),
      }),
    );
  const ownedTask = () => tasks.create('Delete me', 'owner-1');
  return { app, tasks, clientFor, ownedTask };
}

describe('tasks.remove access over both transports', () => {
  it('lets the owner delete their task over RPC', async () => {
    const { tasks, clientFor, ownedTask } = setupWithOwnedTask();
    const created = await ownedTask();

    await expect(clientFor('owner-1').tasks.remove({ id: created.id })).resolves.toBeUndefined();

    expect((await tasks.list()).map((task) => task.id)).not.toContain(created.id);
  });

  it('denies a foreign actor over RPC with a typed FORBIDDEN before the domain', async () => {
    const { tasks, clientFor, ownedTask } = setupWithOwnedTask();
    const created = await ownedTask();

    const error = await clientFor('foreign-2')
      .tasks.remove({ id: created.id })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code: 'FORBIDDEN', message: 'Access denied' });
    expect((await tasks.list()).map((task) => task.id)).toContain(created.id);
  });

  it('answers FORBIDDEN, not NOT_FOUND, for repeated deletion by the owner', async () => {
    const { clientFor, ownedTask } = setupWithOwnedTask();
    const created = await ownedTask();

    await expect(clientFor('owner-1').tasks.remove({ id: created.id })).resolves.toBeUndefined();

    // Задачи больше нет — владельца нет — тот же отказ FORBIDDEN: оракула
    // существования нет (решение из ревью плана C2.3)
    const error = await clientFor('owner-1')
      .tasks.remove({ id: created.id })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('records the acting actor as the owner of the created task', async () => {
    const { tasks, clientFor } = setupWithOwnedTask();
    const created = await clientFor('creator-7').tasks.create({ title: 'Mine' });

    const foreign = await clientFor('other-8')
      .tasks.remove({ id: created.id })
      .catch((caught: unknown) => caught);

    expect(foreign).toMatchObject({ code: 'FORBIDDEN' });
    await expect(clientFor('creator-7').tasks.remove({ id: created.id })).resolves.toBeUndefined();
    expect(await tasks.list()).toEqual([]);
  });

  it('responds 200 to the owner, 403 to anonymous and foreign actors over REST', async () => {
    const { app, tasks, ownedTask } = setupWithOwnedTask();
    const created = await ownedTask();

    const anonymous = await app.request(`/api/tasks/${created.id}`, { method: 'DELETE' });
    const foreign = await app.request(`/api/tasks/${created.id}`, {
      method: 'DELETE',
      headers: { 'x-actor-id': 'foreign-2' },
    });
    const owner = await app.request(`/api/tasks/${created.id}`, {
      method: 'DELETE',
      headers: { 'x-actor-id': 'owner-1' },
    });

    expect(anonymous.status).toBe(403);
    expect(foreign.status).toBe(403);
    // void-вывод OpenAPI-транспорт отдаёт как 200 с пустым телом
    expect(owner.status).toBe(200);
    expect(await tasks.list()).toEqual([]);
  });

  it('responds 403 for an unknown task id over REST: fail-closed, no existence oracle', async () => {
    const { app } = setupWithOwnedTask();

    const response = await app.request(`/api/tasks/${UNKNOWN_ID}`, {
      method: 'DELETE',
      headers: { 'x-actor-id': 'owner-1' },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('answers 403, not 400, for a malformed id over REST: authorization runs before input validation', async () => {
    const { app } = setupWithOwnedTask();

    const response = await app.request('/api/tasks/not-a-uuid', {
      method: 'DELETE',
      headers: { 'x-actor-id': 'owner-1' },
    });

    // Владелец по форме input не вычислим — fail-closed: потребитель не
    // отличает «битый формат» от «нет доступа» (описание операции в контракте,
    // c1.7). BAD_REQUEST выдал бы формат поля наружу.
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'FORBIDDEN', message: 'Access denied' });
  });

  it('answers FORBIDDEN for a malformed id over RPC before input validation', async () => {
    const { clientFor } = setupWithOwnedTask();

    const error = await clientFor('owner-1')
      .tasks.remove({ id: 'not-a-uuid' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code: 'FORBIDDEN', message: 'Access denied' });
  });

  it('distinguishes domain errors by code, not by text: NOT_FOUND vs FORBIDDEN', async () => {
    const { clientFor } = setupWithOwnedTask();
    const { client } = setup();

    // Один и тот же симптом «задачи с таким id нет» — разные коды: у toggle
    // NOT_FOUND объявлен контрактом, у remove мидлварь отвечает FORBIDDEN.
    const toggleError = await client.tasks
      .toggle({ id: UNKNOWN_ID })
      .catch((caught: unknown) => caught);
    const removeError = await clientFor('owner-1')
      .tasks.remove({ id: UNKNOWN_ID })
      .catch((caught: unknown) => caught);

    expect(toggleError).toMatchObject({ code: 'NOT_FOUND', message: 'Resource not found' });
    expect(removeError).toMatchObject({ code: 'FORBIDDEN', message: 'Access denied' });
  });
});
