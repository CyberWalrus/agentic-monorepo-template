import { AsyncLocalStorage } from 'node:async_hooks';

import { WORKSPACE_HEADER, parseWorkspaceId } from '@repo/contracts';

/**
 * Рабочее пространство SSR-запроса (ADR 0020). Модуль — серверный: импортирует
 * node:async_hooks и живёт только в SSR-ветках (server entry `src/server.ts`
 * и SSR-ветка fetch RPCLink в api-client.ts); клиентская сборка выбрасывает
 * эти ветки вместе с модулем (SSR-флаг из env-модуля — гейт `bundle`).
 *
 * Зачем: лоадер `/` префетчит список задач на сервере напрямую в API (RPCLink,
 * мимо прокси `/rpc`). Без workspace-заголовка SSR рендерил бы «ничей» (пустой)
 * список, и при staleTime клиент не перезапрашивал бы его после гидратации —
 * сидированные в рабочее пространство задачи E2E никогда не появились бы на
 * странице (план-ревью c1.5).
 */

interface RequestWorkspace {
  workspaceId: string | null;
}

const storage = new AsyncLocalStorage<RequestWorkspace>();

/** Рабочее пространство документа-запроса в AsyncLocalStorage для SSR-fetch. */
export function runWithRequestWorkspace<T>(request: Request, fn: () => Promise<T>): Promise<T> {
  return storage.run({ workspaceId: parseWorkspaceId(request.headers.get(WORKSPACE_HEADER)) }, fn);
}

/**
 * Fetch для SSR-путей RPCLink: добавляет workspace-заголовок документа-запроса
 * к запросу к API. Вне AsyncLocalStorage (node-тесты, ручные вызовы) —
 * заголовка нет: запрос остаётся «ничей».
 */
export async function ssrFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const store = storage.getStore();
  const headers = new Headers(init?.headers);
  if (store !== undefined && store.workspaceId !== null && !headers.has(WORKSPACE_HEADER)) {
    headers.set(WORKSPACE_HEADER, store.workspaceId);
  }
  return fetch(input, { ...init, headers });
}
