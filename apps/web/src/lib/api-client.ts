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

const api: ContractRouterClient<Contract> = createORPCClient(new RPCLink({ url: rpcUrl }));

/** Ключи и опции TanStack Query, выведенные из контракта. */
export const orpc = createTanstackQueryUtils(api);
