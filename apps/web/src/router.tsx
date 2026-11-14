import { notifyManager, QueryClient } from '@tanstack/react-query';
import { createRouter, type RouterHistory } from '@tanstack/react-router';
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query';

import { RouteError, RouteNotFound, RoutePending } from './lib/route-states.tsx';
import { routeTree } from './routeTree.gen.ts';

export interface RouterContext {
  queryClient: QueryClient;
}

// Уведомления кэша в microtask, а не в setTimeout: оптимистичные обновления
// попадают в DOM до следующего кадра, без мигания старого состояния.
notifyManager.setScheduler(queueMicrotask);

export function getRouter(options: { history?: RouterHistory } = {}) {
  // Новый QueryClient на каждый запрос SSR: кэш не утекает между пользователями.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 10_000 } },
  });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    // history подменяет только гейт-тест (memory history в node); приложение
    // использует историю браузера при старте.
    ...(options.history ? { history: options.history } : {}),
    scrollRestoration: true,
    defaultPreload: 'intent',
    // Состояния маршрута по умолчанию (roadmap C5): каждый маршрут обязан
    // показывать пользователю error, pending и not-found; гейт-тест
    // (router-gate.test.ts) падает при их удалении.
    defaultErrorComponent: RouteError,
    defaultPendingComponent: RoutePending,
    defaultNotFoundComponent: RouteNotFound,
  });
  setupRouterSsrQueryIntegration({ router, queryClient });
  return router;
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
