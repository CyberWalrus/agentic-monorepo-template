import { useId, type InputHTMLAttributes } from 'react';

import styles from './TextField.module.css';

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  error?: string | undefined;
}

export function TextField({ label, error, className, ...rest }: TextFieldProps) {
  const id = useId();
  const errorId = `${id}-error`;

  return (
    <div className={[styles['field'], className].filter(Boolean).join(' ')}>
      <label htmlFor={id} className={styles['label']}>
        {label}
      </label>
      <input
        id={id}
        className={styles['input']}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        {...rest}
      />
      {error ? (
        <span id={errorId} role="alert" className={styles['error']}>
          {error}
        </span>
      ) : null}
    </div>
  );
}
