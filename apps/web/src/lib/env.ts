import { z } from 'zod';

/**
 * Единственный модуль окружения в `apps/web` (C3.0): `API_URL` и флаг SSR
 * читаются только здесь. Валидация `API_URL` срабатывает на SSR-запрос, а не
 * при старте процесса: непустоту при старте проверяет `requireApiUrlForServe`
 * в vite.config.ts (конфиг, не код приложения), а node-тесты импортируют
 * цепочку api-client без SSR-окружения. Полный отказ при старте production-entry
 * — `loadWebProcessEnv` ниже (C3.2): невалидное окружение не запускает процесс.
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

/** Ключи окружения web (union SSR- и process-схем) — полнота env.example (гейт C3.1). */
export const WEB_ENV_KEYS = ['API_URL', 'PORT', 'HOST'] as const;

/** Окружение SSR-процесса: адрес API обязателен только на сервере. */
export function loadWebServerEnv(source: Record<string, string | undefined> = process.env): {
  apiUrl: string;
} {
  const serverEnvSchema = z.object({
    // Прокси и SSR fetch ходят по http(s); другая схема — ошибка конфигурации.
    API_URL: z.url({
      protocol: /^https?$/,
      error: `API_URL is empty or not an http(s) URL: ${API_URL_HINT}`,
    }),
  });
  const parsed = serverEnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid web environment:\n${formatIssues(parsed.error)}`);
  }
  return { apiUrl: parsed.data.API_URL };
}

export interface WebProcessEnv {
  port: number;
  host: string;
  apiUrl: string;
}

/**
 * Окружение production-entry (`server.ts`, C3.2): невалидный процесс не
 * стартует вовсе (fail-closed) — включая пустой API_URL, из-за которого прокси
 * `/rpc` и SSR были бы молча сломаны. SSR-рендер читает окружение через
 * `loadWebServerEnv` на запрос; эта функция — только для старта процесса.
 * Схемы создаются внутри функции, не на верхнем уровне модуля: zod в
 * клиентском бандле не нужен, и tree-shaking выбрасывает всё тело функции
 * вместе с zod (закон c3.0, гейт `bundle`).
 */
export function loadWebProcessEnv(
  source: Record<string, string | undefined> = process.env,
): WebProcessEnv {
  const PORT_HINT =
    'export it (see reports/ports.json after `pnpm dev`) or pass it explicitly for `pnpm --filter @repo/web start:prod`';

  // Порт production-entry обязателен: фиксированного дефолта нет — правила те
  // же, что у api (server-config.ts): два worktree не должны делить порт (З9, A5).
  const processPortSchema = z
    .string({ error: `PORT is missing: ${PORT_HINT}` })
    .min(1, { error: `PORT is empty: ${PORT_HINT}` })
    .refine((raw) => /^\d+$/.test(raw), {
      error: `PORT is not a positive integer: ${PORT_HINT}`,
    })
    .transform(Number)
    .refine((port) => port > 0, { error: `PORT must be greater than zero: ${PORT_HINT}` });

  // Хост привязки: 127.0.0.1 локально, 0.0.0.0 в контейнере (ENV образа, ADR 0012).
  const processHostSchema = z
    .string()
    .refine((host) => host.length > 0, {
      error: 'HOST is empty: pass a host to bind, e.g. 0.0.0.0 inside a container',
    })
    .refine((host) => !/\s/.test(host), {
      error:
        'HOST must not contain whitespace: pass a host to bind, e.g. 0.0.0.0 inside a container',
    })
    .default('127.0.0.1');

  const processEnvSchema = z.object({
    PORT: processPortSchema,
    HOST: processHostSchema,
    API_URL: z.url({
      protocol: /^https?$/,
      error: `API_URL is empty or not an http(s) URL: ${API_URL_HINT}`,
    }),
  });
  const parsed = processEnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid web environment:\n${formatIssues(parsed.error)}`);
  }
  return { port: parsed.data.PORT, host: parsed.data.HOST, apiUrl: parsed.data.API_URL };
}

/**
 * База RPC-адреса: SSR ходит напрямую в API (адрес — из env), браузер — в свой
 * origin (ADR 0005). Чтение на запрос, не при импорте; в клиентской сборке
 * остаётся только браузерная ветвь.
 */
export function apiBaseUrl(): string {
  return import.meta.env.SSR ? loadWebServerEnv().apiUrl : location.origin;
}
