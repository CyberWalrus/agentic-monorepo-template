import { useId } from 'react';

import styles from './TaskItem.module.css';

export interface TaskItemData {
  id: string;
  title: string;
  completed: boolean;
}

export interface TaskItemProps {
  task: TaskItemData;
  onToggle: (id: string) => void;
  disabled?: boolean;
}

export function TaskItem({ task, onToggle, disabled = false }: TaskItemProps) {
  const checkboxId = useId();
  const classes = [styles['item'], task.completed ? styles['completed'] : undefined]
    .filter(Boolean)
    .join(' ');

  return (
    <li className={classes} data-testid="task-item" data-completed={task.completed}>
      <input
        id={checkboxId}
        type="checkbox"
        className={styles['checkbox']}
        checked={task.completed}
        disabled={disabled}
        onChange={() => onToggle(task.id)}
      />
      <label htmlFor={checkboxId} className={styles['title']}>
        {task.title}
      </label>
    </li>
  );
}
