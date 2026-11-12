import { expect, test } from '../../fixtures.ts';

test.describe('tasks', () => {
  test('creates a task and shows it in the list @critical', async ({ page, uniqueTitle }) => {
    const title = uniqueTitle('Buy milk');
    await page.goto('/');

    await page.getByLabel('New task').fill(title);
    await page.getByRole('button', { name: 'Add task' }).click();

    // Порядок не проверяем: тесты идут параллельно, сортировку покрывает unit-тест репозитория.
    const list = page.getByRole('list', { name: 'Tasks' });
    await expect(list.getByRole('checkbox', { name: title })).not.toBeChecked();
    await expect(page.getByLabel('New task')).toHaveValue('');
  });

  test('toggles a task and keeps the state after reload @critical', async ({
    page,
    uniqueTitle,
  }) => {
    const title = uniqueTitle('Toggle me');
    await page.goto('/');
    await page.getByLabel('New task').fill(title);
    await page.getByRole('button', { name: 'Add task' }).click();
    const checkbox = page.getByRole('checkbox', { name: title });

    await checkbox.check();
    await expect(checkbox).toBeChecked();
    await page.reload();

    await expect(page.getByRole('checkbox', { name: title })).toBeChecked();
  });

  test('shows a validation error for an empty title', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: 'Add task' }).click();

    await expect(page.getByRole('alert')).toHaveText('Title is required');
    await expect(page.getByLabel('New task')).toHaveAttribute('aria-invalid', 'true');
  });

  test.describe('without JavaScript', () => {
    test.use({ javaScriptEnabled: false });

    test('server-renders existing tasks @critical', async ({ page, request, uniqueTitle }) => {
      const title = uniqueTitle('Rendered on the server');
      const response = await request.post('http://localhost:3001/api/tasks', { data: { title } });
      expect(response.ok()).toBe(true);

      await page.goto('/');

      await expect(page.getByText(title)).toBeVisible();
    });
  });
});
