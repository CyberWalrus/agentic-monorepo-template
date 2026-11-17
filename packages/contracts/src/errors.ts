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
 * Общие ошибки всех процедур: FORBIDDEN (политики доступа, C2.2) и
 * INTERNAL_SERVER_ERROR (встроенный код oRPC для непойманного; декларируется
 * ради типизированного клиента и документации 500 — выбрасывает его механизм
 * oRPC, не домен). Прикрепляются на ocAccess, поэтому у каждой процедуры.
 */
export const commonErrors = {
  FORBIDDEN: { message: ERROR_MESSAGES.FORBIDDEN },
  INTERNAL_SERVER_ERROR: { message: ERROR_MESSAGES.INTERNAL },
} as const;

/**
 * NOT_FOUND для процедур, у которых «не найден» возможен и заявлен контрактом
 * (tasks.toggle). Где код не объявлен, отказ тот же FORBIDDEN — fail-closed
 * без оракула существования (C2.3).
 */
export const notFoundError = { message: ERROR_MESSAGES.NOT_FOUND } as const;
