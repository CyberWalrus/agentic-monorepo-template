import { serve } from '@hono/node-server';
import path from 'node:path';

import { loadWebProcessEnv } from './src/lib/env.ts';
import { createWebServerApp, isStartEntry } from './src/server-app.ts';

// Окружение валидируется при старте (fail-closed, C3.2): без PORT, HOST и
// API_URL процесс не поднимается — пустой API_URL означал бы молча сломанные
// прокси /rpc и SSR.
const env = loadWebProcessEnv();

// Fetch-обработчик серверной сборки TanStack Start: `vite build` пишет
// dist/server/server.js с контрактом `{ default: { fetch } }` (ADR 0012);
// контракт проверяется рантайм-гардом ниже — устаревшая сборка отказывает
// при старте со внятной ошибкой.
let imported: unknown;
try {
  // @ts-expect-error -- артефакт dist/server/server.js генерируется `vite build` без деклараций; контракт зафиксирован ADR 0012
  imported = await import('./dist/server/server.js');
} catch {
  throw new Error('Server build is missing: run `pnpm --filter @repo/web build` first');
}
if (!isStartEntry(imported)) {
  throw new Error(
    'Server build does not match the { default: { fetch } } contract (ADR 0012): run `pnpm --filter @repo/web build`',
  );
}
const start = imported;

const staticRoot = path.resolve(import.meta.dirname, 'dist/client');
const app = createWebServerApp({
  apiUrl: env.apiUrl,
  staticRoot,
  handler: (request) => start.default.fetch(request),
});

// Хост — из окружения (env.ts): локально 127.0.0.1, в контейнере 0.0.0.0.
const server = serve({ fetch: app.fetch, port: env.port, hostname: env.host }, (info) => {
  console.warn(`web listening on http://${env.host}:${info.port}`);
});

// SIGTERM — docker stop, SIGINT — Ctrl+C: слушатель закрывается, активные
// запросы доигрывают; принудительный таймаут — дело оркестратора (docker -t).
const shutdown = (signal: string): void => {
  console.warn(`web received ${signal}, closing`);
  server.close(() => process.exit(0));
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
