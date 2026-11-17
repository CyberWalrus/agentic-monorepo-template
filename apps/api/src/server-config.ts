import { z } from 'zod';

/**
 * Единственный модуль окружения в `apps/api` (C3.0): читает process.env,
 * проверяет схемой Zod и отдаёт типизированный объект. Невалидное окружение —
 * отказ при старте со списком «переменная: причина»; значения переменных в
 * сообщениях не фигурируют (DATABASE_URL содержит секреты). Решение по
 * хранилищу — `resolveServerStorage` ниже: чистая функция с unit-тестами,
 * server.ts остаётся проводкой (исключён из coverage и мутаций).
 */

const PORT_HINT = 'run through `pnpm dev`, the e2e webServer or `node tools/ports.ts --env`';

// Порт обязателен: его вычисляет tools/ports.ts (pnpm dev / e2e-конфиг / CI).
// Фиксированного дефолта нет — два worktree не должны делить порт (З9, A5).
const portSchema = z
  .string({ error: `PORT is missing: ${PORT_HINT}` })
  .min(1, { error: `PORT is empty: ${PORT_HINT}` })
  // Целиком из цифр (якоря важны: '12abc' и 'abc12' — не порт).
  .refine((raw) => /^\d+$/.test(raw), {
    error: `PORT is not a positive integer: ${PORT_HINT}`,
  })
  .transform(Number)
  .refine((port) => port > 0, { error: `PORT must be greater than zero: ${PORT_HINT}` });

// '1'/'true' включают, '0'/'false' выключают, отсутствие — false; любое другое
// значение (включая 'enabled' и 'yes' из дефолтного словаря stringbool) —
// отказ при старте, а не молчаливое «выключено».
const flagSchema = z.stringbool({ truthy: ['1', 'true'], falsy: ['0', 'false'] }).default(false);

// Хост привязки слушателя. Локально (pnpm dev, E2E, перф) — 127.0.0.1: URL
// гейтов — 127.0.0.1 (ADR 0005). Контейнеру нужен 0.0.0.0 — это ENV образа
// (Dockerfile, ADR 0012), а не дефолт кода: локальный сервер не должен
// случайно вылезти на все интерфейсы. Пустое значение и whitespace —
// конфигурация, а не «как получится»: отказ при старте.
const hostSchema = z
  .string()
  .refine((host) => host.length > 0, {
    error: 'HOST is empty: pass a host to bind, e.g. 0.0.0.0 inside a container',
  })
  .refine((host) => !/\s/.test(host), {
    error: 'HOST must not contain whitespace: pass a host to bind, e.g. 0.0.0.0 inside a container',
  })
  .default('127.0.0.1');

// Пустая строка равна отсутствующей (DATABASE_URL='' — in-memory, как и раньше).
const optionalStringSchema = z
  .string()
  .optional()
  .transform((value) => (value === '' ? undefined : value));

const serverEnvSchema = z
  .object({
    PORT: portSchema,
    HOST: hostSchema,
    ENABLE_TEST_API: flagSchema,
    ENABLE_TEST_API_WITH_DATABASE: flagSchema,
    INSTANCE_ID: optionalStringSchema,
    DATABASE_URL: optionalStringSchema,
    // Строгий enum: опечатка вида NODE_ENV=prod молча отключила бы прод-гвард.
    NODE_ENV: z.enum(['development', 'production', 'test']).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.ENABLE_TEST_API && env.NODE_ENV === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['ENABLE_TEST_API'],
        message: 'ENABLE_TEST_API must never be set in production',
      });
    }
  });

export interface ServerEnv {
  port: number;
  /** Хост привязки слушателя: 127.0.0.1 локально, 0.0.0.0 в контейнере. */
  host: string;
  instanceId: string | undefined;
  databaseUrl: string | undefined;
  enableTestApi: boolean;
  /** ENABLE_TEST_API_WITH_DATABASE=1 — явное подтверждение опасной комбинации. */
  testApiWithDatabase: boolean;
}

export type ServerStorage = { kind: 'memory' } | { kind: 'postgres'; connectionString: string };

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      // Путь у полевых issues всегда непустой: ключ переменной окружения.
      const name = issue.path.join('.') || '(environment)';
      return `  - ${name}: ${issue.message}`;
    })
    .join('\n');
}

/** Валидирует окружение процесса; при ошибке бросает перечень «переменная: причина». */
export function loadServerEnv(source: Record<string, string | undefined> = process.env): ServerEnv {
  const parsed = serverEnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid server environment:\n${formatIssues(parsed.error)}`);
  }
  const raw = parsed.data;
  return {
    port: raw.PORT,
    host: raw.HOST,
    instanceId: raw.INSTANCE_ID,
    databaseUrl: raw.DATABASE_URL,
    enableTestApi: raw.ENABLE_TEST_API,
    testApiWithDatabase: raw.ENABLE_TEST_API_WITH_DATABASE,
  };
}

/**
 * DATABASE_URL включает Postgres, иначе — in-memory (pnpm dev, E2E и перф
 * не требуют Docker до задачи C1.5). Сброс данных через test-API против
 * настоящей базы стирает её содержимое: комбинация требует отдельного
 * явного флага, молчаливого включения нет. Схема нормализует '' в undefined;
 * проверка пустой строки — защита для прямых вызовов мимо `loadServerEnv`.
 */
export function resolveServerStorage(
  env: Pick<ServerEnv, 'databaseUrl' | 'enableTestApi' | 'testApiWithDatabase'>,
): ServerStorage {
  if (env.databaseUrl === undefined || env.databaseUrl === '') {
    return { kind: 'memory' };
  }
  if (env.enableTestApi && !env.testApiWithDatabase) {
    throw new Error(
      'ENABLE_TEST_API=1 with DATABASE_URL must also set ENABLE_TEST_API_WITH_DATABASE=1: /__test__/reset wipes the real database',
    );
  }
  return { kind: 'postgres', connectionString: env.databaseUrl };
}
