import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createWebServerApp,
  forwardHeaders,
  isStartEntry,
  resolveStaticFile,
} from './server-app.ts';

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

function makeApp(overrides: { staticRoot?: string } = {}) {
  const handler = makeHandler();
  const proxyFetch = makeProxyFetch();
  const app = createWebServerApp({
    apiUrl: API_URL,
    staticRoot: overrides.staticRoot ?? staticRoot,
    handler,
    proxyFetch,
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

describe('resolveStaticFile', () => {
  it('returns null for the root itself', async () => {
    expect(await resolveStaticFile(staticRoot, '/')).toBeNull();
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
