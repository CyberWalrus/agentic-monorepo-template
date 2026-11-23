import type { Task } from '@repo/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Suspense } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { orpc } from '../../lib/api-client.ts';
import { TasksPage } from './tasks-page.tsx';
import { useCreateTask, useToggleTask, useTasks } from './use-tasks.ts';

/**
 * use-tasks.ts — конкурентность оптимистики: guard refetchAfterLastMutation,
 * cancelQueries перед мутацией, откат при ошибке. Транспорт подменяется на
 * deferred-промисы, которыми тест управляет вручную (паттерн deferred из
 * tasks-page.test.tsx), а ключи и options строит настоящий
 * @orpc/tanstack-query — проверяется реальная логика хуков над query-кэшем.
 */
const transport = vi.hoisted(() => {
  type Transport = {
    list: () => Promise<Task[]>;
    create: (input: { title: string }) => Promise<Task>;
    toggle: (input: { id: string }) => Promise<Task>;
  };

  // vi.hoisted самодостаточен: ссылаться на функции внешней области нельзя.
  const stubbed: Transport = {
    list: () => {
      throw new Error('transport is not configured for this test');
    },
    create: () => {
      throw new Error('transport is not configured for this test');
    },
    toggle: () => {
      throw new Error('transport is not configured for this test');
    },
  };

  return stubbed;
});

vi.mock('../../lib/api-client.ts', async () => {
  const { createTanstackQueryUtils } = await import('@orpc/tanstack-query');

  return {
    orpc: createTanstackQueryUtils({
      tasks: {
        list: () => transport.list(),
        create: (input: { title: string }) => transport.create(input),
        toggle: (input: { id: string }) => transport.toggle(input),
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

const dog: Task = {
  id: '00000000-0000-4000-8000-000000000002',
  title: 'Walk the dog',
  completed: true,
  createdAt: '2026-11-01T09:00:00.000Z',
};

const listKey = orpc.tasks.list.queryKey();

function TaskScreen() {
  const tasks = useTasks();
  const onCreate = useCreateTask();
  const onToggle = useToggleTask();

  return <TasksPage tasks={tasks} onCreate={onCreate} onToggle={onToggle} />;
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
}

function deferredTask() {
  let resolve!: (task: Task) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Task>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Состояние «сервера»: тесты коммитят мутации вручную, list отдаёт текущее. */
function fakeServer(tasks: Task[]) {
  const state = tasks.map((task) => ({ ...task }));
  return {
    tasks: state,
    commitToggle: (id: string) => {
      const task = state.find((item) => item.id === id);
      if (!task) throw new Error(`unknown task ${id}`);
      task.completed = !task.completed;
    },
    add: (task: Task) => {
      state.push({ ...task });
    },
  };
}

type Server = ReturnType<typeof fakeServer>;

interface PendingToggle {
  resolve: (task: Task) => void;
  reject: (error: Error) => void;
}

/** toggle замирает на deferred-промисе, пока тест его не завершит. */
function stubToggle(server: Server) {
  const pending = new Map<string, PendingToggle>();

  transport.list = async () => server.tasks.map((task) => ({ ...task }));
  transport.toggle = (input) => {
    const task = server.tasks.find((item) => item.id === input.id);
    if (!task) throw new Error(`unknown task ${input.id}`);
    const pendingTask = deferredTask();
    pending.set(input.id, pendingTask);
    return pendingTask.promise;
  };

  return {
    settleToggle: (id: string) => {
      server.commitToggle(id);
      const task = server.tasks.find((item) => item.id === id);
      const pendingToggle = pending.get(id);
      pending.delete(id);
      if (!task || !pendingToggle) throw new Error(`no pending toggle for ${id}`);
      pendingToggle.resolve({ ...task });
    },
    failToggle: (id: string, error: Error) => {
      const pendingToggle = pending.get(id);
      pending.delete(id);
      if (!pendingToggle) throw new Error(`no pending toggle for ${id}`);
      pendingToggle.reject(error);
    },
  };
}

function settledMarker(variables: unknown) {
  return `settled ${JSON.stringify(variables)}`;
}

/**
 * Журнал событий в порядке прихода: 'refetch' — старт refetch'а списка (action
 * 'fetch' внутри updated-события кэша); 'data' — запись в кэш (оптимистика и
 * ответы сервера); 'settled' — onSettled мутации отработал (dispatch success в
 * TanStack идёт после onSettled, поэтому маркер надёжно отделяет «мутация
 * завершена» от «refetch запущен»).
 */
function observeCache(client: QueryClient) {
  const log: string[] = [];
  const cacheWrites: Task[][] = [];
  const listQueryKey = JSON.stringify(listKey);

  client.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated') return;
    const { query, action } = event;
    if (JSON.stringify(query.queryKey) !== listQueryKey) return;
    if (action.type === 'fetch') {
      log.push('refetch');
    }
    if (action.type === 'success') {
      const data = client.getQueryData<Task[]>(listKey);
      if (data) cacheWrites.push(data);
      log.push('data');
    }
  });

  client.getMutationCache().subscribe((event) => {
    if (event.type === 'updated' && event.action.type === 'success') {
      log.push(settledMarker(event.mutation.state.variables));
    }
  });

  return { log, cacheWrites };
}

async function renderTasksScreen(client: QueryClient, tasks: Task[]) {
  client.setQueryData<Task[]>(listKey, tasks);

  return render(
    <QueryClientProvider client={client}>
      <Suspense fallback={<p>Loading tasks…</p>}>
        <TaskScreen />
      </Suspense>
    </QueryClientProvider>,
  );
}

describe('use-tasks concurrency', () => {
  it('keeps the optimistic toggle when a refetch would land between two mutations', async () => {
    const server = fakeServer([milk, dog]);
    const { settleToggle } = stubToggle(server);
    const client = createQueryClient();
    const { log, cacheWrites } = observeCache(client);
    const screen = await renderTasksScreen(client, [milk, dog]);

    await screen.getByRole('checkbox', { name: 'Buy milk' }).click();
    await screen.getByRole('checkbox', { name: 'Walk the dog' }).click();

    await expect.element(screen.getByRole('checkbox', { name: 'Buy milk' })).toBeChecked();
    await expect.element(screen.getByRole('checkbox', { name: 'Walk the dog' })).not.toBeChecked();
    const writesBeforeWindow = cacheWrites.length;

    settleToggle(milk.id);
    await vi.waitFor(() => expect(log).toContain(settledMarker({ id: milk.id })));

    // Сломанный guard запустил бы здесь refetch с промежуточным ответом
    // сервера, где dog ещё завершён, — и он затёр бы оптимистичное состояние.
    expect(log.filter((entry) => entry === 'refetch')).toHaveLength(0);
    await expect.element(screen.getByRole('checkbox', { name: 'Walk the dog' })).not.toBeChecked();

    settleToggle(dog.id);
    await vi.waitFor(() => expect(log).toContain(settledMarker({ id: dog.id })));
    await vi.waitFor(() => expect(log.filter((entry) => entry === 'refetch')).toHaveLength(1));
    await expect.element(screen.getByText('1 of 2 remaining')).toBeVisible();

    const windowWrites = cacheWrites.slice(writesBeforeWindow);
    expect(windowWrites.length, 'cache writes in the concurrency window').toBeGreaterThan(0);
    for (const tasks of windowWrites) {
      const dogInCache = tasks.find((task) => task.id === dog.id);
      expect(dogInCache?.completed, 'dog stays optimistically uncompleted').toBe(false);
    }
  });

  it('rolls the optimistic toggle back when the mutation fails', async () => {
    const server = fakeServer([milk, dog]);
    const { failToggle } = stubToggle(server);
    const client = createQueryClient();
    const screen = await renderTasksScreen(client, [milk, dog]);

    await screen.getByRole('checkbox', { name: 'Buy milk' }).click();
    await expect.element(screen.getByRole('checkbox', { name: 'Buy milk' })).toBeChecked();

    failToggle(milk.id, new Error('Network down'));

    await expect
      .element(screen.getByRole('alert'))
      .toHaveTextContent('Could not update the task. Try again.');
    await expect.element(screen.getByRole('checkbox', { name: 'Buy milk' })).not.toBeChecked();

    await vi.waitFor(() =>
      expect(client.getQueryData<Task[]>(listKey), 'cache restored to the server truth').toEqual([
        milk,
        dog,
      ]),
    );
  });

  it('refetches exactly once after the last mutation settles', async () => {
    const server = fakeServer([milk, dog]);
    const { settleToggle } = stubToggle(server);
    const client = createQueryClient();
    const { log } = observeCache(client);
    const screen = await renderTasksScreen(client, [milk, dog]);

    await screen.getByRole('checkbox', { name: 'Buy milk' }).click();
    await screen.getByRole('checkbox', { name: 'Walk the dog' }).click();

    expect(log.filter((entry) => entry === 'refetch')).toHaveLength(0);

    settleToggle(milk.id);
    await vi.waitFor(() => expect(log).toContain(settledMarker({ id: milk.id })));
    expect(log.filter((entry) => entry === 'refetch')).toHaveLength(0);

    // Параллельный писатель на сервере: увидеть его можно только через refetch.
    server.add({
      id: '00000000-0000-4000-8000-000000000003',
      title: 'From another tab',
      completed: false,
      createdAt: '2026-11-01T11:00:00.000Z',
    });

    settleToggle(dog.id);
    await vi.waitFor(() => expect(log).toContain(settledMarker({ id: dog.id })));
    await vi.waitFor(() => expect(log.filter((entry) => entry === 'refetch')).toHaveLength(1));

    // Единственный refetch случился после последней мутации, не между ними.
    expect(log.indexOf('refetch')).toBeGreaterThan(log.indexOf(settledMarker({ id: milk.id })));
    await expect.element(screen.getByText('From another tab')).toBeVisible();
  });

  it('counts create and toggle in one mutation family and refetches once', async () => {
    const server = fakeServer([milk, dog]);
    const { settleToggle } = stubToggle(server);
    const createdTask: Task = {
      id: '00000000-0000-4000-8000-000000000003',
      title: 'Read the spec',
      completed: false,
      createdAt: '2026-11-01T12:00:00.000Z',
    };
    const created = deferredTask();
    transport.create = () => created.promise;
    const client = createQueryClient();
    const { log } = observeCache(client);
    const screen = await renderTasksScreen(client, [milk, dog]);

    await screen.getByLabelText('New task').fill('Read the spec');
    await screen.getByRole('button', { name: 'Add task' }).click();
    await screen.getByRole('checkbox', { name: 'Walk the dog' }).click();

    server.add(createdTask);
    created.resolve(createdTask);
    await vi.waitFor(() => expect(log).toContain(settledMarker({ title: 'Read the spec' })));

    // toggle ещё в полёте: create и toggle считаются одним семейством мутаций,
    // guard по базовому ключу orpc.tasks.key() держит refetch до последней.
    expect(log.filter((entry) => entry === 'refetch')).toHaveLength(0);

    settleToggle(dog.id);
    await vi.waitFor(() => expect(log).toContain(settledMarker({ id: dog.id })));
    await vi.waitFor(() => expect(log.filter((entry) => entry === 'refetch')).toHaveLength(1));

    // Созданная задача видна только после refetch: create без оптимистики в
    // списке, новая запись приходит с сервера ровно один раз.
    await expect.element(screen.getByText('Read the spec')).toBeVisible();
    await expect.element(screen.getByRole('checkbox', { name: 'Walk the dog' })).not.toBeChecked();
  });
});
