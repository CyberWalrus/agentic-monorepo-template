import {
  createServerEntry,
  createStartHandler,
  defaultStreamHandler,
} from '@tanstack/react-start/server';

import { registerSsrFetch } from './lib/api-client.ts';
import { runWithRequestWorkspace, ssrFetch } from './lib/ssr-workspace.ts';

/**
 * Кастомный server entry TanStack Start (плагин резолвит `src/server.ts`,
 * иначе — встроенный default entry с той же формой). Два отличия от default:
 * 1) обработчик заворачивает документ-запрос в AsyncLocalStorage с рабочим
 *    пространством (ADR 0020);
 * 2) регистрирует SSR-fetch для RPCLink — запросы лоадера к API несут
 *    заголовок `x-workspace-id`, иначе лоадер `/` префетчит «ничей» (пустой)
 *    список и сидированные E2E-данные не попадут в серверный рендер.
 * Регистрация именно здесь: модуль ssr-workspace (node:async_hooks) живёт
 * только в серверной сборке — клиентский бандл его не содержит (гейт `bundle`).
 *
 * Форма повторяет default entry TanStack Start: `createServerEntry({ fetch })`,
 * контракт сборки — `{ default: { fetch } }` (ADR 0012).
 */
registerSsrFetch(ssrFetch);

const startFetch = createStartHandler(defaultStreamHandler);

const fetch = (request: Request): Promise<Response> =>
  runWithRequestWorkspace(request, () => Promise.resolve(startFetch(request)));

export default createServerEntry({ fetch });
