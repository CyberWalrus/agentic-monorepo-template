import { bodyLimit } from 'hono/body-limit';
import type { Context, Next } from 'hono';

/**
 * Потолок тела и таймаут запроса веб-сервера (e55): тот же контур, что у API
 * (c1.7, `apps/api/src/app.ts`) — те же значения и те же тела 413 и 504, чтобы
 * клиент видел один контур ошибок на оба входа. Значения — константы кода с
 * инъекцией для тестов, а не env-ручки: потолок — свойство контура, а не
 * настройка развёртывания (решение c1.7). Условие возврата — то же: реальному
 * потребителю понадобится другой потолок — заводим переменную окружения с
 * валидацией в `env.ts` рядом.
 */
export const REQUEST_BODY_LIMIT_BYTES = 1_048_576;
export const REQUEST_TIMEOUT_MS = 30_000;

/** Мидлварь Hono в той же сигнатуре, что у ограждений API. */
type Guard = (c: Context, next: Next) => Promise<Response | void>;

export interface RequestGuardsOptions {
  /** Потолок тела запроса в байтах (e55). Дефолт — константа выше; инъекция — для тестов, не env-ручка. */
  bodyLimitBytes?: number;
  /** Таймаут запроса в миллисекундах (e55); дефолт — константа выше. Инъекция — для тестов: дефолтный таймаут ждал бы полминуты. */
  requestTimeoutMs?: number;
}

/**
 * Гонка «обработчик vs таймер»: ответ ограничен по времени, даже если
 * обработчик завис. Сам обработчик при победе таймера не прерывается — сигнал
 * в него не передаётся, как и в API (c1.7). Проигравшая гонкой ветка
 * продолжает слушаться `Promise.race`: её поздний отказ не становится
 * unhandledRejection.
 */
const requestTimeout =
  (ms: number): Guard =>
  async (c, next) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<Response>((resolve) => {
      timer = setTimeout(() => resolve(c.json({ error: 'Request timed out' }, 504)), ms);
    });
    try {
      return await Promise.race([next(), expired]);
    } finally {
      clearTimeout(timer);
    }
  };

/**
 * Пара ограждений для класса запросов: тело сверх потолка — 413 до чтения
 * (по content-length) или по фактическим байтам (без content-length), зависший
 * обработчик — 504 по таймеру. Ставится на класс (catch-all), а не на каждый
 * маршрут: иначе каждая следующая server function будет забытым исключением.
 */
export function requestGuards({
  bodyLimitBytes = REQUEST_BODY_LIMIT_BYTES,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
}: RequestGuardsOptions = {}): [Guard, Guard] {
  return [
    bodyLimit({
      maxSize: bodyLimitBytes,
      onError: (c) => c.json({ error: 'Payload too large' }, 413),
    }),
    requestTimeout(requestTimeoutMs),
  ];
}
