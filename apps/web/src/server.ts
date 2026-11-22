import {
  createServerEntry,
  createStartHandler,
  defaultStreamHandler,
} from '@tanstack/react-start/server';

import { runWithRequestWorkspace } from './lib/ssr-workspace.ts';

/**
 * Кастомный server entry TanStack Start (плагин резолвит `src/server.ts`,
 * otherwise — встроенный default entry с той же формой). Отличие одно:
 * обработчик заворачивает документ-запрос в AsyncLocalStorage с рабочим
 * пространством (ADR 0020), чтобы SSR-fetch RPCLink нёс заголовок
 * `x-workspace-id` к API — иначе лоадер `/` префетчит «ничей» (пустой) список
 * и сидированные E2E-данные не попадут в серверный рендер.
 *
 * Форма повторяет default entry TanStack Start: `createServerEntry({ fetch })`,
 * контракт сборки — `{ default: { fetch } }` (ADR 0012).
 */
const startFetch = createStartHandler(defaultStreamHandler);

const fetch = (request: Request): Promise<Response> =>
  runWithRequestWorkspace(request, () => Promise.resolve(startFetch(request)));

export default createServerEntry({ fetch });
