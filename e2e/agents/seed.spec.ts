/**
 * Seed для Playwright Test Agents (planner/generator): готовое окружение,
 * от которого агент начинает исследование. Запускается только проектом `agents`.
 */
import { expect, test } from '../fixtures.ts';

test('seed: tasks page is ready', async ({ page }) => {
  await page.goto('/');
  // Контролы активны только после гидратации: дальше можно взаимодействовать.
  await expect(page.getByRole('button', { name: 'Add task' })).toBeEnabled();
});
