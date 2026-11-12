import type { Task } from '@repo/contracts';
import { TaskItem } from '@repo/ui';
import { useState } from 'react';

import { useHydrated } from '../../lib/use-hydrated.ts';
import { CreateTaskForm } from './CreateTaskForm.tsx';
import { formatSummary, summarizeTasks } from './summarize.ts';
import styles from './TasksPage.module.css';

export interface TasksPageProps {
  tasks: readonly Task[];
  onCreate: (title: string) => Promise<void>;
  onToggle: (id: string) => Promise<void>;
}

export function TasksPage({ tasks, onCreate, onToggle }: TasksPageProps) {
  const [error, setError] = useState<string | null>(null);
  // До гидратации клик по SSR-разметке теряется: React вернёт серверное состояние.
  const interactive = useHydrated();

  function handleToggle(id: string) {
    setError(null);
    onToggle(id).catch(() => setError('Could not update the task. Try again.'));
  }

  return (
    <main className={styles['page']}>
      <header className={styles['header']}>
        <h1 className={styles['title']}>Tasks</h1>
        <p className={styles['summary']} data-testid="tasks-summary">
          {formatSummary(summarizeTasks(tasks))}
        </p>
      </header>
      <CreateTaskForm onCreate={onCreate} disabled={!interactive} />
      {error ? (
        <p role="alert" className={styles['error']}>
          {error}
        </p>
      ) : null}
      {tasks.length === 0 ? (
        <p className={styles['empty']}>Nothing to do. Add your first task above.</p>
      ) : (
        <ul className={styles['list']} aria-label="Tasks">
          {tasks.map((task) => (
            <TaskItem key={task.id} task={task} onToggle={handleToggle} disabled={!interactive} />
          ))}
        </ul>
      )}
    </main>
  );
}
