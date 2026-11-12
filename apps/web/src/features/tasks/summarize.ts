export interface TaskSummary {
  total: number;
  remaining: number;
}

export function summarizeTasks(tasks: readonly { completed: boolean }[]): TaskSummary {
  const remaining = tasks.filter((task) => !task.completed).length;
  return { total: tasks.length, remaining };
}

export function formatSummary({ total, remaining }: TaskSummary): string {
  if (total === 0) {
    return 'No tasks yet';
  }
  if (remaining === 0) {
    return `All ${total} done`;
  }
  return `${remaining} of ${total} remaining`;
}
