import styles from './NotFoundState.module.css';

export interface NotFoundStateProps {
  /** Заголовок, одна строка. */
  title?: string;
  /** Что произошло и что делать пользователю. */
  description?: string;
  /** Куда ведёт ссылка возврата; без неё ссылка не рисуется. */
  homeHref?: string;
  /** Текст ссылки возврата. */
  homeLabel?: string;
}

export function NotFoundState({ title, description, homeHref, homeLabel }: NotFoundStateProps) {
  return (
    <div className={styles['not-found-state']}>
      <h1 className={styles['title']}>{title ?? 'Page not found'}</h1>
      <p className={styles['description']}>
        {description ?? 'The page you are looking for does not exist or has moved.'}
        {homeHref ? (
          <>
            {' '}
            <a className={styles['home-link']} href={homeHref}>
              {homeLabel ?? 'Back to home'}
            </a>
          </>
        ) : null}
      </p>
    </div>
  );
}
