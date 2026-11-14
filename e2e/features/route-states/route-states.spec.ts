import { expect, test } from '../../fixtures.ts';

test.describe('route states', () => {
  test('shows a not-found page for an unknown URL and navigates home [AC-2]', async ({ page }) => {
    await page.goto('/this-route-does-not-exist');

    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    await expect(
      page.getByText('The page you are looking for does not exist or has moved.'),
    ).toBeVisible();

    await page.getByRole('link', { name: 'Back to tasks' }).click();

    await expect(page).toHaveURL(/\/$/);
    // Список может быть пуст: параллельные тесты не обязаны оставлять данные
    // в общем API (З9). Заголовок есть при любом состоянии данных.
    await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible();
  });
});
