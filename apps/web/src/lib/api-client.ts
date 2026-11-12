import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { createTanstackQueryUtils } from '@orpc/tanstack-query';
import type { Contract } from '@repo/contracts';

const apiUrl = import.meta.env['VITE_API_URL'] ?? 'http://localhost:3001';

const api: ContractRouterClient<Contract> = createORPCClient(new RPCLink({ url: `${apiUrl}/rpc` }));

/** Ключи и опции TanStack Query, выведенные из контракта. */
export const orpc = createTanstackQueryUtils(api);
