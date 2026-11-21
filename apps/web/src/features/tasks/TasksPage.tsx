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
  // Контролы поэтому disabled, а страница объясняет неинтерактивность: подсказка
  // видна пользователю, aria-disabled на main доступен скринридеру. Ограничение
  // записано в e2e/specs/tasks.md (AC-5); после гидратации индикация исчезает.
  const interactive = useHydrated();

  function handleToggle(id: string) {
    setError(null);
    onToggle(id).catch(() => setError('Could not update the task. Try again.'));
  }

  // aria-disabled только до гидратации: undefined не рендерит атрибут вовсе.
  return (
    <main className={styles['page']} aria-disabled={interactive ? undefined : true}>
      <header className={styles['header']}>
        <h1 className={styles['title']}>Tasks</h1>
        <p className={styles['summary']} data-testid="tasks-summary">
          {formatSummary(summarizeTasks(tasks))}
        </p>
      </header>
      <CreateTaskForm onCreate={onCreate} disabled={!interactive} />
      {interactive ? null : (
        <p className={styles['ssr-hint']}>
          Interactive controls are disabled until the page finishes loading. JavaScript is required.
        </p>
      )}
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
