import { notifyManager, QueryClient } from '@tanstack/react-query';
import { createRouter } from '@tanstack/react-router';
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query';

import { routeTree } from './routeTree.gen.ts';

export interface RouterContext {
  queryClient: QueryClient;
}

// Уведомления кэша в microtask, а не в setTimeout: оптимистичные обновления
// попадают в DOM до следующего кадра, без мигания старого состояния.
notifyManager.setScheduler(queueMicrotask);

export function getRouter() {
  // Новый QueryClient на каждый запрос SSR: кэш не утекает между пользователями.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 10_000 } },
  });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreload: 'intent',
  });
  setupRouterSsrQueryIntegration({ router, queryClient });
  return router;
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
