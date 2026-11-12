import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';

import { TextField } from './TextField.tsx';

describe('TextField', () => {
  it('associates the label with the input', async () => {
    const screen = await render(<TextField label="Title" />);

    await expect.element(screen.getByLabelText('Title')).toBeVisible();
  });

  it('does not mark the input invalid without an error', async () => {
    const screen = await render(<TextField label="Title" />);

    await expect.element(screen.getByLabelText('Title')).not.toHaveAttribute('aria-invalid');
    await expect.element(screen.getByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the error and links it to the input', async () => {
    const screen = await render(<TextField label="Title" error="Title is required" />);

    const input = screen.getByLabelText('Title');
    await expect.element(input).toHaveAttribute('aria-invalid', 'true');
    await expect.element(input).toHaveAccessibleDescription('Title is required');
    await expect.element(screen.getByRole('alert')).toHaveTextContent('Title is required');
  });
});
