import { Hono, type Context } from 'hono';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Production-сервер web (C3.2): тонкий Node-entry поверх сборки TanStack Start.
 * Композиция фиксирована ADR 0012 и ADR 0005:
 *   1. `/healthz` — readiness процесса;
 *   2. `/rpc` — единственное, что проксируется на API (ADR 0005): браузер ходит
 *      в свой origin, сборка не зависит от адреса API;
 *   3. статика клиентской сборки из `staticRoot` (dist/client);
 *   4. всё остальное — fetch-обработчик серверной сборки TanStack Start
 *      (dist/server/server.js экспортирует `{ default: { fetch } }`).
 * Логика — здесь (unit-тесты без сети и файлов приложения), проводка — в
 * `server.ts` в корне пакета.
 */

type StartHandler = (request: Request) => Promise<Response>;

/** Контракт серверной сборки TanStack Start (ADR 0012): `vite build` пишет `{ default: { fetch } }`. */
export interface StartEntry {
  default: { fetch: StartHandler };
}

/**
 * Проверяет контракт серверной сборки перед использованием: устаревший или
 * битый `dist/server/server.js` — отказ при старте со внятной ошибкой, а не
 * падение на первом запросе.
 */
export function isStartEntry(value: unknown): value is StartEntry {
  if (typeof value !== 'object' || value === null || !('default' in value)) {
    return false;
  }
  const mod: unknown = value.default;
  if (typeof mod !== 'object' || mod === null || !('fetch' in mod)) {
    return false;
  }
  return typeof mod.fetch === 'function';
}

export interface WebServerAppOptions {
  /** Адрес API: единственная цель прокси `/rpc` (ADR 0005). */
  apiUrl: string;
  /** Корень статики клиентской сборки (dist/client), абсолютный путь. */
  staticRoot: string;
  /** Fetch-обработчик серверной сборки TanStack Start. */
  handler: StartHandler;
  /**
   * Сеть вводится параметром: unit-тесты гоняют прокси без настоящих
   * соединений. По умолчанию — глобальный fetch.
   */
  proxyFetch?: typeof fetch;
}

/** Заголовки уровня соединения: между прокси и API не переносятся (в обе стороны). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Потолок тела RPC-запроса: RPC — небольшие JSON; 1 MiB с запасом. */
const MAX_RPC_BODY_BYTES = 1024 * 1024;

/** Таймаут прокси на API: обрыв идёт в общий catch как 502. */
const PROXY_TIMEOUT_MS = 30_000;

// Whitelist раздаваемых типов: файл с неизвестным расширением статики не
// считается — SSR-обработчик сам решит, что это (обычно 404). Странным путём
// из dist/client наружу ничего не уйдёт.
const STATIC_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

export interface StaticFile {
  /** Копия файла в свежем ArrayBuffer: BodyInit требует ArrayBufferView<ArrayBuffer>. */
  body: Uint8Array<ArrayBuffer>;
  contentType: string;
  /** `/assets/*` — хешированные имена клиентской сборки: кэш навсегда. */
  cacheable: boolean;
}

/**
 * Резолвит путь запроса в файл внутри `staticRoot`. Возвращает null, если
 * файла нет, это каталог или расширение не из whitelist — тогда запрос идёт
 * SSR-обработчику. Защита от traversal: битый percent-encoding, null-byte и
 * вылет за корень запрещены; символические ссылки не раздаём — корень пишет
 * только `vite build`.
 */
export async function resolveStaticFile(
  staticRoot: string,
  pathname: string,
): Promise<StaticFile | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) {
    return null;
  }
  const resolved = path.resolve(staticRoot, `.${decoded}`);
  const insideRoot = resolved !== staticRoot && resolved.startsWith(staticRoot + path.sep);
  if (!insideRoot) {
    return null;
  }
  // lstat, а не stat: симлинк не раздаём даже внутри корня — наружу уходит
  // только то, что положил `vite build` (защита в глубину от подмены корня).
  const stat = await fs.lstat(resolved).catch(() => null);
  if (stat === null || !stat.isFile()) {
    return null;
  }
  const contentType = STATIC_CONTENT_TYPES[path.extname(resolved).toLowerCase()];
  if (contentType === undefined) {
    return null;
  }
  // new Uint8Array копирует в свежий ArrayBuffer: Buffer из node:fs —
  // ArrayBufferLike, а BodyInit из lib.dom требует ArrayBufferView<ArrayBuffer>.
  return {
    body: new Uint8Array(await fs.readFile(resolved)),
    contentType,
    cacheable: decoded.startsWith('/assets/'),
  };
}

/** Экспортирован для unit-тестов: hop-by-hop заголовки нельзя задать через Request — undici запрещает их в init. */
export function forwardHeaders(headers: Headers): Headers {
  const forwarded = new Headers();
  for (const [name, value] of headers) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) {
      // append, а не set: повторяющиеся заголовки запроса (например cookie)
      // обязаны дойти по одному значению на строку.
      forwarded.append(name, value);
    }
  }
  // content-length пересчитывается по реальному телу: расхождение после
  // буферизации сломало бы запрос молча.
  forwarded.delete('content-length');
  return forwarded;
}

/** Зеркально forwardHeaders для ответа API: hop-by-hop и content-length не едут наружу. */
function filterResponseHeaders(headers: Headers): Headers {
  const filtered = new Headers();
  for (const [name, value] of headers) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) {
      filtered.append(name, value);
    }
  }
  filtered.delete('content-length');
  return filtered;
}

export function createWebServerApp(options: WebServerAppOptions): Hono {
  const { apiUrl, staticRoot, handler } = options;
  const proxyFetch = options.proxyFetch ?? fetch;
  const app = new Hono();

  // Readiness-зонд контейнера: процесс поднялся и слушает. Имя — /healthz:
  // /health занят API, и его доступность через web-origin запрещена
  // e2e-тестом api-origin [AC-2] (только /rpc проксируется, ADR 0005).
  app.on(['GET', 'HEAD'], '/healthz', (c) => c.json({ status: 'ok' }));

  const proxyRpc = async (c: Context): Promise<Response> => {
    const incoming = c.req.raw;
    const target = new URL(incoming.url);
    const api = new URL(apiUrl);
    target.protocol = api.protocol;
    target.host = api.host;

    // Тело буферизуется: RPC-запросы — небольшие JSON, стриминг не нужен, а
    // ArrayBuffer избавляет от требований undici к duplex у стримов. Потолок
    // отбивает дешёвый memory-DoS большими телами (413 до буферизации — по
    // content-length, после — по фактическим байтам, e.g. chunked).
    const hasBody = incoming.method !== 'GET' && incoming.method !== 'HEAD';
    const declaredLength = Number(incoming.headers.get('content-length') ?? 0);
    if (hasBody && declaredLength > MAX_RPC_BODY_BYTES) {
      return c.json({ error: 'RPC request body is too large' }, 413);
    }
    const buffered = hasBody ? await incoming.arrayBuffer() : undefined;
    if (buffered !== undefined && buffered.byteLength > MAX_RPC_BODY_BYTES) {
      return c.json({ error: 'RPC request body is too large' }, 413);
    }
    const init: RequestInit = {
      method: incoming.method,
      headers: forwardHeaders(incoming.headers),
      // Зависший API не держит соединение вечно: 30 c с запасом против
      // p95 api (миллисекунды); обрыв идёт в общий catch как 502.
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
      redirect: 'manual',
    };
    if (buffered !== undefined && buffered.byteLength > 0) {
      init.body = buffered;
    }
    try {
      const upstream = await proxyFetch(new Request(target, init));
      // Hop-by-hop фильтруется и на ответе: скомпрометированный или ошибочный
      // API не должен навязывать connection-семантику клиенту и посредникам.
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: filterResponseHeaders(upstream.headers),
      });
    } catch {
      // Внутренности ошибки (адреса, коды ОС) наружу не идут.
      return c.json({ error: 'API is unreachable' }, 502);
    }
  };
  app.all('/rpc', proxyRpc);
  app.all('/rpc/*', proxyRpc);

  app.on(['GET', 'HEAD'], '*', async (c) => {
    const pathname = new URL(c.req.raw.url).pathname;
    const file = await resolveStaticFile(staticRoot, pathname);
    if (file === null) {
      // Не статика — SSR: страницы, не найденные маршруты, 404 обработчика.
      return handler(c.req.raw);
    }
    const headers = new Headers({ 'content-type': file.contentType });
    if (file.cacheable) {
      headers.set('cache-control', 'public, max-age=31536000, immutable');
    }
    return new Response(c.req.method === 'HEAD' ? null : file.body, { headers });
  });

  // Не-GET/HEAD (server functions TanStack Start, POST-маршруты) мимо статики.
  app.all('*', (c) => handler(c.req.raw));

  return app;
}
