import { test as base, expect } from '@playwright/test';

export interface SeedTask {
  id: string;
  title: string;
  completed: boolean;
  createdAt: string;
}

const API_URL = 'http://localhost:3001';

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
