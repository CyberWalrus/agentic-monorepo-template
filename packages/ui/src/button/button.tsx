import type { ButtonHTMLAttributes } from 'react';

import styles from './button.module.css';

export type ButtonVariant = 'primary' | 'secondary';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export function Button({ variant = 'primary', className, type = 'button', ...rest }: ButtonProps) {
  const classes = [styles['button'], styles[variant], className].filter(Boolean).join(' ');

  return <button type={type} className={classes} {...rest} />;
}
