import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { collectA11yViolations } from '../testing/a11y.ts';
import { Button } from './Button.tsx';

describe('Button', () => {
  it('renders an accessible button with its label', async () => {
    const screen = await render(<Button>Save</Button>);

    await expect.element(screen.getByRole('button', { name: 'Save' })).toBeVisible();
  });

  it('defaults to type="button" so it never submits a form by accident', async () => {
    const screen = await render(<Button>Save</Button>);

    await expect.element(screen.getByRole('button')).toHaveAttribute('type', 'button');
  });

  it('calls onClick when clicked', async () => {
    const onClick = vi.fn<() => void>();
    const screen = await render(<Button onClick={onClick}>Save</Button>);

    await screen.getByRole('button').click();

    expect(onClick).toHaveBeenCalledOnce();
  });

  it('does not call onClick when disabled', async () => {
    const onClick = vi.fn<() => void>();
    const screen = await render(
      <Button onClick={onClick} disabled>
        Save
      </Button>,
    );

    await screen.getByRole('button').click({ force: true });

    expect(onClick).not.toHaveBeenCalled();
    await expect.element(screen.getByRole('button')).toBeDisabled();
  });

  it('is accessible in all variants', async () => {
    const screen = await render(
      <>
        <Button>Primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Button disabled>Disabled</Button>
      </>,
    );

    expect(await collectA11yViolations(screen.container), 'accessibility violations').toEqual([]);
  });
});
