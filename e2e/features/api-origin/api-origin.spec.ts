import { expect, test } from '../../fixtures.ts';

// Топология «один origin» (ADR 0005): прокси web-сервера обслуживает только
// /rpc. Тестовый API и health наружу из web-origin не торчат — добавление
// пути в прокси (vite.config.ts) красит этот тест, а через него шаг e2e.
test.describe('web origin topology', () => {
  test('test API is not reachable through the web origin [AC-1] @critical', async ({ request }) => {
    const response = await request.post('/__test__/reset', { data: { tasks: [] } });

    // Доходящий до API запрос даёт 204 (валидный reset) или 400 (битое тело).
    // Любой другой статус — ответ web-сервера: путь не проксируется.
    expect(
      response.status(),
      'test API must not leak through the web origin: only /rpc is proxied (ADR 0005)',
    ).not.toBe(204);
    expect(
      response.status(),
      'test API must not leak through the web origin: only /rpc is proxied (ADR 0005)',
    ).not.toBe(400);
  });

  test('API health is not reachable through the web origin [AC-2]', async ({ request }) => {
    const response = await request.get('/health');

    expect(
      response.status(),
      'API /health must not leak through the web origin: only /rpc is proxied (ADR 0005)',
    ).not.toBe(200);
  });
});
