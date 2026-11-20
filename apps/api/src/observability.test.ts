import { describe, expect, it } from 'vitest';

import { createApp } from './app.ts';
import {
  createLogBuffer,
  createLogger,
  isSafeRequestId,
  requestIdOf,
  serializeError,
  type LogRecord,
  type LogSink,
} from './observability.ts';
import { InMemoryTaskRepository } from './tasks/repository.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const SECRET_IN_BODY = 'SECRET-BODY-MARKER';
const SECRET_IN_QUERY = 'SECRET-QUERY-MARKER';

function collectingApp(options: Partial<Parameters<typeof createApp>[0]> = {}): {
  app: ReturnType<typeof createApp>;
  records: LogRecord[];
} {
  const records: LogRecord[] = [];
  const sink: LogSink = (record) => records.push(record);
  const app = createApp({
    tasks: new InMemoryTaskRepository(),
    log: sink,
    ...options,
  });
  return { app, records };
}

describe('request id', () => {
  it('is generated, returned in the response and present on the request event', async () => {
    const { app, records } = collectingApp();

    const response = await app.request('/health');

    const requestId = response.headers.get('x-request-id');
    expect(requestId).toMatch(UUID_PATTERN);
    const requestEvents = records.filter((record) => record.event === 'request');
    expect(requestEvents).toHaveLength(1);
    expect(requestEvents[0]?.['requestId']).toBe(requestId);
  });

  it('reuses a well-formed id from the x-request-id header', async () => {
    const { app, records } = collectingApp();

    const response = await app.request('/health', { headers: { 'x-request-id': 'client-id-42' } });

    expect(response.headers.get('x-request-id')).toBe('client-id-42');
    expect(records.find((record) => record.event === 'request')?.['requestId']).toBe(
      'client-id-42',
    );
  });

  it('regenerates instead of echoing a malformed id (log-injection guard)', async () => {
    const { app, records } = collectingApp();

    // пробелы ломают whitelist, но остаются валидным значением заголовка:
    // недопустимые для HTTP значения (переводы строк) undici отбрасывает до API
    const response = await app.request('/health', {
      headers: { 'x-request-id': 'bad id with spaces' },
    });

    const requestId = response.headers.get('x-request-id');
    expect(requestId).not.toBe('bad id with spaces');
    expect(requestId).toMatch(UUID_PATTERN);
    expect(records.find((record) => record.event === 'request')?.['requestId']).toBe(requestId);
  });

  it('accepts a W3C traceparent-shaped id: the same header fits a future trace id', () => {
    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const request = new Request('http://api.test/health', {
      headers: { 'x-request-id': traceparent },
    });

    expect(requestIdOf(request, () => 'generated')).toBe(traceparent);
  });

  it('rejects ids outside the safe charset or length and generates a fresh one', () => {
    const tooLong = 'a'.repeat(129);
    const request = new Request('http://api.test/health', {
      headers: { 'x-request-id': tooLong },
    });

    expect(requestIdOf(request, () => 'generated')).toBe('generated');
  });

  it('generates when the header is absent', () => {
    const request = new Request('http://api.test/health');

    expect(requestIdOf(request, () => 'generated')).toBe('generated');
  });
});

describe('request event', () => {
  it('logs one request event per request with exact fields and injected time (З13)', async () => {
    let tick = 0;
    const { app, records } = collectingApp({ now: () => new Date(++tick * 1000) });

    const response = await app.request('/api/tasks?token=ignored');

    expect(response.status).toBe(200);
    const events = records.filter((record) => record.event === 'request');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      level: 'info',
      method: 'GET',
      // query не входит в путь: токен из ?token= не доходит до лога
      path: '/api/tasks',
      status: 200,
      durationMs: 1000,
    });
    // now тикает на каждый вызов: старт (1) → поля записи (2) → ts записи (3)
    expect(events[0]?.ts).toBe('1970-01-01T00:00:03.000Z');
  });

  it('warns for a failed request', async () => {
    const { app, records } = collectingApp();

    await app.request('/api/unknown');

    expect(records.find((record) => record.event === 'request')).toMatchObject({
      level: 'warn',
      status: 404,
    });
  });
});

describe('no request bodies or secrets in the log', () => {
  it('keeps body secrets out of every record on a successful request', async () => {
    const { app, records } = collectingApp();

    const response = await app.request('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: SECRET_IN_BODY }),
    });

    expect(response.status).toBe(200);
    expect(JSON.stringify(records)).not.toContain(SECRET_IN_BODY);
  });

  it('keeps body secrets out of every record on a validation error', async () => {
    const { app, records } = collectingApp();

    // маркер в нарушающем ограничение поле: zod-ошибка отражает пути, не значения
    const response = await app.request('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: `${'a'.repeat(201)}${SECRET_IN_BODY}` }),
    });

    expect(response.status).toBe(400);
    // клиентская ошибка — warn на уровне события запроса
    expect(records.find((record) => record.event === 'request')).toMatchObject({ level: 'warn' });
    expect(JSON.stringify(records)).not.toContain(SECRET_IN_BODY);
  });

  it('keeps query secrets out of every record', async () => {
    const { app, records } = collectingApp();

    const response = await app.request(`/health?secret=${SECRET_IN_QUERY}`);

    expect(response.status).toBe(200);
    expect(JSON.stringify(records)).not.toContain(SECRET_IN_QUERY);
  });
});

class ResetFailingTaskRepository extends InMemoryTaskRepository {
  override async reset(): Promise<void> {
    throw new Error('storage exploded');
  }
}

describe('unhandled errors outside oRPC handlers', () => {
  it('logs a serialized error with the request id and answers with the catalog text', async () => {
    const records: LogRecord[] = [];
    const sink: LogSink = (record) => records.push(record);
    const app = createApp({
      tasks: new ResetFailingTaskRepository(),
      enableTestApi: true,
      log: sink,
    });

    const response = await app.request('/__test__/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': 'reset-req-1' },
      body: '{"tasks":[]}',
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
    const unhandled = records.filter((record) => record.event === 'unhandled');
    expect(unhandled).toHaveLength(1);
    expect(unhandled[0]).toMatchObject({
      level: 'error',
      requestId: 'reset-req-1',
      error: { name: 'Error', message: 'storage exploded' },
    });
    // стек доезжает благодаря явной сериализации (юнит-тест serializeError)
    expect(JSON.stringify(unhandled[0])).toContain('stack');
    // событие запроса тоже есть: два события на один запрос
    expect(records.filter((record) => record.event === 'request')).toHaveLength(1);
  });
});

describe('logger unit behaviour', () => {
  it('builds a JSON record with injected time (З13)', () => {
    const records: LogRecord[] = [];
    const log = createLogger({
      sink: (record) => records.push(record),
      now: () => new Date(Date.UTC(2026, 10, 17, 12, 0, 0)),
    });

    log('info', 'startup', { storage: 'memory' });

    expect(records[0]).toEqual({
      ts: '2026-11-17T12:00:00.000Z',
      level: 'info',
      event: 'startup',
      storage: 'memory',
    });
  });

  it('serializes errors explicitly: stack survives where JSON.stringify loses it', () => {
    const error = new Error('boom');
    // JSON.stringify(Error) даёт пустой объект: стек и сообщение теряются
    expect(JSON.stringify({ error })).toBe('{"error":{}}');

    const serialized = serializeError(error);

    expect(serialized).toMatchObject({ name: 'Error', message: 'boom' });
    expect(serialized.stack).toContain('boom');
  });

  it('serializes non-error throwables as strings', () => {
    expect(serializeError('just a string')).toEqual({
      name: 'NonError',
      message: 'just a string',
    });
  });

  it('omits the stack key entirely for an error without a stack', () => {
    const error = new Error('no stack');
    delete error.stack;

    const serialized = serializeError(error);

    expect('stack' in serialized).toBe(false);
    expect(serialized).toEqual({ name: 'Error', message: 'no stack' });
  });

  it('defaults to stdout JSON lines and the real clock when no options are passed', () => {
    const writes: string[] = [];
    const original = process.stdout.write.bind(process);
    process.stdout.write = (chunk: Uint8Array | string): boolean => {
      writes.push(String(chunk));
      return true;
    };
    try {
      const log = createLogger();

      log('info', 'startup', { storage: 'memory' });
    } finally {
      process.stdout.write = original;
    }

    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('"level":"info","event":"startup","storage":"memory"');
    // часы по умолчанию — настоящие: ts начинается с ISO-даты, а не пустышки
    expect(writes[0]).toMatch(/^\{"ts":"\d{4}-\d{2}-\d{2}T\d{2}:/);
  });
});

const bufferedRecord = (requestId: string): LogRecord => ({
  ts: '2026-11-17T12:00:00.000Z',
  level: 'info',
  event: 'request',
  requestId,
});

describe('safe request id predicate', () => {
  it('accepts the same shapes requestIdOf accepts', () => {
    expect(isSafeRequestId('client-id-42')).toBe(true);
    expect(isSafeRequestId('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toBe(true);
    expect(isSafeRequestId('7chars7')).toBe(false);
    expect(isSafeRequestId('bad id with spaces')).toBe(false);
    expect(isSafeRequestId('../etc/passwd')).toBe(false);
    expect(isSafeRequestId('a'.repeat(129))).toBe(false);
  });
});

describe('log buffer', () => {
  it('keeps every written record until capacity is reached', () => {
    const buffer = createLogBuffer(3);

    buffer.write(bufferedRecord('first'));
    buffer.write(bufferedRecord('second'));

    expect(buffer.records().map((written) => written['requestId'])).toEqual(['first', 'second']);
  });

  it('evicts the oldest records once capacity overflows', () => {
    const buffer = createLogBuffer(3);

    for (const requestId of ['first', 'second', 'third', 'fourth']) {
      buffer.write(bufferedRecord(requestId));
    }

    expect(buffer.records().map((written) => written['requestId'])).toEqual([
      'second',
      'third',
      'fourth',
    ]);
  });

  it('returns a snapshot per call instead of the live ring', () => {
    const buffer = createLogBuffer(3);

    buffer.write(bufferedRecord('first'));
    const first = buffer.records();
    const second = buffer.records();

    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });

  it('defaults to a capacity that holds a whole run without manual sizing', () => {
    const buffer = createLogBuffer();

    for (let index = 0; index < 5000; index += 1) {
      buffer.write(bufferedRecord(`id-${index}`));
    }
    const records = buffer.records();

    expect(records).toHaveLength(4096);
    // первые записи вытеснены, последняя на месте
    expect(records[0]?.['requestId']).toBe('id-904');
    expect(records.at(-1)?.['requestId']).toBe('id-4999');
  });
});
