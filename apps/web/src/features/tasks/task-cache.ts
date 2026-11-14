import type { Task } from '@repo/contracts';

/**
 * Чистые операции над данными кэша списка задач: без React, транспорта и
 * QueryClient. Хуки в use-tasks.ts применяют их к query-кэшу, тесты проверяют
 * напрямую в node-проекте.
 */

/**
 * Оптимистично применяет переключение задачи: новый массив с перевёрнутым
 * `completed`, исходный не мутируется. Неизвестный id оставляет содержимое
 * как есть; пустой кэш (undefined) остаётся пустым.
 */
export function applyTaskToggle(
  tasks: readonly Task[] | undefined,
  id: string,
): Task[] | undefined {
  return tasks?.map((task) => (task.id === id ? { ...task, completed: !task.completed } : task));
}

/**
 * Данные кэша после неудачной мутации: ровно снимок до неё — тот же массив,
 * без пересборки, чтобы отрисовка вернулась к прежнему состоянию без дёрганий.
 * Снимка не было (undefined) — восстанавливать нечего.
 */
export function rollbackTaskToggle(previous: Task[] | undefined): Task[] | undefined {
  return previous;
}
