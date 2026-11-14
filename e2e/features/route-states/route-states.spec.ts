import { expect, test } from '../../fixtures.ts';

test.describe('route states', () => {
  test('shows a not-found page for an unknown URL and navigates home', async ({ page }) => {
    await page.goto('/this-route-does-not-exist');

    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    await expect(
      page.getByText('The page you are looking for does not exist or has moved.'),
    ).toBeVisible();

    await page.getByRole('link', { name: 'Back to tasks' }).click();

    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('list', { name: 'Tasks' })).toBeVisible();
  });
});
