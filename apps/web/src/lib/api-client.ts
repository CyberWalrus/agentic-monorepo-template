import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { createTanstackQueryUtils } from '@orpc/tanstack-query';
import type { Contract } from '@repo/contracts';

/**
 * Один origin (ADR 0005): браузер ходит в `/rpc` своего web-сервера (прокси на
 * API собирается при старте из env), SSR — напрямую в API. Адрес API никогда
 * не запекается в сборку: инвариант «в клиентском бандле нет localhost-адресов»
 * сканирует шаг `bundle` (tools/check-bundle.ts).
 */
const rpcUrl = import.meta.env.SSR ? `${serverApiUrl()}/rpc` : `${location.origin}/rpc`;

/** `API_URL` обязателен только в серверном процессе: без него SSR не отрендерит данные. */
function serverApiUrl(): string {
  const url = process.env['API_URL'];
  if (!url) {
    throw new Error(
      'API_URL is empty: export it (e.g. `export API_URL=http://localhost:3001`, fixed ports until A5 PR-3) or run through `pnpm dev` / the e2e webServer',
    );
  }
  return url;
}

const api: ContractRouterClient<Contract> = createORPCClient(new RPCLink({ url: rpcUrl }));

/** Ключи и опции TanStack Query, выведенные из контракта. */
export const orpc = createTanstackQueryUtils(api);
