import { createMemoryHistory } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';

import { getRouter } from './router.tsx';

/**
 * Гейт состояний маршрута (roadmap C5): каждый маршрут дерева обязан
 * показывать пользователю error, pending и not-found состояния — свои
 * или унаследованные от дефолтов роутера. Явное отключение
 * (`errorComponent: false`) — тоже нарушение.
 */

const stateOptions = ['errorComponent', 'pendingComponent', 'notFoundComponent'] as const;

describe('route states gate', () => {
  const router = getRouter({ history: createMemoryHistory({ initialEntries: ['/'] }) });
  const routes = Object.values(router.routesById);

  it('has more than just the root route', () => {
    expect(routes.length).toBeGreaterThan(1);
  });

  it('configures default state components on the router', () => {
    expect(
      router.options.defaultErrorComponent,
      'router.options.defaultErrorComponent must be set in getRouter()',
    ).toBeTypeOf('function');
    expect(
      router.options.defaultPendingComponent,
      'router.options.defaultPendingComponent must be set in getRouter()',
    ).toBeTypeOf('function');
    expect(
      router.options.defaultNotFoundComponent,
      'router.options.defaultNotFoundComponent must be set in getRouter()',
    ).toBeTypeOf('function');
  });

  it('resolves an error, pending and not-found component for every route', () => {
    const defaults = {
      errorComponent: router.options.defaultErrorComponent,
      pendingComponent: router.options.defaultPendingComponent,
      notFoundComponent: router.options.defaultNotFoundComponent,
    };

    for (const route of routes) {
      for (const option of stateOptions) {
        const effective = route.options[option] ?? defaults[option];
        expect(
          effective,
          `route "${route.id}" must define ${option} or inherit the router default`,
        ).toBeTypeOf('function');
      }
    }
  });
});
