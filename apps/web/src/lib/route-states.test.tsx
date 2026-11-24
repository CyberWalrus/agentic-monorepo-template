import type { Task } from '@repo/contracts';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { getRouter } from '../router.tsx';
import { RouteNotFound } from './route-states.tsx';

/**
 * Повтор проверяется на настоящем роутере приложения: loader `/` падает,
 * «Try again» обязан прогнать его заново и вернуть страницу. Транспорт
 * подменяется на границе api-client (паттерн use-tasks.test.tsx) — проверяется
 * связка «кнопка → роутер → loader», а не вызов мока `reset`: сам по себе
 * `reset` только сбрасывает границу ошибок и loader не перезапускает (e61).
 */
const transport = vi.hoisted(() => {
  type ListTasks = () => Promise<Task[]>;

  // vi.hoisted самодостаточен: ссылаться на функции внешней области нельзя.
  const stubbed: { list: ListTasks } = {
    list: () => {
      throw new Error('transport is not configured for this test');
    },
  };

  return stubbed;
});

vi.mock('./api-client.ts', async () => {
  const { createTanstackQueryUtils } = await import('@orpc/tanstack-query');

  return {
    orpc: createTanstackQueryUtils({
      tasks: {
        list: () => transport.list(),
        create: () => {
          throw new Error('transport is not configured for this test');
        },
        toggle: () => {
          throw new Error('transport is not configured for this test');
        },
      },
    }),
  };
});

const milk: Task = {
  id: '00000000-0000-4000-8000-000000000001',
  title: 'Buy milk',
  completed: false,
  createdAt: '2026-11-01T10:00:00.000Z',
};

describe('route error state', () => {
  it('re-runs the failed load on "Try again" and restores the page', async () => {
    const list = vi
      .fn<() => Promise<Task[]>>()
      .mockRejectedValueOnce(new Error('API is unreachable'))
      .mockResolvedValue([milk]);
    transport.list = list;
    const router = getRouter({ history: createMemoryHistory({ initialEntries: ['/'] }) });
    const screen = await render(<RouterProvider router={router} />);

    const alert = screen.getByRole('alert');
    await expect.element(alert).toBeVisible();
    await expect
      .element(alert.getByRole('heading', { name: 'Something went wrong' }))
      .toBeVisible();
    expect(list).toHaveBeenCalledOnce();

    await screen.getByRole('button', { name: 'Try again' }).click();

    await expect.element(alert).not.toBeInTheDocument();
    await expect.element(screen.getByRole('heading', { name: 'Tasks' })).toBeVisible();
    await expect.element(screen.getByRole('checkbox', { name: 'Buy milk' })).toBeVisible();
    expect(list).toHaveBeenCalledTimes(2);
  });
});

describe('RouteNotFound', () => {
  it('renders in a main landmark with a way back to the tasks', async () => {
    const screen = await render(<RouteNotFound />);

    await expect.element(screen.getByRole('main')).toBeVisible();
    await expect.element(screen.getByRole('link', { name: 'Back to tasks' })).toBeVisible();
  });
});
