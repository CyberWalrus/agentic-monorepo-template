import type { Task } from '@repo/contracts';
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
  type QueryClient,
} from '@tanstack/react-query';

import { orpc } from '../../lib/api-client.ts';

import { applyTaskToggle, rollbackTaskToggle } from './task-cache.ts';

const listKey = orpc.tasks.list.queryKey();

export const tasksListQuery = orpc.tasks.list.queryOptions();

export function useTasks() {
  return useSuspenseQuery(tasksListQuery).data;
}

/**
 * Перезапрашиваем список только после последней мутации задач. Иначе refetch,
 * стартовавший между двумя мутациями, вернёт промежуточное состояние и затрёт
 * оптимистичное обновление.
 */
async function refetchAfterLastMutation(queryClient: QueryClient) {
  if (queryClient.isMutating({ mutationKey: orpc.tasks.key() }) === 1) {
    await queryClient.invalidateQueries({ queryKey: listKey });
  }
}

export function useCreateTask() {
  const queryClient = useQueryClient();
  const mutation = useMutation(
    orpc.tasks.create.mutationOptions({
      onSettled: () => refetchAfterLastMutation(queryClient),
    }),
  );
  return async (title: string) => {
    await mutation.mutateAsync({ title });
  };
}

export function useToggleTask() {
  const queryClient = useQueryClient();
  const mutation = useMutation(
    orpc.tasks.toggle.mutationOptions({
      onSettled: () => refetchAfterLastMutation(queryClient),
    }),
  );

  return async (id: string) => {
    // Оптимистичное обновление синхронно в обработчике клика: управляемый чекбокс
    // не откатывается ни на кадр. Кэш — единственный источник правды, без оверлеев.
    // Логика над данными кэша — в task-cache.ts, здесь только применение к query-кэшу.
    const previous = queryClient.getQueryData<Task[]>(listKey);
    queryClient.setQueryData<Task[]>(listKey, (tasks) => applyTaskToggle(tasks, id));
    // Устаревший refetch в полёте не должен затереть оптимистичные данные.
    await queryClient.cancelQueries({ queryKey: listKey }, { revert: false });
    try {
      await mutation.mutateAsync({ id });
    } catch (error) {
      const restored = rollbackTaskToggle(previous);
      if (restored) {
        queryClient.setQueryData(listKey, restored);
      }
      throw error;
    }
  };
}
