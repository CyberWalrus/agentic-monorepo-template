import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig, devices } from '@playwright/test';

import { e2eFeatureDirs, functionalTestIgnore, parseE2eFeaturesEnv } from '../tools/e2e-select.ts';
import { apiOrigin, resolvePorts } from '../tools/ports.ts';
import { assertVisualRunAllowed, snapshotsUpdateMode } from '../tools/visual-guard.ts';

// Визуальные тесты — только в Docker-образе (З4, A8): базлайны без суффикса
// платформы существуют только для Linux. Проверка стоит ДО любых побочных
// эффектов конфига (resolvePorts, instance-token): запрет не создаёт файлов.
assertVisualRunAllowed({
  argv: process.argv,
  platform: process.platform,
  allowEnv: process.env['ALLOW_HOST_SCREENSHOTS'],
});

const CI = Boolean(process.env['CI']);
const repoRoot = resolve(import.meta.dirname, '..');
// Порты из worktree (З9, A5 PR-3): read-first — resolvePorts. ВАЖНО: Playwright
// оценивает конфиг в НЕСКОЛЬКИХ процессах (раннер + global setup), каждый
// запускается после старта серверов предыдущего — вторичному выбору зонд
// показал бы собственные серверы, сдвиг перезаписал бы файл выбора и увёл
// потребителей на пустой порт (наблюдалось). Поэтому выбирает ровно один
// процесс (первый: env/file отсутствуют), остальные читают; занятость портов
// из прошлого сеанса = громкий EADDRINUSE, сброс — `rm reports/ports.json`.
const ports = await resolvePorts(repoRoot);
// Выбранный порт внутрь прогона — через env: воркеры и global setup наследуют
// его от процесса-раннера, файл ports.json могли бы переписать параллельные
// импорты (наблюдалось: collection- и worker-импорты фикстур читали разные
// версии файла).
process.env['API_PORT'] = String(ports.api);
const WEB_URL = ports.origin;
const API_URL = apiOrigin(ports);
// Токен прогона (З9, A5): он же уходит API через INSTANCE_ID, global-setup.ts
// сверяет /health с ним — прогон не может незаметно пойти против чужого
// процесса на том же порту. 0600: токен не читается другими пользователями.
// REUSE_SERVER=1 (ручная отладка): существующий токен от `pnpm dev` (его пишет
// оркестратор tools/dev.ts) не перезаписывается — reuse возможен только для
// сервера, который сам опубликовал токен этого worktree.
const tokenFile = resolve(repoRoot, 'e2e', 'reports', 'instance-token');
mkdirSync(resolve(tokenFile, '..'), { recursive: true });
const reuseManualServer = process.env['REUSE_SERVER'] === '1' && existsSync(tokenFile);
const INSTANCE_ID = reuseManualServer ? readFileSync(tokenFile, 'utf8').trim() : randomUUID();
if (!reuseManualServer) {
  writeFileSync(tokenFile, `${INSTANCE_ID}\n`, { mode: 0o600 });
}
// JSON-отчёт читает гейт test-report (З3, A3): skipped/todo/expected failure = 0.
// Любой запуск Playwright (включая --project=perf/visual) перезаписывает этот файл,
// поэтому проверка отчёта e2e идёт сразу после задачи e2e, до perf.
const JSON_REPORTER = ['json', { outputFile: 'reports/e2e.json' }] as const;
// Выбор E2E по фичам (B4.1): env E2E_FEATURES выставляет только CI (job e2e,
// только PR) и действует только там (M1-ревью: локальный прогон агента не
// сужается случайной переменной окружения). Пусто/'all'/мусор → всё: локальный
// pnpm e2e, merge queue, push и nightly без env. Сквозные e2e-фичи (без
// app-каталога) и @critical-файлы не игнорируются никогда.
const e2eSelection = CI
  ? parseE2eFeaturesEnv(process.env['E2E_FEATURES'], e2eFeatureDirs(repoRoot))
  : { mode: 'all' as const, features: [] as string[] };
const e2eIgnore =
  e2eSelection.mode === 'subset' ? functionalTestIgnore(repoRoot, e2eSelection.features) : [];

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
  // Базлайны создаются только `pnpm visual:update` человеком внутри образа
  // (VISUAL_UPDATE=1, A8); вне его запись выключена всегда — не только в CI.
  updateSnapshots: snapshotsUpdateMode(process.env),
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
      testIgnore: e2eIgnore,
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
      // Гейты всегда стартуют свой сервер (З9, A5 PR-3); ручной reuse — только
      // через REUSE_SERVER=1 и токен этого worktree (см. INSTANCE_ID выше).
      reuseExistingServer: reuseManualServer,
      // NODE_ENV=test — вторая половина явного включения (e69): сервер открывает
      // тестовый API только при NODE_ENV=development|test, иначе отказывает в старте.
      env: { PORT: String(ports.api), ENABLE_TEST_API: '1', INSTANCE_ID, NODE_ENV: 'test' },
    },
    {
      // Production-способ запуска — тот же entry, что деплоится (C3.2, C3.4):
      // `start:prod` = `node server.ts` (статика dist/client + прокси /rpc +
      // SSR, ADR 0012). Сборку web делают заранее turbo-задачи e2e/perf
      // (dependsOn ^build) и tools/visual-inner.sh — entry fail-closed на
      // отсутствие dist. API_URL — цель прокси /rpc (ADR 0005), читается при
      // старте, не при сборке; PORT — env, обязателен без дефолта (флага
      // --port у entry нет); HOST — дефолт 127.0.0.1 (URL гейтов, ADR 0005);
      // Playwright мержит env веб-сервера поверх process.env. Готовность —
      // дешёвый /healthz, без SSR-зависимости от API.
      command: 'pnpm --filter @repo/web start:prod',
      url: `${WEB_URL}/healthz`,
      reuseExistingServer: reuseManualServer,
      env: { API_URL, PORT: String(ports.web) },
    },
  ],
});
