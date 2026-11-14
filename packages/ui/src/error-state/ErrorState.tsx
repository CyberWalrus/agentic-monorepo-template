import { Button } from '../button/Button.tsx';

import styles from './ErrorState.module.css';

export interface ErrorStateProps {
  /** Заголовок ошибки, одна строка. */
  title?: string;
  /** Что произошло и что делать пользователю, без технических деталей. */
  description?: string;
  /** Повтор действия; без него кнопка повтора не рисуется. */
  onRetry?: () => void;
}

export function ErrorState({ title, description, onRetry }: ErrorStateProps) {
  return (
    <div role="alert" className={styles['error-state']}>
      <h1 className={styles['title']}>{title ?? 'Something went wrong'}</h1>
      <p className={styles['description']}>
        {description ??
          'The page failed to load. Try again — if it keeps failing, the problem is on our side.'}
      </p>
      {onRetry ? <Button onClick={onRetry}>Try again</Button> : null}
    </div>
  );
}
