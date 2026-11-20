import { test as base, expect, type Response, type TestInfo } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { apiOrigin, resolvePorts } from '../tools/ports.ts';

export interface SeedTask {
  id: string;
  title: string;
  completed: boolean;
  createdAt: string;
}

// Напрямую в API, мимо прокси web-сервера: через origin web доступен только
// /rpc (ADR 0005), /__test__/* через web намеренно недоступен. Порты — те же,
// что выбрал e2e-конфиг: читаем reports/ports.json, а не выбираем заново
// (зонд после старта серверов уехал бы на чужой порт — З9, A5).
const ports = await resolvePorts(resolve(import.meta.dirname, '..'));
export const API_URL = apiOrigin(ports);

interface Fixtures {
  /**
   * Идентификаторы запросов API, наблюдавшиеся в этом сценарии (C4): авто-фикстура
   * собирает x-request-id из ответов страницы. Отбор логов по id, а не по времени —
   * functional-тесты идут параллельно против одного API.
   */
  apiRequestIds: Set<string>;
  /** Заменяет все задачи в API. Только для serial-проектов (visual, perf). */
  seedTasks: (tasks: SeedTask[]) => Promise<void>;
  /** Уникальное имя для данных теста: тесты в functional идут параллельно. */
  uniqueTitle: (prefix: string) => string;
}

/**
 * Логи API при падении теста — вложением в отчёт (C4). Срез запрашивается по
 * собранным идентификаторам запроса, поэтому в него не попадают записи соседних
 * параллельных тестов. Диагностика не меняет исход теста: если логи недоступны
 * (частый случай — упал сам API), причина уходит в stdout теста, а не в новый
 * failure; пустой сценарий (нет запросов к API) не прикладывает пустой файл.
 */
async function attachApiLogsOnFailure(testInfo: TestInfo, requestIds: Set<string>): Promise<void> {
  if (testInfo.status === testInfo.expectedStatus || requestIds.size === 0) {
    return;
  }
  const query = [...requestIds].map((id) => `requestId=${encodeURIComponent(id)}`).join('&');
  let body: string;
  try {
    const response = await fetch(`${API_URL}/__test__/logs?${query}`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
    body = await response.text();
  } catch (error: unknown) {
    console.warn(`[api-logs] API logs unavailable for the failed test: ${String(error)}`);
    return;
  }
  const path = testInfo.outputPath('api-logs.json');
  writeFileSync(path, body);
  await testInfo.attach('api-logs', { path, contentType: 'application/json' });
  // Путь нужен и в отчёте, и в выводе шага e2e: `pnpm verify --json` при красном
  // шаге называет его из stdout (хвост вывода шага попадает в поле output).
  console.log(`[api-logs] attached: ${path}`);
}

export const test = base.extend<Fixtures>({
  apiRequestIds: [
    async ({ page }, use, testInfo) => {
      const requestIds = new Set<string>();
      const captureId = (response: Response) => {
        const requestId = response.headers()['x-request-id'];
        if (requestId !== undefined) {
          requestIds.add(requestId);
        }
      };
      page.on('response', captureId);
      await use(requestIds);
      page.off('response', captureId);
      await attachApiLogsOnFailure(testInfo, requestIds);
    },
    { auto: true },
  ],
  seedTasks: async ({ request }, use) => {
    await use(async (tasks) => {
      const response = await request.post(`${API_URL}/__test__/reset`, { data: { tasks } });
      expect(response.status(), 'test API must be enabled (ENABLE_TEST_API=1)').toBe(204);
    });
  },
  uniqueTitle: async ({}, use, testInfo) => {
    let counter = 0;
    await use(
      (prefix) =>
        `${prefix} ${testInfo.testId}-${testInfo.repeatEachIndex}-${testInfo.retry}-${counter++}`,
    );
  },
});

export { expect };

/** Lock для тестов, которые перезаписывают данные API (visual, perf). */
export const SHARED_DATA_LOCK = 'shared-api-data';

export function makeTasks(count: number): SeedTask[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    title: `Seeded task #${index + 1}`,
    completed: index % 3 === 0,
    createdAt: new Date(Date.UTC(2026, 10, 1, 9, 0, count - index)).toISOString(),
  }));
}
