import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';

import { collectA11yViolations } from '../testing/a11y.ts';
import { PendingState } from './PendingState.tsx';

describe('PendingState', () => {
  it('announces loading to screen readers and shows a visible label', async () => {
    const screen = await render(<PendingState label="Loading tasks…" />);

    await expect.element(screen.getByRole('status')).toBeVisible();
    await expect.element(screen.getByText('Loading tasks…')).toBeVisible();
    expect(await collectA11yViolations(screen.container), 'accessibility violations').toEqual([]);
  });

  it('falls back to the generic label', async () => {
    const screen = await render(<PendingState />);

    await expect.element(screen.getByText('Loading…')).toBeVisible();
    expect(await collectA11yViolations(screen.container), 'accessibility violations').toEqual([]);
  });
});
