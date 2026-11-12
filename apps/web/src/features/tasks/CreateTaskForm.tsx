import { CreateTaskInputSchema } from '@repo/contracts';
import { Button, TextField } from '@repo/ui';
import { useState, type FormEvent } from 'react';

import styles from './TasksPage.module.css';

export interface CreateTaskFormProps {
  onCreate: (title: string) => Promise<void>;
  disabled?: boolean;
}

export function CreateTaskForm({ onCreate, disabled = false }: CreateTaskFormProps) {
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Та же схема, что валидирует вход на сервере: правила не расходятся.
    const parsed = CreateTaskInputSchema.safeParse({ title });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid title');
      return;
    }

    setError(undefined);
    setSubmitting(true);
    try {
      await onCreate(parsed.data.title);
      setTitle('');
    } catch {
      setError('Could not create the task. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className={styles['form']} onSubmit={(event) => void handleSubmit(event)} noValidate>
      <TextField
        label="New task"
        name="title"
        placeholder="What needs to be done?"
        autoComplete="off"
        value={title}
        error={error}
        disabled={disabled}
        onChange={(event) => setTitle(event.target.value)}
        className={styles['field']}
      />
      <Button type="submit" disabled={disabled || submitting}>
        Add task
      </Button>
    </form>
  );
}
