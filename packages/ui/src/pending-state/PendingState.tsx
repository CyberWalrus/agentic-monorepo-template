import styles from './PendingState.module.css';

export interface PendingStateProps {
  /** Что загружается; текст виден пользователю и скринридеру. */
  label?: string;
}

export function PendingState({ label }: PendingStateProps) {
  // <output> имеет неявную роль status: live region без лишнего атрибута.
  return (
    <output className={styles['pending-state']}>
      <span aria-hidden="true" className={styles['spinner']} />
      <span className={styles['label']}>{label ?? 'Loading…'}</span>
    </output>
  );
}
