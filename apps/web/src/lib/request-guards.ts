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

/** Тело заявлено заголовками — независимо от того, построил ли адаптер поток. */
const declaresBody = (headers: Headers): boolean =>
  headers.has('transfer-encoding') || Number(headers.get('content-length') ?? 0) > 0;

/**
 * Проверка формы запроса — fail-closed: не верит `request.body`.
 *
 * `@hono/node-server` собирает Request не так, как запрос пришёл по проводу:
 * `TRACE` получает GET без потока и подменённый геттер `method` — у него
 * `request.body === null`, хотя тело в соединении есть; у GET/HEAD потока тоже
 * нет. Ограждение, которое смотрит только на `request.body`, такой запрос
 * пропускает мимо лимита. Поэтому форма проверяется по тому, что запрос сам о
 * себе заявил, — по методу и заголовкам:
 *   - `TRACE` → 405: шаблонного сценария с ним нет, а собрать его честно
 *     адаптер не может;
 *   - тело объявлено (`content-length` больше 0 или есть `transfer-encoding`),
 *     а потока нет → 400: читать нечего, пропустить — значит пропустить мимо
 *     лимита тело, которое клиент шлёт.
 * Запрос без объявления тела (POST с `content-length: 0`) проходит как прежде.
 */
export const requestShapeGuard: Guard = async (c, next) => {
  const request = c.req.raw;
  if (request.method === 'TRACE') {
    return c.json({ error: 'Method not allowed' }, 405);
  }
  if (request.body === null && declaresBody(request.headers)) {
    return c.json({ error: 'Request body is not readable' }, 400);
  }
  return next();
};

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
 * Тройка ограждений для класса запросов — в порядке «форма → срок → потолок»:
 *   - форма (`requestShapeGuard`) — раньше всех: то, что нижние проверить не
 *     могут (метод, тело без потока), отбивается здесь;
 *   - срок: гонка «обработчик vs таймер» (504) стоит раньше потолка, потому что
 *     `bodyLimit` без content-length читает тело до конца раньше, чем вызовет
 *     `next()`: поставь его первым — и срок не накроет чтение медленного тела;
 *   - потолок: тело сверх лимита — 413 до чтения (по content-length) или по
 *     фактическим байтам.
 * Ставится на класс (catch-all), а не на каждый маршрут: иначе каждая
 * следующая server function будет забытым исключением.
 */
export function requestGuards({
  bodyLimitBytes = REQUEST_BODY_LIMIT_BYTES,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
}: RequestGuardsOptions = {}): [Guard, Guard, Guard] {
  return [
    requestShapeGuard,
    requestTimeout(requestTimeoutMs),
    bodyLimit({
      maxSize: bodyLimitBytes,
      onError: (c) => c.json({ error: 'Payload too large' }, 413),
    }),
  ];
}
