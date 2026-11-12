import { createFileRoute } from '@tanstack/react-router';

import { TasksPage } from '../features/tasks/TasksPage.tsx';
import {
  tasksListQuery,
  useCreateTask,
  useTasks,
  useToggleTask,
} from '../features/tasks/use-tasks.ts';

export const Route = createFileRoute('/')({
  loader: ({ context }) => context.queryClient.ensureQueryData(tasksListQuery),
  component: TasksRoute,
});

function TasksRoute() {
  return <TasksPage tasks={useTasks()} onCreate={useCreateTask()} onToggle={useToggleTask()} />;
}
