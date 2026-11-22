import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { createTanstackQueryUtils } from '@orpc/tanstack-query';
import type { Contract } from '@repo/contracts';

import { apiBaseUrl } from './env.ts';

/**
 * Один origin (ADR 0005): браузер ходит в `/rpc` своего web-сервера (прокси на
 * API собирается при старте из env), SSR — напрямую в API. Адрес API никогда
 * не запекается в сборку: инвариант «в клиентском бандле нет localhost-адресов»
 * сканирует шаг `bundle` (tools/check-bundle.ts). URL вычисляется на запрос,
 * а не при импорте: node-тесты (router-gate.test.ts) импортируют эту цепочку
 * без окружения SSR-процесса, и `location`/`API_URL` им не нужны. Чтение и
 * валидация окружения — в src/lib/env.ts (единственный модуль env, C3.0);
 * ветвление SSR/браузер живёт там же, чтобы минификатор выбрасывал SSR-ветку.
 */
const rpcUrl = () => `${apiBaseUrl()}/rpc`;

/**
 * Точка внедрения SSR-fetch (ADR 0020): server entry (`src/server.ts`)
 * регистрирует реализацию, добавляющую workspace документа-запроса к запросам
 * к API — SSR ходит напрямую, мимо прокси (ADR 0005), и без заголовка
 * префетчил бы «ничей» (пустой) список. В браузере регистрация не происходит:
 * модуль ssr-workspace импортирует только серверная точка входа, клиентский
 * бандл его не содержит вовсе (гейт `bundle`), а заголовок приносит сам
 * браузерный контекст (E2E — extraHTTPHeaders).
 */
let ssrFetchImpl: typeof fetch | null = null;

export function registerSsrFetch(impl: typeof fetch): void {
  ssrFetchImpl = impl;
}

const rpcFetch: typeof fetch = (input, init) =>
  ssrFetchImpl === null ? fetch(input, init) : ssrFetchImpl(input, init);

/** oRPC-клиент контракта: экспортирован для node-тестов SSR-регистрации. */
export const api: ContractRouterClient<Contract> = createORPCClient(
  new RPCLink({ url: rpcUrl, fetch: rpcFetch }),
);

/** Ключи и опции TanStack Query, выведенные из контракта. */
export const orpc = createTanstackQueryUtils(api);
