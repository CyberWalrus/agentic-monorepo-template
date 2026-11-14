import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { collectA11yViolations } from '../testing/a11y.ts';
import { TaskItem } from './TaskItem.tsx';

const task = { id: 'task-1', title: 'Write the docs', completed: false };

describe('TaskItem', () => {
  it('exposes the checkbox under the task title', async () => {
    const screen = await render(<TaskItem task={task} onToggle={() => {}} />);

    await expect
      .element(screen.getByRole('checkbox', { name: 'Write the docs' }))
      .not.toBeChecked();
  });

  it('reflects the completed state', async () => {
    const screen = await render(
      <TaskItem task={{ ...task, completed: true }} onToggle={() => {}} />,
    );

    await expect.element(screen.getByRole('checkbox')).toBeChecked();
    await expect.element(screen.getByTestId('task-item')).toHaveAttribute('data-completed', 'true');
  });

  it('calls onToggle with the task id when the title is clicked', async () => {
    const onToggle = vi.fn<(id: string) => void>();
    const screen = await render(<TaskItem task={task} onToggle={onToggle} />);

    await screen.getByText('Write the docs').click();

    expect(onToggle).toHaveBeenCalledExactlyOnceWith('task-1');
  });

  it('does not toggle while disabled', async () => {
    const onToggle = vi.fn<(id: string) => void>();
    const screen = await render(<TaskItem task={task} onToggle={onToggle} disabled />);

    await screen.getByRole('checkbox').click({ force: true });

    expect(onToggle).not.toHaveBeenCalled();
  });

  it('is accessible in both states', async () => {
    const screen = await render(
      <ul>
        <TaskItem task={task} onToggle={() => {}} />
        <TaskItem task={{ ...task, completed: true }} onToggle={() => {}} />
      </ul>,
    );

    expect(await collectA11yViolations(screen.container), 'accessibility violations').toEqual([]);
  });
});
