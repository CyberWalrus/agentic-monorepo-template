import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { collectA11yViolations } from '../testing/a11y.ts';
import { ErrorState } from './ErrorState.tsx';

describe('ErrorState', () => {
  it('announces the failure and offers a retry', async () => {
    const onRetry = vi.fn<() => void>();
    const screen = await render(<ErrorState onRetry={onRetry} />);

    await expect.element(screen.getByRole('alert')).toBeVisible();
    await expect
      .element(screen.getByRole('heading', { name: 'Something went wrong' }))
      .toBeVisible();

    await screen.getByRole('button', { name: 'Try again' }).click();
    expect(onRetry).toHaveBeenCalledOnce();
    expect(await collectA11yViolations(screen.container), 'accessibility violations').toEqual([]);
  });

  it('renders a custom message without a retry button when none is offered', async () => {
    const screen = await render(
      <ErrorState title="Failed to save" description="Check the form." />,
    );

    await expect.element(screen.getByRole('heading', { name: 'Failed to save' })).toBeVisible();
    expect(screen.getByRole('button').query()).toBeNull();
    expect(await collectA11yViolations(screen.container), 'accessibility violations').toEqual([]);
  });
});
