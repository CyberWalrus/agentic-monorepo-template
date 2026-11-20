/**
 * Перф-бюджеты пользовательских сценариев. Пороги лежат в /perf-budgets.json
 * (защищённый файл). Результаты пишутся в reports/perf.json для сравнения в CI.
 *
 * Два уровня метрик (З8, A6 PR-1): абсолютные потолки времени (TTFB/LCP/CLS,
 * сценарии) и детерминированные — wire-байты JS/CSS, число запросов (все и к
 * /rpc), long tasks при CPU×4, LCP под Fast 3G. Детерминированные замеряются
 * на ХОЛОДНОЙ загрузке в свежем контексте: тёплый кэш отдаёт 304/пустые
 * encodedDataLength и ломает детерминизм.
 */
import { mkdir, writeFile } from 'node:fs/promises';

import type { Browser, CDPSession, Page } from '@playwright/test';
import type { Request as HttpRequest } from '@playwright/test';

import { acquirePerfLock, type PerfLock } from '../../tools/perf-lock.ts';
import { loadPerfBudgets } from '../../tools/perf-budgets.ts';
import {
  median,
  PerfReportSchema,
  type PageMetrics,
  type PerfReport,
  type ScenarioMetrics,
} from '../../tools/perf-metrics.ts';
import { expect, makeTasks, SHARED_DATA_LOCK, test } from '../fixtures.ts';

const budgets = loadPerfBudgets();

const SAMPLES = 5;
const COLD_SAMPLES = 3;
const CPU_THROTTLING_RATE = 4;
/** Профиль Fast 3G для CDP Network.emulateNetworkConditions. */
const FAST_3G = {
  offline: false,
  latency: 150,
  downloadThroughput: (1.6 * 1024 * 1024) / 8,
  uploadThroughput: (750 * 1024) / 8,
};

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

interface ColdLoad {
  requests: number;
  apiRequests: number;
  jsWireKb: number;
  cssWireKb: number;
  lcpMs?: number;
}

/** Минимальные формы событий CDP Network: playwright-core не публичный тип, держим локально. */
interface RequestWillBeSentEvent {
  request: { url: string };
}
interface ResponseReceivedEvent {
  requestId: string;
  type: string;
}
interface LoadingFinishedEvent {
  requestId: string;
  encodedDataLength: number;
}

/**
 * Холодная загрузка `/` в свежем контексте (пустой кэш): счётчики запросов и
 * wire-байты через CDP. С троттлингом — плюс LCP (вес страницы влияет на время).
 */
async function coldLoad(browser: Browser, baseURL: string, throttle: boolean): Promise<ColdLoad> {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  const cdp: CDPSession = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  if (throttle) {
    await cdp.send('Network.emulateNetworkConditions', FAST_3G);
  }
  const resourceTypes = new Map<string, string>();
  let requests = 0;
  let apiRequests = 0;
  let jsBytes = 0;
  let cssBytes = 0;
  cdp.on('Network.requestWillBeSent', (event: RequestWillBeSentEvent) => {
    requests += 1;
    if (event.request.url.includes('/rpc')) {
      apiRequests += 1;
    }
  });
  cdp.on('Network.responseReceived', (event: ResponseReceivedEvent) => {
    resourceTypes.set(event.requestId, event.type);
  });
  cdp.on('Network.loadingFinished', (event: LoadingFinishedEvent) => {
    const resourceType = resourceTypes.get(event.requestId);
    if (resourceType === 'Script') {
      jsBytes += event.encodedDataLength;
    } else if (resourceType === 'Stylesheet') {
      cssBytes += event.encodedDataLength;
    }
  });
  await page.goto('/', { waitUntil: 'load' });
  const lcp = throttle ? (await collectVitals(page)).lcp : undefined;
  await context.close();
  return {
    requests,
    apiRequests,
    jsWireKb: jsBytes / 1024,
    cssWireKb: cssBytes / 1024,
    ...(lcp !== undefined ? { lcpMs: lcp } : {}),
  };
}

/** Подписка на /rpc-запросы страницы в окне сценария. */
function trackApiRequests(page: Page): () => number {
  let apiRequests = 0;
  const onRequest = (request: HttpRequest): void => {
    if (request.url().includes('/rpc')) {
      apiRequests += 1;
    }
  };
  page.on('request', onRequest);
  return () => {
    page.off('request', onRequest);
    return apiRequests;
  };
}

/**
 * Число long tasks (>50 мс) на странице за всё время её жизни: buffered-обсервер
 * на чтении отдаёт накопленные записи без window-глобалов и инжекта до сценария.
 */
async function readLongTasks(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let total = 0;
        new PerformanceObserver((list) => {
          total += list.getEntries().length;
        }).observe({ type: 'longtask', buffered: true });
        setTimeout(() => resolve(total), 100);
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

// Ретрай повтора (retries: 1 в CI) добавляет четвёртый замер: медиана из
// четырёх берёт верхний из двух средних — лёгкий сдвиг в красную сторону,
// допустимо (красный ретрай и так краснит прогон).
// Каждый повтор (--repeat-each) добавляет свой замер: отчёт — медиана ПО
// ПОВТОРАМ, иначе в perf.json попадает значение последнего повтора и
// межповторный шум ночных раннеров не сглажен (находка sanity-ревью A6.1).
const repeats: {
  'page:/': PageMetrics[];
  'scenario:create-task': ScenarioMetrics[];
  'scenario:toggle-task': ScenarioMetrics[];
} = {
  'page:/': [],
  'scenario:create-task': [],
  'scenario:toggle-task': [],
};

const pageMedian = (items: PageMetrics[]): PageMetrics => ({
  ttfbMs: median(items.map((m) => m.ttfbMs)),
  lcpMs: median(items.map((m) => m.lcpMs)),
  cls: median(items.map((m) => m.cls)),
  lcpNetMs: median(items.map((m) => m.lcpNetMs)),
  requests: median(items.map((m) => m.requests)),
  apiRequests: median(items.map((m) => m.apiRequests)),
  jsWireKb: median(items.map((m) => m.jsWireKb)),
  cssWireKb: median(items.map((m) => m.cssWireKb)),
});

const scenarioMedian = (items: ScenarioMetrics[]): ScenarioMetrics => ({
  ms: median(items.map((m) => m.ms)),
  apiRequests: median(items.map((m) => m.apiRequests)),
  longTasks: median(items.map((m) => m.longTasks)),
});

test.afterAll(async () => {
  const report: PerfReport = {
    'page:/': pageMedian(repeats['page:/']),
    'scenario:create-task': scenarioMedian(repeats['scenario:create-task']),
    'scenario:toggle-task': scenarioMedian(repeats['scenario:toggle-task']),
  };
  // Схема — общий источник с тренд-чекером: невалидный отчёт не должен
  // уезжать в артефакт и красить сравнение «неизвестной» формой (З4).
  const parsed = PerfReportSchema.safeParse(report);
  if (!parsed.success) {
    throw new Error(`perf report failed schema: ${parsed.error.message}`);
  }
  await mkdir('reports', { recursive: true });
  await writeFile('reports/perf.json', `${JSON.stringify(report, null, 2)}\n`);
});

test.describe('perf budgets', { lock: SHARED_DATA_LOCK }, () => {
  test('page "/" stays within web vitals budget', async ({ page, browser, baseURL }, testInfo) => {
    const budget = budgetFor(budgets.web.pages, '/');
    await page.goto('/'); // прогрев
    const samples: { ttfb: number; lcp: number; cls: number }[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      await page.goto('/', { waitUntil: 'load' });
      samples.push(await collectVitals(page));
    }
    // Детерминированные метрики — холодные загрузки: сеть (без троттлинга) и LCP под Fast 3G.
    const cold: ColdLoad[] = [];
    const net: ColdLoad[] = [];
    for (let i = 0; i < COLD_SAMPLES; i++) {
      net.push(await coldLoad(browser, baseURL ?? '/', false));
      cold.push(await coldLoad(browser, baseURL ?? '/', true));
    }

    const measured = {
      ttfbMs: median(samples.map((s) => s.ttfb)),
      lcpMs: median(samples.map((s) => s.lcp)),
      cls: median(samples.map((s) => s.cls)),
      lcpNetMs: median(cold.map((c) => c.lcpMs ?? Number.NaN)),
      requests: median(net.map((c) => c.requests)),
      apiRequests: median(net.map((c) => c.apiRequests)),
      jsWireKb: median(net.map((c) => c.jsWireKb)),
      cssWireKb: median(net.map((c) => c.cssWireKb)),
    };
    repeats['page:/'].push(measured);
    await testInfo.attach('vitals', {
      body: JSON.stringify({ measured, budget }, null, 2),
      contentType: 'application/json',
    });

    expect.soft(measured.ttfbMs, 'TTFB, ms').toBeLessThanOrEqual(budget.maxTtfbMs);
    expect.soft(measured.lcpMs, 'LCP, ms').toBeLessThanOrEqual(budget.maxLcpMs);
    expect.soft(measured.cls, 'CLS').toBeLessThanOrEqual(budget.maxCls);
    expect.soft(measured.lcpNetMs, 'LCP под Fast 3G, ms').toBeLessThanOrEqual(budget.maxLcpNetMs);
    expect
      .soft(measured.requests, 'запросов на холодную загрузку')
      .toBeLessThanOrEqual(budget.maxRequests);
    expect
      .soft(measured.apiRequests, 'запросов к API на загрузку')
      .toBeLessThanOrEqual(budget.maxApiRequests);
    expect.soft(measured.jsWireKb, 'wire-байты JS, KB').toBeLessThanOrEqual(budget.maxJsWireKb);
    expect.soft(measured.cssWireKb, 'wire-байты CSS, KB').toBeLessThanOrEqual(budget.maxCssWireKb);
  });

  test('scenario "create-task" stays within budget', async ({ page }, testInfo) => {
    const budget = budgetFor(budgets.web.scenarios, 'create-task');
    await page.goto('/');
    const stopApiRequests = trackApiRequests(page);
    const durations: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const title = `Perf task ${testInfo.repeatEachIndex}-${testInfo.retry}-${i}`;
      await page.getByLabel('New task').fill(title);
      const start = performance.now();
      await page.getByRole('button', { name: 'Add task' }).click();
      await expect(page.getByRole('checkbox', { name: title })).toBeVisible();
      durations.push(performance.now() - start);
    }
    const measured = {
      ms: median(durations),
      apiRequests: stopApiRequests(),
      longTasks: await readLongTasks(page),
    };
    repeats['scenario:create-task'].push(measured);
    await testInfo.attach('timings', {
      body: JSON.stringify({ durations, budget }, null, 2),
      contentType: 'application/json',
    });

    expect(measured.ms, 'create-task median, ms').toBeLessThanOrEqual(budget.maxMs);
    expect(measured.apiRequests, 'create-task запросов к API').toBeLessThanOrEqual(
      budget.maxApiRequests,
    );
    expect(measured.longTasks, 'create-task long tasks').toBeLessThanOrEqual(budget.maxLongTasks);
  });

  test('scenario "toggle-task" stays within budget', async ({ page }, testInfo) => {
    const budget = budgetFor(budgets.web.scenarios, 'toggle-task');
    await page.goto('/');
    const stopApiRequests = trackApiRequests(page);
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
    const measured = {
      ms: median(durations),
      apiRequests: stopApiRequests(),
      longTasks: await readLongTasks(page),
    };
    repeats['scenario:toggle-task'].push(measured);
    await testInfo.attach('timings', {
      body: JSON.stringify({ durations, budget }, null, 2),
      contentType: 'application/json',
    });

    expect(measured.ms, 'toggle-task median, ms').toBeLessThanOrEqual(budget.maxMs);
    expect(measured.apiRequests, 'toggle-task запросов к API').toBeLessThanOrEqual(
      budget.maxApiRequests,
    );
    expect(measured.longTasks, 'toggle-task long tasks').toBeLessThanOrEqual(budget.maxLongTasks);
  });
});
