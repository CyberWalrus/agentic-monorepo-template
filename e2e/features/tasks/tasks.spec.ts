import { API_URL, expect, test } from '../../fixtures.ts';

test.describe('tasks', () => {
  test('creates a task and shows it in the list [AC-1] @critical', async ({
    page,
    uniqueTitle,
  }) => {
    const title = uniqueTitle('Buy milk');
    await page.goto('/');

    await page.getByLabel('New task').fill(title);
    await page.getByRole('button', { name: 'Add task' }).click();

    // Порядок не проверяем: тесты идут параллельно, сортировку покрывает unit-тест репозитория.
    const list = page.getByRole('list', { name: 'Tasks' });
    await expect(list.getByRole('checkbox', { name: title })).not.toBeChecked();
    await expect(page.getByLabel('New task')).toHaveValue('');
  });

  test('toggles a task and keeps the state after reload [AC-2] @critical', async ({
    page,
    uniqueTitle,
  }) => {
    const title = uniqueTitle('Toggle me');
    await page.goto('/');
    await page.getByLabel('New task').fill(title);
    await page.getByRole('button', { name: 'Add task' }).click();
    const checkbox = page.getByRole('checkbox', { name: title });

    // Чекбокс красится оптимистично из кэша раньше, чем POST /rpc дойдёт до
    // сервера: reload до подтверждения может прервать запрос, и состояние после
    // reload придёт с сервера без toggle. Хук вешается до клика — иначе ответ
    // может прийти раньше подписки. Путь процедуры виден в URL (RPCLink
    // дописывает /tasks/toggle к /rpc), матчер не ловит соседние запросы.
    const toggleSettled = page.waitForResponse((response) =>
      response.url().includes('/rpc/tasks/toggle'),
    );
    await checkbox.check();
    await expect(checkbox).toBeChecked();
    await toggleSettled;
    await page.reload();

    await expect(page.getByRole('checkbox', { name: title })).toBeChecked();
  });

  test('shows a validation error for an empty title [AC-3]', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: 'Add task' }).click();

    await expect(page.getByRole('alert')).toHaveText('Title is required');
    await expect(page.getByLabel('New task')).toHaveAttribute('aria-invalid', 'true');
  });

  test.describe('without JavaScript', () => {
    test.use({ javaScriptEnabled: false });

    test('server-renders existing tasks [AC-4] @critical', async ({
      page,
      request,
      uniqueTitle,
    }) => {
      const title = uniqueTitle('Rendered on the server');
      const response = await request.post(`${API_URL}/api/tasks`, { data: { title } });
      expect(response.ok()).toBe(true);

      await page.goto('/');

      await expect(page.getByText(title)).toBeVisible();
    });

    test('explains why controls are not interactive [AC-5]', async ({
      page,
      request,
      uniqueTitle,
    }) => {
      const title = uniqueTitle('Pre-hydration probe');
      const response = await request.post(`${API_URL}/api/tasks`, { data: { title } });
      expect(response.ok()).toBe(true);

      await page.goto('/');

      await expect(
        page.getByText(
          'Interactive controls are disabled until the page finishes loading. JavaScript is required.',
        ),
      ).toBeVisible();
      await expect(page.getByRole('main')).toHaveAttribute('aria-disabled', 'true');
      await expect(page.getByRole('checkbox', { name: title })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Add task' })).toBeDisabled();
    });
  });
});
