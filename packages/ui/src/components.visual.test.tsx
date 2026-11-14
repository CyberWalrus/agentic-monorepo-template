/**
 * Визуальные базлайны компонентов. Запускаются только в Docker-образе Playwright
 * (`pnpm visual`), чтобы шрифты и рендеринг совпадали локально и в CI.
 * Обновление базлайнов — только `pnpm visual:update`, это делает человек.
 */
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';

import { Button } from './button/Button.tsx';
import { ErrorState } from './error-state/ErrorState.tsx';
import { NotFoundState } from './not-found-state/NotFoundState.tsx';
import { PendingState } from './pending-state/PendingState.tsx';
import { TaskItem } from './task-item/TaskItem.tsx';
import { TextField } from './text-field/TextField.tsx';
import './tokens.css';

function Frame({ children }: { children: ReactNode }) {
  return (
    <div data-testid="frame" style={{ display: 'inline-flex', gap: 12, padding: 16, width: 360 }}>
      {children}
    </div>
  );
}

describe('visual', () => {
  it('Button variants', async () => {
    const screen = await render(
      <Frame>
        <Button>Primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Button disabled>Disabled</Button>
      </Frame>,
    );

    await expect.element(screen.getByTestId('frame')).toMatchScreenshot('button-variants');
  });

  it('TextField states', async () => {
    const screen = await render(
      <Frame>
        <div style={{ display: 'grid', gap: 12, width: '100%' }}>
          <TextField label="Title" placeholder="What needs to be done?" />
          <TextField label="Title" defaultValue="Too short" error="Title is required" />
        </div>
      </Frame>,
    );

    await expect.element(screen.getByTestId('frame')).toMatchScreenshot('text-field-states');
  });

  it('TaskItem states', async () => {
    const screen = await render(
      <Frame>
        <ul style={{ display: 'grid', gap: 8, width: '100%', margin: 0, padding: 0 }}>
          <TaskItem task={{ id: '1', title: 'Open task', completed: false }} onToggle={() => {}} />
          <TaskItem
            task={{ id: '2', title: 'Completed task', completed: true }}
            onToggle={() => {}}
          />
          <TaskItem
            task={{
              id: '3',
              title: 'A very long task title that has to wrap onto the next line nicely',
              completed: false,
            }}
            onToggle={() => {}}
          />
        </ul>
      </Frame>,
    );

    await expect.element(screen.getByTestId('frame')).toMatchScreenshot('task-item-states');
  });

  it('Route states', async () => {
    const screen = await render(
      <Frame>
        <div style={{ display: 'grid', gap: 16, width: '100%' }}>
          <ErrorState onRetry={() => {}} />
          <NotFoundState homeHref="/" homeLabel="Back to tasks" />
          <PendingState />
        </div>
      </Frame>,
    );

    await expect.element(screen.getByTestId('frame')).toMatchScreenshot('route-states');
  });
});
