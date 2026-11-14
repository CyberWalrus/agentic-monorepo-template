/**
 * Визуальные базлайны Button. Запускаются только в Docker-образе Playwright
 * (`pnpm visual`), чтобы шрифты и рендеринг совпадали локально и в CI.
 * Обновление базлайнов — только `pnpm visual:update`, это делает человек.
 */
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';

import { Frame } from '../testing/visual-frame.tsx';
import { Button } from './Button.tsx';

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
});
