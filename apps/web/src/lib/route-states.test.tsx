import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { RouteError, RouteNotFound } from './route-states.tsx';

describe('RouteError', () => {
  it('wires the retry button to the router reset', async () => {
    const reset = vi.fn<() => void>();
    const screen = await render(<RouteError error={new Error('boom')} reset={reset} />);

    await expect.element(screen.getByRole('alert')).toBeVisible();

    await screen.getByRole('button', { name: 'Try again' }).click();

    expect(reset).toHaveBeenCalledOnce();
  });
});

describe('RouteNotFound', () => {
  it('renders in a main landmark with a way back to the tasks', async () => {
    const screen = await render(<RouteNotFound />);

    await expect.element(screen.getByRole('main')).toBeVisible();
    await expect.element(screen.getByRole('link', { name: 'Back to tasks' })).toBeVisible();
  });
});
