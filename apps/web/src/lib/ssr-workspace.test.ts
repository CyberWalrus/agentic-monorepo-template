import { afterEach, describe, expect, it, vi } from 'vitest';

import { WORKSPACE_HEADER } from '@repo/contracts';

import { api, registerSsrFetch } from './api-client.ts';
import { runWithRequestWorkspace, ssrFetch } from './ssr-workspace.ts';

const respond = (): Response => new Response('ok');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  // Сброс регистрации: следующий тест без внедрения идёт через plain fetch.
  registerSsrFetch(fetch);
});

describe('ssrFetch workspace header (ADR 0020)', () => {
  it('forwards the workspace of the document request to the API call', async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init));
        return respond();
      }),
    );

    await runWithRequestWorkspace(
      new Request('http://web.test/', { headers: { [WORKSPACE_HEADER]: 'ws-e2e' } }),
      () => ssrFetch('http://api.test/rpc/tasks/list', { method: 'POST' }),
    );

    expect(requests.at(0)?.headers.get(WORKSPACE_HEADER)).toBe('ws-e2e');
  });

  it('sends no header outside a workspace context (node tests, manual calls)', async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init));
        return respond();
      }),
    );

    await ssrFetch('http://api.test/rpc/tasks/list', { method: 'POST' });

    expect(requests.at(0)?.headers.get(WORKSPACE_HEADER)).toBeNull();
  });

  it('keeps a malformed document header out of API calls: the ownerless scope', async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init));
        return respond();
      }),
    );

    await runWithRequestWorkspace(
      new Request('http://web.test/', { headers: { [WORKSPACE_HEADER]: 'not a valid id' } }),
      () => ssrFetch('http://api.test/rpc/tasks/list', { method: 'POST' }),
    );

    expect(requests.at(0)?.headers.get(WORKSPACE_HEADER)).toBeNull();
  });
});

describe('api-client SSR registration (ADR 0020)', () => {
  it('routes oRPC calls through the registered SSR fetch carrying the workspace header', async () => {
    vi.stubEnv('API_URL', 'http://api.test');
    const requests: Request[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init));
        // Тело ответа не важно: проверяется запрос, парсинг протокола вне теста.
        return respond();
      }),
    );
    // Как делает server entry (src/server.ts) в SSR-процессе.
    registerSsrFetch(ssrFetch);

    // Ошибка парсинга заглушечного ответа не важна: фиксируется уход запроса.
    await runWithRequestWorkspace(
      new Request('http://web.test/', { headers: { [WORKSPACE_HEADER]: 'ws-doc' } }),
      async () => api.tasks.list(),
    ).catch(() => undefined);

    expect(requests.at(0)?.url).toContain('/rpc');
    expect(requests.at(0)?.headers.get(WORKSPACE_HEADER)).toBe('ws-doc');
  });
});
