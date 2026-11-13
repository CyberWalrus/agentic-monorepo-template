/**
 * Перф-бюджеты пользовательских сценариев. Пороги лежат в /perf-budgets.json
 * (защищённый файл). Результаты пишутся в reports/perf.json для сравнения в CI.
 */
import { mkdir, writeFile } from 'node:fs/promises';

import type { Page } from '@playwright/test';

import { acquirePerfLock, type PerfLock } from '../../tools/perf-lock.ts';
import { loadPerfBudgets } from '../../tools/perf-budgets.ts';
import { expect, makeTasks, SHARED_DATA_LOCK, test } from '../fixtures.ts';

const budgets = loadPerfBudgets();

const SAMPLES = 5;
const CPU_THROTTLING_RATE = 4;
const results: Record<string, Record<string, number>> = {};

// Машинная блокировка (З9, A5 PR-3): параллельный verify --full в другом
// worktree не должен шуметь под замерами. Ждёт держателя с логом, мусорный
// lock (мёртвый pid / протухший) забирает с предупреждением.
let machineLock: PerfLock | undefined;

test.beforeAll(async () => {
  machineLock = await acquirePerfLock({ pollMs: 2_000 });
});

test.afterAll(() => {
  machineLock?.release();
});

function median(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

function budgetFor<T>(record: Record<string, T>, key: string): T {
  const budget = record[key];
  if (!budget) {
    throw new Error(`No budget for "${key}" in perf-budgets.json`);
  }
  return budget;
}

async function collectVitals(page: Page) {
  // Функция выполняется в браузере: внешние хелперы недоступны, проверки типов — внутри.
  return page.evaluate(
    () =>
      new Promise<{ ttfb: number; lcp: number; cls: number }>((resolve) => {
        const navigation = performance
          .getEntriesByType('navigation')
          .find((entry) => entry instanceof PerformanceNavigationTiming);
        let lcp = 0;
        let cls = 0;
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            lcp = entry.startTime;
          }
        }).observe({ type: 'largest-contentful-paint', buffered: true });
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            // LayoutShift нет в lib.dom: читаем поля из JSON-представления записи.
            const shift: unknown = entry.toJSON();
            if (
              typeof shift === 'object' &&
              shift !== null &&
              'value' in shift &&
              typeof shift.value === 'number' &&
              !('hadRecentInput' in shift && shift.hadRecentInput === true)
            ) {
              cls += shift.value;
            }
          }
        }).observe({ type: 'layout-shift', buffered: true });
        setTimeout(() => resolve({ ttfb: navigation?.responseStart ?? Number.NaN, lcp, cls }), 200);
      }),
  );
}

test.describe.configure({ mode: 'serial' });

// Каждый тест сеет свои данные: повторы (--repeat-each) и retries не зависят от порядка.
test.beforeEach(async ({ page, seedTasks }) => {
  await seedTasks(makeTasks(20));
  // Эмуляция среднего устройства: регрессии в JS заметнее, чем на быстрой машине разработчика.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLING_RATE });
});

test.afterAll(async () => {
  await mkdir('reports', { recursive: true });
  await writeFile('reports/perf.json', `${JSON.stringify(results, null, 2)}\n`);
});

test.describe('perf budgets', { lock: SHARED_DATA_LOCK }, () => {
  test('page "/" stays within web vitals budget', async ({ page }, testInfo) => {
    const budget = budgetFor(budgets.web.pages, '/');
    await page.goto('/'); // прогрев
    const samples: { ttfb: number; lcp: number; cls: number }[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      await page.goto('/', { waitUntil: 'load' });
      samples.push(await collectVitals(page));
    }

    const measured = {
      ttfbMs: median(samples.map((s) => s.ttfb)),
      lcpMs: median(samples.map((s) => s.lcp)),
      cls: median(samples.map((s) => s.cls)),
    };
    results['page:/'] = measured;
    await testInfo.attach('vitals', {
      body: JSON.stringify({ measured, budget }, null, 2),
      contentType: 'application/json',
    });

    expect.soft(measured.ttfbMs, 'TTFB, ms').toBeLessThanOrEqual(budget.maxTtfbMs);
    expect.soft(measured.lcpMs, 'LCP, ms').toBeLessThanOrEqual(budget.maxLcpMs);
    expect.soft(measured.cls, 'CLS').toBeLessThanOrEqual(budget.maxCls);
  });

  test('scenario "create-task" stays within budget', async ({ page }, testInfo) => {
    const budget = budgetFor(budgets.web.scenarios, 'create-task');
    await page.goto('/');
    const durations: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const title = `Perf task ${testInfo.repeatEachIndex}-${testInfo.retry}-${i}`;
      await page.getByLabel('New task').fill(title);
      const start = performance.now();
      await page.getByRole('button', { name: 'Add task' }).click();
      await expect(page.getByRole('checkbox', { name: title })).toBeVisible();
      durations.push(performance.now() - start);
    }

    const measured = { ms: median(durations) };
    results['scenario:create-task'] = measured;
    await testInfo.attach('timings', {
      body: JSON.stringify({ durations, budget }, null, 2),
      contentType: 'application/json',
    });

    expect(measured.ms, 'create-task median, ms').toBeLessThanOrEqual(budget.maxMs);
  });

  test('scenario "toggle-task" stays within budget', async ({ page }, testInfo) => {
    const budget = budgetFor(budgets.web.scenarios, 'toggle-task');
    await page.goto('/');
    const checkbox = page.getByRole('checkbox').first();
    const durations: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const wasChecked = await checkbox.isChecked();
      const start = performance.now();
      await checkbox.click();
      await expect(checkbox).toBeChecked({ checked: !wasChecked });
      await expect(checkbox).toBeEnabled();
      durations.push(performance.now() - start);
    }

    const measured = { ms: median(durations) };
    results['scenario:toggle-task'] = measured;
    await testInfo.attach('timings', {
      body: JSON.stringify({ durations, budget }, null, 2),
      contentType: 'application/json',
    });

    expect(measured.ms, 'toggle-task median, ms').toBeLessThanOrEqual(budget.maxMs);
  });
});
