import type { Page } from '@playwright/test';

import { expect, makeTasks, test } from '../../fixtures.ts';

/**
 * Клиентская навигация без перезагрузки документа: `<Link>` в шаблоне нет
 * (not-found ведёт домой обычным `<a>`), роутер слушает историю браузера —
 * pushState и событие popstate. Так loader маршрута исполняет браузер, и его
 * запрос к данным идёт через `/rpc` web-origin, где запрос виден из теста.
 */
async function navigateOnClient(page: Page, path: string) {
  await page.evaluate((next) => {
    history.pushState(null, '', next);
    dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

test.describe('route states', () => {
  test('shows a not-found page for an unknown URL and navigates home [AC-2] @critical', async ({
    page,
  }) => {
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

  test('recovers from a route error via "Try again" [AC-3] [AC-4] @critical', async ({
    page,
    seedTasks,
    workspace,
  }) => {
    // Данные попадают на страницу только после успешного loader'а: так
    // восстановление нельзя спутать с простым уходом сообщения об ошибке.
    const tasks = makeTasks(2, workspace);
    await seedTasks(tasks);

    let apiReachable = false;
    let rpcAttempts = 0;
    await page.route(/\/rpc(\?|\/|$)/, async (route) => {
      rpcAttempts += 1;
      if (apiReachable) {
        await route.continue();
        return;
      }
      // То, что получает браузер, когда API недоступен: прокси web отдаёт 502
      // (apps/web/src/server-app.ts). Документ-запрос и SSR не затрагиваются:
      // loader `/` в этом сценарии исполняет браузер.
      await route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'API is unreachable' }),
      });
    });

    // Индексный маршрут в этом документе ещё не совпадал — его loader пойдёт
    // из браузера. До гидратации popstate слушать некому, поэтому навигация
    // повторяется, пока роутер её не примет: not-found уходит с экрана.
    await page.goto('/this-route-does-not-exist');
    await expect(async () => {
      await navigateOnClient(page, '/');
      await expect(page.getByRole('heading', { name: 'Page not found' })).toBeHidden({
        timeout: 3_000,
      });
    }).toPass({ timeout: 15_000 });

    const alert = page.getByRole('alert');
    await expect(alert.getByRole('heading', { name: 'Something went wrong' })).toBeVisible();
    // Технические детали ошибки пользователю не показываются.
    await expect(page.getByText('API is unreachable')).toHaveCount(0);

    const retry = page.getByRole('button', { name: 'Try again' });
    await expect(retry).toBeVisible();
    await expect(retry).toBeEnabled();

    const failedAttempts = rpcAttempts;
    apiReachable = true;
    await retry.click();

    await expect(alert).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible();
    for (const { title } of tasks) {
      await expect(page.getByRole('checkbox', { name: title })).toBeVisible();
    }
    expect(rpcAttempts, '«Try again» повторяет запрос данных').toBeGreaterThan(failedAttempts);
  });
});
