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
 * Данные кэша после неудачного переключения. Откат строится от текущего
 * состояния кэша, а не от снимка до клика: пока мутация летела, в кэш могли
 * прийти свежие данные (фоновый refetch, другая мутация), и снимок их затёр бы.
 * Задача `id` получает из снимка `previous` ровно то, что применяла
 * оптимистика — `completed`; остальные её поля и остальной список остаются
 * как есть. Исходный массив не мутируется.
 *
 * Откатывать нечего — задача ушла из кэша, её нет в снимке или состояние уже
 * совпадает со снимком: возвращается тот же массив. Текущего состояния в кэше
 * нет — восстанавливается снимок, если он был.
 */
export function rollbackTaskToggle(
  tasks: Task[] | undefined,
  id: string,
  previous: Task[] | undefined,
): Task[] | undefined {
  if (!tasks) {
    return previous;
  }
  const before = previous?.find((task) => task.id === id);
  const current = tasks.find((task) => task.id === id);
  if (!before || !current || current.completed === before.completed) {
    return tasks;
  }
  return tasks.map((task) => (task.id === id ? { ...task, completed: before.completed } : task));
}
