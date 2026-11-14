import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';

import { collectA11yViolations } from '../testing/a11y.ts';
import { NotFoundState } from './NotFoundState.tsx';

describe('NotFoundState', () => {
  it('explains the missing page and offers a way back', async () => {
    const screen = await render(<NotFoundState homeHref="/" homeLabel="Back to tasks" />);

    await expect.element(screen.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    await expect.element(screen.getByRole('link', { name: 'Back to tasks' })).toBeVisible();
    await expect
      .element(screen.getByRole('link', { name: 'Back to tasks' }))
      .toHaveAttribute('href', '/');
    expect(await collectA11yViolations(screen.container), 'accessibility violations').toEqual([]);
  });

  it('renders title and description only when no way back is offered', async () => {
    const screen = await render(<NotFoundState title="No such task" />);

    await expect.element(screen.getByRole('heading', { name: 'No such task' })).toBeVisible();
    expect(screen.getByRole('link').query()).toBeNull();
    expect(await collectA11yViolations(screen.container), 'accessibility violations').toEqual([]);
  });
});
