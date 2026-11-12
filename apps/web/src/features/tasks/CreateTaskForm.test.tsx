import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { CreateTaskForm } from './CreateTaskForm.tsx';

describe('CreateTaskForm', () => {
  it('submits the trimmed title and clears the field', async () => {
    const onCreate = vi.fn<(title: string) => Promise<void>>(async () => {});
    const screen = await render(<CreateTaskForm onCreate={onCreate} />);

    await screen.getByLabelText('New task').fill('  Buy milk  ');
    await screen.getByRole('button', { name: 'Add task' }).click();

    expect(onCreate).toHaveBeenCalledExactlyOnceWith('Buy milk');
    await expect.element(screen.getByLabelText('New task')).toHaveValue('');
  });

  it('shows the shared validation message and does not submit an empty title', async () => {
    const onCreate = vi.fn<(title: string) => Promise<void>>(async () => {});
    const screen = await render(<CreateTaskForm onCreate={onCreate} />);

    await screen.getByRole('button', { name: 'Add task' }).click();

    await expect.element(screen.getByRole('alert')).toHaveTextContent('Title is required');
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('keeps the input and shows an error when creation fails', async () => {
    const onCreate = vi.fn<(title: string) => Promise<void>>(async () => {
      throw new Error('network down');
    });
    const screen = await render(<CreateTaskForm onCreate={onCreate} />);

    await screen.getByLabelText('New task').fill('Retry me');
    await screen.getByRole('button', { name: 'Add task' }).click();

    await expect
      .element(screen.getByRole('alert'))
      .toHaveTextContent('Could not create the task. Try again.');
    await expect.element(screen.getByLabelText('New task')).toHaveValue('Retry me');
  });
});

describe('CreateTaskForm when disabled', () => {
  it('blocks typing and submitting', async () => {
    const screen = await render(<CreateTaskForm onCreate={async () => {}} disabled />);

    await expect.element(screen.getByLabelText('New task')).toBeDisabled();
    await expect.element(screen.getByRole('button', { name: 'Add task' })).toBeDisabled();
  });
});
