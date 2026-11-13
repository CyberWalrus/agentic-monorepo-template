import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

import { defineConfig, devices } from '@playwright/test';

const CI = Boolean(process.env['CI']);
const WEB_URL = 'http://localhost:3000';
// Цель прокси /rpc (ADR 0005): env из задачи e2e/perf (turbo), fallback — до
// вывода портов из worktree (A5 PR-3), после которого он исчезнет.
const API_URL = process.env['API_URL'] ?? 'http://localhost:3001';
// Токен прогона (З9, A5): он же уходит API через INSTANCE_ID, global-setup.ts
// сверяет /health с ним — прогон не может незаметно пойти против чужого
// процесса на том же порту. 0600: токен не читается другими пользователями.
const INSTANCE_ID = randomUUID();
mkdirSync('reports', { recursive: true });
writeFileSync('reports/instance-token', `${INSTANCE_ID}\n`, { mode: 0o600 });
// JSON-отчёт читает гейт test-report (З3, A3): skipped/todo/expected failure = 0.
// Любой запуск Playwright (включая --project=perf/visual) перезаписывает этот файл,
// поэтому проверка отчёта e2e идёт сразу после задачи e2e, до perf.
const JSON_REPORTER = ['json', { outputFile: 'reports/e2e.json' }] as const;

export default defineConfig({
  testDir: '.',
  outputDir: 'test-results',
  // Сверка «свой сервер» (З9, A5): логика в tools/instance.ts, токен — выше.
  globalSetup: './global-setup.ts',
  fullyParallel: true,
  forbidOnly: CI,
  // Ретрай нужен только чтобы отличить флак от падения; флак всё равно валит прогон.
  retries: CI ? 1 : 0,
  failOnFlakyTests: CI,
  // В CI базлайны никогда не создаются и не перезаписываются: только `pnpm visual:update` человеком.
  updateSnapshots: CI ? 'none' : 'missing',
  reporter: CI
    ? [['github'], ['html', { open: 'never' }], JSON_REPORTER]
    : [['list'], ['html', { open: 'never' }], JSON_REPORTER],
  // Базлайны без суффикса платформы: существуют только для Linux-образа Playwright.
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}',
  expect: {
    toHaveScreenshot: { type: 'webp', animations: 'disabled', caret: 'hide', maxDiffPixels: 0 },
  },
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    // VIDEO=on — видео прогона как доказательство работы для PR.
    video: process.env['VIDEO'] === 'on' ? 'on' : 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'functional',
      testMatch: 'features/**/*.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },
    // visual и perf перезаписывают общие данные API: по умолчанию не запускаются,
    // только явно через --project, и внутри сериализованы test lock'ом.
    {
      name: 'visual',
      default: false,
      testMatch: '**/*.visual.ts',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    {
      // Seed и окружение для Playwright Test Agents (planner/generator/healer).
      name: 'agents',
      default: false,
      testMatch: 'agents/**/*.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'perf',
      default: false,
      testMatch: 'perf/**/*.perf.ts',
      fullyParallel: false,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'pnpm --filter @repo/api start',
      url: `${API_URL}/health`,
      reuseExistingServer: !CI,
      env: { PORT: '3001', ENABLE_TEST_API: '1', INSTANCE_ID },
    },
    {
      // Production-сборка (`turbo run e2e` собирает web заранее). API_URL —
      // цель прокси /rpc (ADR 0005), читается при старте preview, не при сборке.
      command: 'pnpm --filter @repo/web start',
      url: WEB_URL,
      reuseExistingServer: !CI,
      env: { API_URL },
    },
  ],
});
