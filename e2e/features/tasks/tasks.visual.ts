/**
 * Визуальный базлайн страницы задач. Запускается только в Docker (`pnpm visual`).
 * Обновление базлайнов — `pnpm visual:update`, делает человек.
 *
 * Изоляция по рабочему пространству (ADR 0020): каждый тест сеет данные в свой
 * workspace и видит только их, поэтому сценарии не сериализуются — SHARED_DATA_LOCK
 * снят (c1.5). Seed-данные той же формы: пиксельные базлайны не меняются.
 */
import type { Page } from '@playwright/test';

import { expect, makeTasks, test } from '../../fixtures.ts';

/** Скриншот только после гидратации: до неё контролы disabled. */
async function openHydrated(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Add task' })).toBeEnabled();
}

test.describe('tasks page', () => {
  test('tasks page with seeded data', async ({ page, seedTasks, workspace }) => {
    await seedTasks(makeTasks(5, workspace));
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

  test('validation error state', async ({ page, seedTasks, workspace }) => {
    await seedTasks(makeTasks(2, workspace));
    await openHydrated(page);
    await page.getByRole('button', { name: 'Add task' }).click();
    await expect(page.getByRole('alert')).toBeVisible();

    await expect(page.locator('form')).toHaveScreenshot('create-form-error.webp');
  });

  test('error banner after a failed toggle', async ({ page, seedTasks, workspace }) => {
    await seedTasks(makeTasks(2, workspace));
    // Баннер ошибки после неудачного toggle — единственное состояние страницы,
    // меняющееся по рантайм-данным (b12). Запрос блокируется до клика:
    // оптимистичная галочка откатывается, остаётся баннер role="alert".
    // Кликается неотмеченная задача: makeTasks отмечает каждую третью (index % 3 === 0),
    // check() по уже отмеченному чекбоксу — no-op без мутации.
    await page.route('**/rpc/tasks/toggle', (route) => route.abort());
    await openHydrated(page);
    await page.getByRole('checkbox', { name: 'Seeded task #2' }).check();
    await expect(page.getByRole('alert')).toHaveText('Could not update the task. Try again.');

    await expect(page).toHaveScreenshot('tasks-page-error.webp', { fullPage: true });
  });
});
