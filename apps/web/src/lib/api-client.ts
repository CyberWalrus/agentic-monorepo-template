import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { createTanstackQueryUtils } from '@orpc/tanstack-query';
import type { Contract } from '@repo/contracts';

import { apiBaseUrl, isSsr } from './env.ts';

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
 * SSR ходит в API напрямую (ADR 0005), мимо прокси: workspace документа-запроса
 * добавляется в этой точке (ADR 0020), иначе лоадер `/` префетчит «ничей»
 * (пустой) список. Браузерная ветка — обычный fetch: заголовок приносит сам
 * браузерный контекст (E2E — extraHTTPHeaders; продуктовые клиенты — свои
 * механизмы по мере появления арендаторов). Серверная ветка с модулем
 * ssr-workspace выбрасывается из клиентского бандла tree-shaking'ом
 * (SSR-флаг из env-модуля — гейт `bundle`).
 */
const rpcFetch: typeof fetch = (input, init) => {
  if (!isSsr()) {
    return fetch(input, init);
  }
  return import('./ssr-workspace.ts').then(({ ssrFetch }) => ssrFetch(input, init));
};

const api: ContractRouterClient<Contract> = createORPCClient(
  new RPCLink({ url: rpcUrl, fetch: rpcFetch }),
);

/** Ключи и опции TanStack Query, выведенные из контракта. */
export const orpc = createTanstackQueryUtils(api);
