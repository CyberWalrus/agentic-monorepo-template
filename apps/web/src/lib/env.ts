import { z } from 'zod';

/**
 * Единственный модуль окружения в `apps/web` (C3.0): `API_URL` и флаг SSR
 * читаются только здесь. Валидация `API_URL` срабатывает на SSR-запрос, а не
 * при старте процесса: непустоту при старте проверяет `requireApiUrlForServe`
 * в vite.config.ts (конфиг, не код приложения), а node-тесты импортируют
 * цепочку api-client без SSR-окружения. Полный отказ при старте web-процесса —
 * предмет задачи C3.2.
 *
 * Ветвление SSR/браузер живёт внутри этого модуля: в клиентской сборке Vite
 * подставляет `false` вместо `import.meta.env.SSR`, и tree-shaking выбрасывает
 * SSR-ветку вместе с zod (ADR 0005). Поэтому zod используется только внутри
 * функций, а не на верхнем уровне модуля — иначе он попал бы в клиентский
 * бандл и сломал бюджет (гейт `bundle`, tools/check-bundle.ts).
 */

const API_URL_HINT =
  'export it (see reports/ports.json after `pnpm dev`) or run through `pnpm dev` / the e2e webServer';

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      // Путь у полевых issues всегда непустой: ключ переменной окружения.
      const name = issue.path.join('.') || '(environment)';
      return `  - ${name}: ${issue.message}`;
    })
    .join('\n');
}

/** Окружение SSR-процесса: адрес API обязателен только на сервере. */
export function loadWebServerEnv(source: Record<string, string | undefined> = process.env): {
  apiUrl: string;
} {
  const serverEnvSchema = z.object({
    API_URL: z.url({ error: `API_URL is empty or not an absolute URL: ${API_URL_HINT}` }),
  });
  const parsed = serverEnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid web environment:\n${formatIssues(parsed.error)}`);
  }
  return { apiUrl: parsed.data.API_URL };
}

/**
 * База RPC-адреса: SSR ходит напрямую в API (адрес — из env), браузер — в свой
 * origin (ADR 0005). Чтение на запрос, не при импорте; в клиентской сборке
 * остаётся только браузерная ветвь.
 */
export function apiBaseUrl(): string {
  return import.meta.env.SSR ? loadWebServerEnv().apiUrl : location.origin;
}
