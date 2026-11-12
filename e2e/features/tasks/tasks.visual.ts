/**
 * Визуальный базлайн страницы задач. Запускается только в Docker (`pnpm visual`).
 * Обновление базлайнов — `pnpm visual:update`, делает человек.
 */
import type { Page } from '@playwright/test';

import { expect, makeTasks, SHARED_DATA_LOCK, test } from '../../fixtures.ts';

/** Скриншот только после гидратации: до неё контролы disabled. */
async function openHydrated(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Add task' })).toBeEnabled();
}

test.describe.configure({ mode: 'serial' });

test.describe('tasks page', { lock: SHARED_DATA_LOCK }, () => {
  test('tasks page with seeded data', async ({ page, seedTasks }) => {
    await seedTasks(makeTasks(5));
    await openHydrated(page);
    await expect(page.getByTestId('task-item')).toHaveCount(5);

    await expect(page).toHaveScreenshot('tasks-page.webp', { fullPage: true });
  });

  test('tasks page empty state', async ({ page, seedTasks }) => {
    await seedTasks([]);
    await openHydrated(page);
    await expect(page.getByText('Nothing to do')).toBeVisible();

    await expect(page).toHaveScreenshot('tasks-page-empty.webp', { fullPage: true });
  });

  test('validation error state', async ({ page, seedTasks }) => {
    await seedTasks(makeTasks(2));
    await openHydrated(page);
    await page.getByRole('button', { name: 'Add task' }).click();
    await expect(page.getByRole('alert')).toBeVisible();

    await expect(page.locator('form')).toHaveScreenshot('create-form-error.webp');
  });
});
