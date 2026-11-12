import type { Task } from '@repo/contracts';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { TasksPage } from './TasksPage.tsx';

const tasks: Task[] = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    title: 'Open',
    completed: false,
    createdAt: '2026-11-01T10:00:00.000Z',
  },
  {
    id: '00000000-0000-4000-8000-000000000002',
    title: 'Done',
    completed: true,
    createdAt: '2026-11-01T09:00:00.000Z',
  },
];

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('TasksPage', () => {
  it('shows the empty state', async () => {
    const screen = await render(
      <TasksPage tasks={[]} onCreate={async () => {}} onToggle={async () => {}} />,
    );

    await expect.element(screen.getByText(/Nothing to do/)).toBeVisible();
    await expect.element(screen.getByTestId('tasks-summary')).toHaveTextContent('No tasks yet');
  });

  it('passes the toggled task id to onToggle', async () => {
    const onToggle = vi.fn<(id: string) => Promise<void>>(async () => {});
    const screen = await render(
      <TasksPage tasks={tasks} onCreate={async () => {}} onToggle={onToggle} />,
    );

    await screen.getByText('Open').click();

    expect(onToggle).toHaveBeenCalledExactlyOnceWith(tasks[0]?.id);
  });

  it('reports an error when the toggle fails', async () => {
    const request = deferred();
    const screen = await render(
      <TasksPage tasks={tasks} onCreate={async () => {}} onToggle={() => request.promise} />,
    );

    await screen.getByText('Open').click();
    request.reject(new Error('boom'));

    await expect
      .element(screen.getByRole('alert'))
      .toHaveTextContent('Could not update the task. Try again.');
  });

  it('summarizes open and completed tasks', async () => {
    const screen = await render(
      <TasksPage tasks={tasks} onCreate={async () => {}} onToggle={async () => {}} />,
    );

    await expect.element(screen.getByTestId('tasks-summary')).toHaveTextContent('1 of 2 remaining');
  });
});
