import { test as base, expect } from '@playwright/test';
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
  /** Заменяет все задачи в API. Только для serial-проектов (visual, perf). */
  seedTasks: (tasks: SeedTask[]) => Promise<void>;
  /** Уникальное имя для данных теста: тесты в functional идут параллельно. */
  uniqueTitle: (prefix: string) => string;
}

export const test = base.extend<Fixtures>({
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
