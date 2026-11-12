import { defineConfig, devices } from '@playwright/test';

const CI = Boolean(process.env['CI']);
const WEB_URL = 'http://localhost:3000';
const API_URL = 'http://localhost:3001';

export default defineConfig({
  testDir: '.',
  outputDir: 'test-results',
  fullyParallel: true,
  forbidOnly: CI,
  // Ретрай нужен только чтобы отличить флак от падения; флак всё равно валит прогон.
  retries: CI ? 1 : 0,
  failOnFlakyTests: CI,
  // В CI базлайны никогда не создаются и не перезаписываются: только `pnpm visual:update` человеком.
  updateSnapshots: CI ? 'none' : 'missing',
  reporter: CI
    ? [['github'], ['html', { open: 'never' }], ['json', { outputFile: 'reports/e2e.json' }]]
    : [['list'], ['html', { open: 'never' }]],
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
      env: { PORT: '3001', WEB_ORIGIN: WEB_URL, ENABLE_TEST_API: '1' },
    },
    {
      // Production-сборка (`turbo run e2e` собирает web заранее).
      command: 'pnpm --filter @repo/web start',
      url: WEB_URL,
      reuseExistingServer: !CI,
    },
  ],
});
