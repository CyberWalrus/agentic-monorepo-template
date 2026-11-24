import { once } from 'node:events';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

import { serve } from '@hono/node-server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { REQUEST_BODY_LIMIT_BYTES, REQUEST_TIMEOUT_MS } from './lib/request-guards.ts';
import {
  acceptsGzip,
  createWebServerApp,
  forwardHeaders,
  isStartEntry,
  resolveStaticFile,
  type WebServerAppOptions,
} from './server-app.ts';

declare global {
  // `duplex: 'half'` требует undici для поточного тела, а в `RequestInit`
  // lib.dom его нет: тип дополнен, а не подавлен директивой.
  interface RequestInit {
    duplex?: 'half';
  }
}

const API_URL = 'http://api.local:3901';

// Фикстуры создаются один раз: файлы статики неизменяемы в тестах, тесты
// traversal ходят в соседний каталог вне корня статики.
let staticRoot: string;
let outsideRoot: string;

beforeAll(async () => {
  staticRoot = await mkdtemp(path.join(tmpdir(), 'web-entry-root-'));
  outsideRoot = await mkdtemp(path.join(tmpdir(), 'web-entry-outside-'));
  await mkdir(path.join(staticRoot, 'assets'), { recursive: true });
  await writeFile(path.join(staticRoot, 'assets', 'app-abc123.js'), 'console.log("app")');
  // Реальный файл с заглавным расширением: на case-sensitive ФС (CI Linux)
  // ищется именно он — тест проверяет whitelist, а не регистр самой ФС.
  await writeFile(path.join(staticRoot, 'assets', 'upper.JS'), '// upper');
  await writeFile(path.join(staticRoot, 'assets', 'style-abc123.css'), 'body {}');
  // Уже сжатый формат: gzip не применяется, отдаётся как есть.
  await writeFile(path.join(staticRoot, 'assets', 'logo-abc123.png'), 'fake-png-bytes');
  // Соседний каталог с общим началом имени: `assets-extra` начинается с
  // `assets`, но ассетом не является.
  await mkdir(path.join(staticRoot, 'assets-extra'), { recursive: true });
  await writeFile(path.join(staticRoot, 'assets-extra', 'old.js'), '// old');
  await writeFile(path.join(staticRoot, 'index.html'), '<html lang="en"></html>');
  await writeFile(path.join(staticRoot, 'notes.txt'), 'text');
  await writeFile(path.join(staticRoot, 'blob.xyz'), 'unknown');
  await writeFile(path.join(outsideRoot, 'secret.txt'), 'must-not-serve');
  // Симлинк внутри корня статики наружу: не раздаётся даже в пределах корня.
  await symlink(path.join(outsideRoot, 'secret.txt'), path.join(staticRoot, 'leak.txt'));
});

afterAll(async () => {
  await rm(staticRoot, { recursive: true, force: true });
  await rm(outsideRoot, { recursive: true, force: true });
});

/** Сигнатура прокси-fetch: совпадает с typeof fetch там, где её использует фабрика. */
type FetchLike = (input: RequestInfo | URL) => Promise<Response>;

/** SSR-обработчик-двойник: отвечает маркером с путём, чтобы тесты видели делегирование. */
function makeHandler() {
  return vi.fn<(request: Request) => Promise<Response>>(async (request) => {
    return new Response(`ssr ${new URL(request.url).pathname}`, { status: 200 });
  });
}

/** Прокси-fetch-двойник: отвечает 201 с телом и заголовком, чтобы видеть прозрачность. */
function makeProxyFetch() {
  return vi.fn<FetchLike>(async () => {
    return new Response('upstream-body', { status: 201, headers: { 'x-upstream': 'yes' } });
  });
}

type AppOverrides = Partial<
  Pick<
    WebServerAppOptions,
    'staticRoot' | 'compressedBodies' | 'bodyLimitBytes' | 'requestTimeoutMs'
  >
>;

function makeApp(overrides: AppOverrides = {}) {
  const handler = makeHandler();
  const proxyFetch = makeProxyFetch();
  // exactOptionalPropertyTypes: ключ не передаётся вовсе, когда значение не
  // введено — иначе в опцию попадает undefined.
  const { staticRoot: root, ...injected } = overrides;
  const app = createWebServerApp({
    apiUrl: API_URL,
    staticRoot: root ?? staticRoot,
    handler,
    proxyFetch,
    ...injected,
  });
  return { app, handler, proxyFetch };
}

function proxiedRequest(proxyFetch: ReturnType<typeof makeProxyFetch>): Request {
  const input = proxyFetch.mock.calls[0]?.[0];
  if (!(input instanceof Request)) {
    throw new Error(`proxyFetch received ${String(input)} instead of a Request`);
  }
  return input;
}

describe('GET /healthz', () => {
  it('answers readiness with a JSON ok', async () => {
    const { app, handler, proxyFetch } = makeApp();

    const response = await app.request('http://web.local/healthz');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
    expect(response.headers.get('content-type')).toContain('application/json');
    // Readiness — свойство web-процесса: ни прокси, ни SSR не задействованы.
    expect(proxyFetch).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('answers HEAD probes with 200 and no body', async () => {
    const { app } = makeApp();

    const response = await app.request('http://web.local/healthz', { method: 'HEAD' });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('');
  });
});

describe('rpc proxy', () => {
  it('forwards /rpc to the API origin and passes the response through', async () => {
    const { app, proxyFetch } = makeApp();

    const response = await app.request('http://web.local/rpc/tasks/list', { method: 'POST' });

    expect(response.status).toBe(201);
    expect(response.headers.get('x-upstream')).toBe('yes');
    await expect(response.text()).resolves.toBe('upstream-body');
    expect(proxiedRequest(proxyFetch).url).toBe('http://api.local:3901/rpc/tasks/list');
  });

  it('keeps the query string on the proxied request', async () => {
    const { app, proxyFetch } = makeApp();

    await app.request('http://web.local/rpc/tasks/list?cursor=7', { method: 'POST' });

    expect(proxiedRequest(proxyFetch).url).toBe('http://api.local:3901/rpc/tasks/list?cursor=7');
  });

  it('passes the request id header through to the API (C4.1)', async () => {
    const { app, proxyFetch } = makeApp();

    await app.request('http://web.local/rpc/tasks/list', {
      method: 'POST',
      headers: { 'x-request-id': 'req-from-browser-1' },
    });

    expect(proxiedRequest(proxyFetch).headers.get('x-request-id')).toBe('req-from-browser-1');
  });

  it('passes the API request id back to the browser (C4.1)', async () => {
    const { app, proxyFetch } = makeApp();
    proxyFetch.mockImplementation(
      async () =>
        new Response('upstream-body', {
          status: 201,
          headers: { 'x-request-id': 'req-from-api-2' },
        }),
    );

    const response = await app.request('http://web.local/rpc/tasks/list', { method: 'POST' });

    expect(response.headers.get('x-request-id')).toBe('req-from-api-2');
  });

  it('proxies the bare /rpc path too', async () => {
    const { app, proxyFetch } = makeApp();

    await app.request('http://web.local/rpc', { method: 'POST' });

    expect(proxiedRequest(proxyFetch).url).toBe('http://api.local:3901/rpc');
  });

  it('proxies body-less methods without a body', async () => {
    const { app, proxyFetch } = makeApp();

    const response = await app.request('http://web.local/rpc/tasks/list', { method: 'GET' });

    expect(response.status).toBe(201);
    const proxied = proxiedRequest(proxyFetch);
    expect(proxied.method).toBe('GET');
    expect(proxied.body).toBeNull();
  });

  it('drops an empty body instead of forwarding a zero-length one', async () => {
    const { app, proxyFetch } = makeApp();

    await app.request('http://web.local/rpc/tasks/list', { method: 'POST', body: '' });

    expect(proxiedRequest(proxyFetch).body).toBeNull();
  });

  it('rejects an oversized RPC body with 413 before buffering', async () => {
    const { app, proxyFetch } = makeApp();

    const response = await app.request('http://web.local/rpc/tasks/list', {
      method: 'POST',
      body: 'x'.repeat(1024 * 1024 + 1),
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: 'RPC request body is too large' });
    expect(proxyFetch).not.toHaveBeenCalled();
  });

  it('answers 405 to TRACE before touching the body or the API', async () => {
    const { app, proxyFetch } = makeApp();

    // Так @hono/node-server собирает TRACE: GET без потока и геттер method
    // (`app.request` с методом TRACE отклоняет сам Hono).
    const response = await app.request(
      withMethod(
        new Request('http://web.local/rpc/tasks/list', {
          headers: { 'content-length': String(1024 * 1024 + 1) },
        }),
        'TRACE',
      ),
    );

    expect(response.status).toBe(405);
    await expect(response.json()).resolves.toEqual({ error: 'Method not allowed' });
    expect(proxyFetch).not.toHaveBeenCalled();
  });

  it.each([
    { via: 'content-length', headers: { 'content-length': String(1024 * 1024 + 1) } },
    { via: 'transfer-encoding', headers: { 'transfer-encoding': 'chunked' } },
  ])('answers 400 when $via declares a body that the request cannot yield', async ({ headers }) => {
    const { app, proxyFetch } = makeApp();

    const response = await app.request('http://web.local/rpc/tasks/list', {
      method: 'PUT',
      headers,
      body: null,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Request body is not readable' });
    expect(proxyFetch).not.toHaveBeenCalled();
  });

  it('stops reading an oversized chunked body one chunk past the ceiling', async () => {
    const { app, proxyFetch } = makeApp();
    const ceiling = 1024 * 1024;
    const chunkSize = 64 * 1024;
    const ceilingChunks = ceiling / chunkSize;
    let pulled = 0;
    const upload = new ReadableStream<Uint8Array>(
      {
        // 20 чанков при потолке в 16: клиент шлёт сверх потолка и не останавливается.
        pull(controller) {
          pulled += 1;
          if (pulled > ceilingChunks + 4) {
            controller.close();
          } else {
            controller.enqueue(new Uint8Array(chunkSize));
          }
        },
      },
      // Без предвыборки: каждый pull — ровно один чанк, прочитанный прокси.
      { highWaterMark: 0 },
    );

    const response = await app.request('http://web.local/rpc/tasks/list', {
      method: 'POST',
      headers: { 'transfer-encoding': 'chunked' },
      body: upload,
      duplex: 'half',
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: 'RPC request body is too large' });
    expect(proxyFetch).not.toHaveBeenCalled();
    // Потолок плюс один чанк — строка, на которой сумма превысила потолок.
    expect(pulled * chunkSize).toBeLessThanOrEqual(ceiling + chunkSize);
    expect(pulled * chunkSize).toBeGreaterThan(ceiling);
  });

  it('answers 408 when the request body stalls past the proxy timeout', async () => {
    vi.useFakeTimers();
    const { app, proxyFetch } = makeApp();
    const gate: { release?: () => void } = {};
    const stalled = new ReadableStream<Uint8Array>({
      // Клиент прислал заголовки и молчит: первый read() не разрешается.
      pull: (controller) =>
        new Promise<void>((resolve) => {
          gate.release = () => {
            controller.close();
            resolve();
          };
        }),
    });

    const pending = app.request('http://web.local/rpc/tasks/list', {
      method: 'POST',
      body: stalled,
      duplex: 'half',
    });
    // Фейковые таймеры: срок прокси истекает без реальных полминуты.
    await vi.advanceTimersByTimeAsync(30_000);
    const response = await pending;

    expect(response.status).toBe(408);
    await expect(response.json()).resolves.toEqual({ error: 'Request timed out' });
    expect(proxyFetch).not.toHaveBeenCalled();
    // Проигравшая ветка отпущена: висящих промисов тест не оставляет.
    gate.release?.();
  });

  it('answers 500 when the request body stream itself fails', async () => {
    const { app, proxyFetch } = makeApp();
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('socket hang up'));
      },
    });

    const response = await app.request('http://web.local/rpc/tasks/list', {
      method: 'POST',
      body: failing,
      duplex: 'half',
    });

    // Сбой потока — не «слишком велико» и не «не дочитал»: он не маскируется
    // под ответы ограждений и не доходит до API.
    expect(response.status).toBe(500);
    expect(proxyFetch).not.toHaveBeenCalled();
  });

  it('strips hop-by-hop headers from the API response before returning it', async () => {
    const proxyFetch = vi.fn<FetchLike>(async () => {
      return new Response('upstream-body', {
        status: 201,
        headers: {
          'x-upstream': 'yes',
          connection: 'keep-alive',
          'keep-alive': 'timeout=5',
          'transfer-encoding': 'identity',
          'content-length': '13',
        },
      });
    });
    const app = createWebServerApp({
      apiUrl: API_URL,
      staticRoot,
      handler: makeHandler(),
      proxyFetch,
    });

    const response = await app.request('http://web.local/rpc/tasks/list', { method: 'POST' });

    expect(response.status).toBe(201);
    expect(response.headers.get('x-upstream')).toBe('yes');
    expect(response.headers.get('connection')).toBeNull();
    expect(response.headers.get('keep-alive')).toBeNull();
    expect(response.headers.get('transfer-encoding')).toBeNull();
    expect(response.headers.get('content-length')).toBeNull();
    await expect(response.text()).resolves.toBe('upstream-body');
  });

  it('forwards the request body', async () => {
    const { app, proxyFetch } = makeApp();

    await app.request('http://web.local/rpc/tasks/create', {
      method: 'POST',
      body: JSON.stringify({ title: 'a' }),
      headers: { 'content-type': 'application/json' },
    });

    await expect(proxiedRequest(proxyFetch).text()).resolves.toBe(JSON.stringify({ title: 'a' }));
  });

  it('answers 502 without internals when the API is unreachable', async () => {
    const proxyFetch = vi.fn<FetchLike>(async () => {
      throw new Error('connect ECONNREFUSED api.local:3901');
    });
    const app = createWebServerApp({
      apiUrl: API_URL,
      staticRoot,
      handler: makeHandler(),
      proxyFetch,
    });

    const response = await app.request('http://web.local/rpc/tasks/list', { method: 'POST' });
    const body: unknown = await response.json();
    const rendered = JSON.stringify(body);

    expect(response.status).toBe(502);
    expect(body).toEqual({ error: 'API is unreachable' });
    expect(rendered).not.toContain('ECONNREFUSED');
  });
});

describe('static files', () => {
  it('serves a hashed asset with the javascript type and immutable caching', async () => {
    const { app, handler, proxyFetch } = makeApp();

    const response = await app.request('http://web.local/assets/app-abc123.js');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    await expect(response.text()).resolves.toBe('console.log("app")');
    expect(handler).not.toHaveBeenCalled();
    expect(proxyFetch).not.toHaveBeenCalled();
  });

  it('serves css assets with the css type', async () => {
    const { app } = makeApp();

    const response = await app.request('http://web.local/assets/style-abc123.css');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/css; charset=utf-8');
  });

  it('serves root files without immutable caching', async () => {
    const { app } = makeApp();

    const response = await app.request('http://web.local/index.html');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBeNull();
  });

  it('does not cache immutably an /assets/… path that resolves outside the assets directory', async () => {
    const { app } = makeApp();

    // URL-парсер не трогает закодированный разделитель: путь доходит до
    // резолвера как `/assets/../index.html` и разрешается в корневой файл —
    // нехешированный, значит immutable кэшировать нельзя.
    const response = await app.request('http://web.local/assets%2F..%2Findex.html');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBeNull();
  });

  it('does not cache a sibling directory whose name merely starts with "assets"', async () => {
    const { app } = makeApp();

    // Без разделителя в префиксе `assets-extra/` прошло бы проверку «внутри
    // каталога ассетов» по общему началу строки.
    const response = await app.request('http://web.local/assets-extra/old.js');

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('// old');
    expect(response.headers.get('cache-control')).toBeNull();
  });

  it('matches extensions case-insensitively', async () => {
    const { app } = makeApp();

    const response = await app.request('http://web.local/assets/upper.JS');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    await expect(response.text()).resolves.toBe('// upper');
  });

  it('never serves symlinks even inside the static root', async () => {
    const { app, handler } = makeApp();

    const response = await app.request('http://web.local/leak.txt');

    expect(handler).toHaveBeenCalledTimes(1);
    await expect(response.text()).resolves.not.toBe('must-not-serve');
  });

  it('ignores the query string when resolving a file', async () => {
    const { app } = makeApp();

    const response = await app.request('http://web.local/assets/app-abc123.js?v=2');

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('console.log("app")');
  });

  it('answers HEAD with headers but no body', async () => {
    const { app } = makeApp();

    const response = await app.request('http://web.local/assets/app-abc123.js', {
      method: 'HEAD',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    await expect(response.text()).resolves.toBe('');
  });

  it('serves whitelisted text files from the static root', async () => {
    const { app, handler } = makeApp();

    const response = await app.request('http://web.local/notes.txt');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    await expect(response.text()).resolves.toBe('text');
    expect(handler).not.toHaveBeenCalled();
  });

  it('delegates a missing file, a directory and an unknown extension to the handler', async () => {
    const pathnames = ['/assets/missing.js', '/assets/', '/blob.xyz'];
    const cases = pathnames.map((pathname) => {
      const { app, handler } = makeApp();
      return { pathname, pending: app.request(`http://web.local${pathname}`), handler };
    });
    const responses = await Promise.all(cases.map((testCase) => Promise.resolve(testCase.pending)));
    const texts = await Promise.all(responses.map((response) => response.text()));

    for (const [index, testCase] of cases.entries()) {
      expect(responses[index]?.status).toBe(200);
      expect(texts[index]).toBe(`ssr ${testCase.pathname}`);
      expect(testCase.handler).toHaveBeenCalledTimes(1);
    }
  });

  it('never serves paths escaping the static root', async () => {
    const escaped = path.basename(outsideRoot);
    const pathnames = [
      `/assets/../../${escaped}/secret.txt`,
      `/assets/%2e%2e/%2e%2e/${escaped}/secret.txt`,
      '/assets/a%00.js',
    ];
    const cases = pathnames.map((pathname) => {
      const { app, handler } = makeApp();
      return { pathname, pending: app.request(`http://web.local${pathname}`), handler };
    });
    const responses = await Promise.all(cases.map((testCase) => Promise.resolve(testCase.pending)));
    const texts = await Promise.all(responses.map((response) => response.text()));

    for (const [index, testCase] of cases.entries()) {
      expect(texts[index]).not.toBe('must-not-serve');
      expect(testCase.handler).toHaveBeenCalledTimes(1);
    }
  });

  it('delegates non-GET/HEAD requests to the handler instead of the static root', async () => {
    const { app, handler } = makeApp();

    const response = await app.request('http://web.local/assets/app-abc123.js', {
      method: 'POST',
    });

    expect(await response.text()).toBe('ssr /assets/app-abc123.js');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('serves a gzip body for compressible types when the client accepts gzip', async () => {
    const { app } = makeApp();

    const response = await app.request('http://web.local/assets/app-abc123.js', {
      headers: { 'accept-encoding': 'gzip, deflate, br' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-encoding')).toBe('gzip');
    expect(response.headers.get('vary')).toBe('accept-encoding');
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    // Тело — валидный gzip исходного файла: браузер распакует его прозрачно.
    const body = new Uint8Array(await response.arrayBuffer());
    expect(gunzipSync(body).toString('utf8')).toBe('console.log("app")');
  });

  it('keeps the identity body when gzip is not accepted, but still marks vary', async () => {
    const { app } = makeApp();

    const response = await app.request('http://web.local/assets/app-abc123.js');

    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('vary')).toBe('accept-encoding');
    await expect(response.text()).resolves.toBe('console.log("app")');
  });

  it('respects q=0 as declining gzip', async () => {
    const { app } = makeApp();

    const response = await app.request('http://web.local/assets/app-abc123.js', {
      headers: { 'accept-encoding': 'br;q=1, gzip;q=0' },
    });

    expect(response.headers.get('content-encoding')).toBeNull();
    await expect(response.text()).resolves.toBe('console.log("app")');
  });

  it('does not compress formats that ship compressed', async () => {
    const { app } = makeApp();

    const response = await app.request('http://web.local/assets/logo-abc123.png', {
      headers: { 'accept-encoding': 'gzip' },
    });

    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('vary')).toBeNull();
    await expect(response.text()).resolves.toBe('fake-png-bytes');
  });

  it('stores one compressed cache entry for two percent-encodings of one path', async () => {
    // Ключ кэша — канонический путь файла, а не сырое pathname клиента:
    // варианты кодирования одного URL (`%61` = `a`, подмножества и т.п.)
    // декодируются в один файл, и ключ по сырому pathname давал бы запись
    // (и синхронный gzipSync ~150KB) на каждый вариант без предела —
    // memory/CPU-DoS (находка ревью PR #140).
    const cache = new Map<string, Uint8Array<ArrayBuffer>>();
    const { app } = makeApp({ compressedBodies: cache });
    const gz = { headers: { 'accept-encoding': 'gzip' } };

    const plain = await app.request('http://web.local/assets/app-abc123.js', gz);
    const encoded = await app.request('http://web.local/assets/%61pp-abc123.js', gz);

    expect(plain.headers.get('content-encoding')).toBe('gzip');
    expect(encoded.headers.get('content-encoding')).toBe('gzip');
    // Один файл — одна запись кэша и одно сжатие на оба варианта.
    expect(cache.size).toBe(1);
    const plainBody = new Uint8Array(await plain.arrayBuffer());
    const encodedBody = new Uint8Array(await encoded.arrayBuffer());
    expect(encodedBody).toEqual(plainBody);
    expect(gunzipSync(plainBody).toString('utf8')).toBe('console.log("app")');
  });
});

describe('acceptsGzip', () => {
  it('requires an explicitly listed gzip token with non-zero q', () => {
    expect(acceptsGzip('gzip')).toBe(true);
    expect(acceptsGzip('deflate, gzip, br')).toBe(true);
    expect(acceptsGzip('GZIP')).toBe(true);
    expect(acceptsGzip('gzip;q=0')).toBe(false);
    expect(acceptsGzip('br;q=1, gzip;q=0.0')).toBe(false);
    expect(acceptsGzip('deflate')).toBe(false);
    expect(acceptsGzip('*')).toBe(false);
    expect(acceptsGzip(null)).toBe(false);
  });
});

describe('fallback to the TanStack Start handler', () => {
  it('hands every non-proxied, non-static request to the server build', async () => {
    const { app, handler, proxyFetch } = makeApp();

    const response = await app.request('http://web.local/tasks?open=1');

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('ssr /tasks');
    expect(handler).toHaveBeenCalledTimes(1);
    // Делегируется исходный Request целиком: URL с запросом сохранён.
    const forwarded = handler.mock.calls[0]?.[0];
    if (!(forwarded instanceof Request)) {
      throw new Error('handler did not receive a Request');
    }
    expect(new URL(forwarded.url).search).toBe('?open=1');
    expect(proxyFetch).not.toHaveBeenCalled();
  });
});

describe('request guards on the SSR fallback', () => {
  it('answers 413 with the API body when a non-GET body exceeds the limit', async () => {
    const { app, handler } = makeApp({ bodyLimitBytes: 10 });

    const response = await app.request('http://web.local/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(11),
    });

    expect(response.status).toBe(413);
    // Форма и текст — дословно как у API (`apps/api/src/app.test.ts`, 413).
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    await expect(response.json()).resolves.toEqual({ error: 'Payload too large' });
    // Отклонённое тело не дошло до SSR-обработчика.
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects by the declared content-length before reading the body', async () => {
    const { app, handler } = makeApp({ bodyLimitBytes: 10 });

    const response = await app.request('http://web.local/tasks', {
      method: 'POST',
      headers: { 'content-length': '11' },
      body: 'x',
    });

    expect(response.status).toBe(413);
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    { declared: 'without a declared length', headers: {} },
    { declared: 'with a declared length', headers: { 'content-length': '10' } },
  ])(
    'lets a body exactly at the limit through to the handler intact ($declared)',
    async ({ headers: declared }) => {
      const { app, handler } = makeApp({ bodyLimitBytes: 10 });
      handler.mockImplementationOnce(async (request) => {
        const seen = [
          await request.text(),
          request.headers.get('content-type'),
          request.headers.get('cookie'),
        ];
        return new Response(JSON.stringify(seen), { status: 201 });
      });

      const response = await app.request('http://web.local/tasks?open=1', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'session=abc', ...declared },
        body: 'x'.repeat(10),
      });

      // Штатный поток не сломан: тело, заголовки, метод и URL доходят целыми —
      // и когда лимит пересобирает запрос из буфера (без content-length), и когда
      // пропускает его по объявленной длине.
      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toEqual([
        'x'.repeat(10),
        'application/json',
        'session=abc',
      ]);

      const forwarded = handler.mock.calls[0]?.[0];
      if (!(forwarded instanceof Request)) {
        throw new Error('handler did not receive a Request');
      }
      expect(forwarded.method).toBe('POST');
      expect(new URL(forwarded.url).search).toBe('?open=1');
    },
  );

  it('answers 504 with the API body when the handler hangs', async () => {
    const gate: { release?: () => void } = {};
    const hanging = new Promise<Response>((resolve) => {
      gate.release = () => resolve(new Response('too late'));
    });
    const { app, handler } = makeApp({ requestTimeoutMs: 20 });
    // Обработчик отвечает позже таймаута: гонку обязан выиграть таймер.
    handler.mockImplementationOnce(() => hanging);

    const response = await app.request('http://web.local/tasks', { method: 'POST' });

    expect(response.status).toBe(504);
    // Форма и текст — дословно как у API (`apps/api/src/app.test.ts`, 504).
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    await expect(response.json()).resolves.toEqual({ error: 'Request timed out' });
    // Проигравший обработчик отпущен: висящих промисов тест не оставляет.
    gate.release?.();
    await hanging;
  });

  it.each(['PUT', 'DELETE', 'PATCH', 'OPTIONS'])(
    'answers 413 to %s over the limit as well',
    async (method) => {
      const { app, handler } = makeApp({ bodyLimitBytes: 10 });

      const response = await app.request('http://web.local/tasks', {
        method,
        body: 'x'.repeat(11),
      });

      // Класс «не-GET/HEAD», а не один POST: ограждение стоит на catch-all.
      expect(response.status).toBe(413);
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it('answers 405 to TRACE', async () => {
    const { app, handler } = makeApp({ bodyLimitBytes: 10 });

    // Так @hono/node-server собирает TRACE: GET без потока и геттер method.
    const request = withMethod(
      new Request('http://web.local/tasks', { headers: { 'content-length': '11' } }),
      'TRACE',
    );

    const response = await app.request(request);

    expect(response.status).toBe(405);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    await expect(response.json()).resolves.toEqual({ error: 'Method not allowed' });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    { via: 'content-length', headers: { 'content-length': '11' } },
    { via: 'transfer-encoding', headers: { 'transfer-encoding': 'chunked' } },
  ])('answers 400 when $via declares a body that the request cannot yield', async ({ headers }) => {
    const { app, handler } = makeApp({ bodyLimitBytes: 10 });

    const response = await app.request('http://web.local/tasks', {
      method: 'PUT',
      headers,
      body: null,
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    await expect(response.json()).resolves.toEqual({ error: 'Request body is not readable' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('lets a declared empty body through', async () => {
    const { app, handler } = makeApp({ bodyLimitBytes: 10 });

    const response = await app.request('http://web.local/tasks', {
      method: 'POST',
      headers: { 'content-length': '0' },
      body: null,
    });

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('characterization: lets GET with a body reach the handler without 413', async () => {
    const { app, handler } = makeApp({ bodyLimitBytes: 10 });
    handler.mockImplementationOnce(async (request) => new Response(await request.text()));

    // undici запрещает тело у GET — метод подменяется геттером, как делает
    // @hono/node-server для запросов, у которых метод и тело расходятся.
    const request = withMethod(
      new Request('http://web.local/tasks', { method: 'PUT', body: 'x'.repeat(11) }),
      'GET',
    );

    const response = await app.request(request);

    // Осознанная граница задачи: контур — «не-GET/HEAD», GET с телом не ограждён.
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('x'.repeat(11));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('bounds the time spent reading a slow body, not only the handler', async () => {
    vi.useFakeTimers();
    const { app, handler } = makeApp({ requestTimeoutMs: 20 });
    const gate: { release?: () => void } = {};
    const slow = new ReadableStream<Uint8Array>({
      // Клиент прислал заголовки и молчит: обработчик ждёт первый байт тела.
      pull: (controller) =>
        new Promise<void>((resolve) => {
          gate.release = () => {
            controller.close();
            resolve();
          };
        }),
    });
    handler.mockImplementationOnce(
      async (request) => new Response(await request.text(), { status: 201 }),
    );

    const pending = app.request('http://web.local/tasks', {
      method: 'POST',
      body: slow,
      duplex: 'half',
    });
    // Фейковые таймеры: срок истекает без реального ожидания.
    await vi.advanceTimersByTimeAsync(20);
    const response = await pending;

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toEqual({ error: 'Request timed out' });
    // Проигравшая ветка отпущена: висящих промисов тест не оставляет.
    gate.release?.();
  });

  it('pins the default limits by their literal values', async () => {
    const { app, handler } = makeApp();

    const response = await app.request('http://web.local/tasks', {
      method: 'POST',
      body: 'x'.repeat(REQUEST_BODY_LIMIT_BYTES + 1),
    });

    expect(response.status).toBe(413);
    expect(handler).not.toHaveBeenCalled();
    // Зеркало литералов, а не сверка с API: сквозного дрейф-гейта между
    // приложениями нет (журнал e55, решение 3). 30 с поведением не проверяется.
    expect(REQUEST_BODY_LIMIT_BYTES).toBe(1_048_576);
    expect(REQUEST_TIMEOUT_MS).toBe(30_000);
  });
});

// Фейковые таймеры включают отдельные тесты; снимаются после каждого, чтобы
// упавший на таймауте тест не оставил их следующим.
afterEach(() => {
  vi.useRealTimers();
});

/**
 * Request с подменённым геттером `method` — так @hono/node-server собирает
 * запросы, у которых метод и тело расходятся (TRACE; GET/HEAD без потока).
 * undici сам такой Request не даёт собрать: у GET тела быть не может.
 */
function withMethod(request: Request, method: string): Request {
  Object.defineProperty(request, 'method', { value: method, configurable: true });
  return request;
}

/** Сырой HTTP-обмен одним кадром; ответ читается до закрытия соединения сервером. */
async function rawExchange(port: number, frame: string): Promise<string> {
  const socket = connect(port, '127.0.0.1');
  const received: Uint8Array[] = [];
  await new Promise<void>((resolve, reject) => {
    // Страховка от зависшего обмена: своя ошибка вместо таймаута Vitest.
    socket.setTimeout(2_000, () => socket.destroy(new Error('raw exchange timed out')));
    socket.on('data', (chunk: Buffer) => {
      received.push(new Uint8Array(chunk));
    });
    socket.once('close', resolve);
    socket.once('error', reject);
    socket.once('connect', () => socket.end(frame));
  });
  return Buffer.concat(received).toString('utf8');
}

describe('on a real HTTP server', () => {
  it('answers 405 to a TRACE with a body before it reaches the handler', async () => {
    const { app, handler } = makeApp({ bodyLimitBytes: 10 });
    handler.mockImplementationOnce(
      async (request) => new Response(`handler read ${(await request.text()).length}`),
    );
    // Порт 0: свободный порт выдаёт система, параллельные прогоны не пересекаются.
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });

    try {
      await once(server, 'listening');
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('the server did not report a TCP port');
      }

      // Дыра воспроизводится только здесь: node-server собирает TRACE как GET без
      // потока (`request.body === null`), хотя тело в соединении есть.
      const raw = await rawExchange(
        address.port,
        `TRACE /tasks HTTP/1.1\r\nHost: web.local\r\nContent-Length: 11\r\nConnection: close\r\n\r\n${'x'.repeat(11)}`,
      );

      expect(raw).toMatch(/^HTTP\/1\.1 405 /);
      expect(raw).toContain('{"error":"Method not allowed"}');
      expect(handler).not.toHaveBeenCalled();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('resolveStaticFile', () => {
  it('returns null for the root itself', async () => {
    expect(await resolveStaticFile(staticRoot, '/')).toBeNull();
  });

  it('decides cacheability by the resolved file, not by the URL prefix', async () => {
    const asset = await resolveStaticFile(staticRoot, '/assets/app-abc123.js');
    const escaped = await resolveStaticFile(staticRoot, '/assets/../index.html');

    expect(escaped?.resolvedPath).toBe(path.join(staticRoot, 'index.html'));
    expect(asset?.cacheable).toBe(true);
    expect(escaped?.cacheable).toBe(false);
  });

  it('canonicalizes percent-encodings to the same resolved path (cache key)', async () => {
    const plain = await resolveStaticFile(staticRoot, '/assets/app-abc123.js');
    const encoded = await resolveStaticFile(staticRoot, '/assets/%61pp-%61bc123.js');
    expect(plain?.resolvedPath).toBe(encoded?.resolvedPath);
    expect(plain?.resolvedPath).toContain('app-abc123.js');
  });

  it('returns null for a path outside the root before touching the filesystem', async () => {
    expect(await resolveStaticFile(staticRoot, '/../definitely-missing.txt')).toBeNull();
  });

  it('returns null for broken percent-encoding', async () => {
    expect(await resolveStaticFile(staticRoot, '/assets/%zz.js')).toBeNull();
  });
});

describe('isStartEntry', () => {
  it('accepts the { default: { fetch } } contract of the server build', () => {
    expect(
      isStartEntry({ default: { fetch: async (): Promise<Response> => new Response('x') } }),
    ).toBe(true);
  });

  it('rejects everything else so a stale or broken build fails closed at startup', () => {
    expect(isStartEntry(null)).toBe(false);
    expect(isStartEntry('module')).toBe(false);
    expect(isStartEntry({})).toBe(false);
    expect(isStartEntry({ default: {} })).toBe(false);
    expect(isStartEntry({ default: { fetch: 42 } })).toBe(false);
  });
});

describe('forwardHeaders', () => {
  it('drops hop-by-hop headers and content-length, keeps the rest', () => {
    const headers = new Headers({
      'content-type': 'application/json',
      'x-custom': 'v',
      connection: 'keep-alive',
      'transfer-encoding': 'chunked',
      'content-length': '42',
    });

    const forwarded = forwardHeaders(headers);

    expect(forwarded.get('content-type')).toBe('application/json');
    expect(forwarded.get('x-custom')).toBe('v');
    expect(forwarded.get('connection')).toBeNull();
    expect(forwarded.get('transfer-encoding')).toBeNull();
    expect(forwarded.get('content-length')).toBeNull();
  });
});
