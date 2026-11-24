/**
 * Каталог сообщений ошибок (C4.1): единый источник текстов таксономии.
 * Клиент различает ошибки по коду; текст на код один и статичен — ни данные
 * запроса, ни интерполяция в него не попадают в ответ и лог. Новые коды —
 * аддитивно сюда, не инлайном у процедур; тест errors.test.ts красит
 * процедуру с объявленной ошибкой мимо каталога.
 */
export const ERROR_MESSAGES = {
  FORBIDDEN: 'Access denied',
  NOT_FOUND: 'Resource not found',
  // Текст INTERNAL_SERVER_ERROR совпадает с тем, что oRPC кладёт на провод
  // для непойманного: на один код — один текст, где бы он ни перехватился.
  INTERNAL: 'Internal server error',
} as const;

/**
 * Общие ошибки всех процедур: INTERNAL_SERVER_ERROR (встроенный код oRPC для
 * непойманного; декларируется ради типизированного клиента и документации
 * 500 — выбрасывает его механизм oRPC, не домен). Прикрепляются обоими
 * строителями access-policy.ts, поэтому у каждой процедуры.
 */
export const commonErrors = {
  INTERNAL_SERVER_ERROR: { message: ERROR_MESSAGES.INTERNAL },
} as const;

/**
 * FORBIDDEN — ошибка процедур с проверкой доступа (политики owner и admin,
 * C2.2): её бросает мидлварь авторизации, когда актора нет или он чужой, и
 * роутер (tasks.remove вне scope, e52). Public-процедуры её не объявляют:
 * без проверки доступа бросать её некому, а контракт описывает только
 * достижимое (e57, ADR 0024).
 */
export const forbiddenError = { message: ERROR_MESSAGES.FORBIDDEN } as const;

/** Ошибки процедур с проверкой доступа: общие и FORBIDDEN. */
export const accessErrors = { ...commonErrors, FORBIDDEN: forbiddenError } as const;

/**
 * NOT_FOUND для процедур, у которых «не найден» возможен и заявлен контрактом
 * (tasks.toggle). Где код не объявлен, отказ тот же FORBIDDEN — fail-closed
 * без оракула существования (C2.3).
 */
export const notFoundError = { message: ERROR_MESSAGES.NOT_FOUND } as const;
