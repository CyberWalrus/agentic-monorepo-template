/**
 * Визуальные базлайны TextField. Запускаются только в Docker-образе Playwright
 * (`pnpm visual`), чтобы шрифты и рендеринг совпадали локально и в CI.
 * Обновление базлайнов — только `pnpm visual:update`, это делает человек.
 */
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';

import { Frame } from '../testing/visual-frame.tsx';
import { TextField } from './TextField.tsx';

describe('visual', () => {
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
});
