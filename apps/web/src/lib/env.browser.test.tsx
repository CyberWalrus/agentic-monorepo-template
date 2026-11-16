import { expect, it } from 'vitest';

import { apiBaseUrl } from './env.ts';

// Браузерная ветвь (ADR 0005): в браузерном проекте vitest флаг SSR подставлен
// как false — база RPC-адреса это собственный origin страницы, env не читается.
it('uses the page origin as the RPC base in the browser', () => {
  expect(apiBaseUrl()).toBe(location.origin);
});
