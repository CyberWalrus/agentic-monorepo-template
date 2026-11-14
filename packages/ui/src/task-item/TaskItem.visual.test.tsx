/**
 * Визуальные базлайны TaskItem. Запускаются только в Docker-образе Playwright
 * (`pnpm visual`), чтобы шрифты и рендеринг совпадали локально и в CI.
 * Обновление базлайнов — только `pnpm visual:update`, это делает человек.
 */
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';

import { Frame } from '../testing/visual-frame.tsx';
import { TaskItem } from './TaskItem.tsx';

describe('visual', () => {
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
});
