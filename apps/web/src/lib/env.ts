import { z } from 'zod';

/**
 * Единственный модуль окружения в `apps/web` (C3.0): `API_URL` и флаг SSR
 * читаются только здесь. Валидация `API_URL` срабатывает на SSR-запрос, а не
 * при старте процесса: непустоту при старте проверяет `requireApiUrlForServe`
 * в vite.config.ts (конфиг, не код приложения), а node-тесты импортируют
 * цепочку api-client без SSR-окружения. Полный отказ при старте web-процесса —
 * предмет задачи C3.2. В клиентской сборке SSR-ветка выбрасывается
 * минификатором (ADR 0005), поэтому zod не попадает в бандл — это сканирует
 * гейт `bundle` (tools/check-bundle.ts).
 */

const API_URL_HINT =
  'export it (see reports/ports.json after `pnpm dev`) or run through `pnpm dev` / the e2e webServer';

const serverEnvSchema = z.object({
  API_URL: z.url({ error: `API_URL is empty or not an absolute URL: ${API_URL_HINT}` }),
});

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const name = issue.path.map(String).join('.') || '(environment)';
      return `  - ${name}: ${issue.message}`;
    })
    .join('\n');
}

/** Окружение SSR-процесса: адрес API обязателен только на сервере. */
export function loadWebServerEnv(source: Record<string, string | undefined> = process.env): {
  apiUrl: string;
} {
  const parsed = serverEnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid web environment:\n${formatIssues(parsed.error)}`);
  }
  return { apiUrl: parsed.data.API_URL };
}

/** Серверный рендер: Vite подставляет флаг на сборке, на клиенте — false. */
export function isServerRender(): boolean {
  return import.meta.env.SSR;
}
