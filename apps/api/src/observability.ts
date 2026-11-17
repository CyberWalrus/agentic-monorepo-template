import { randomUUID } from 'node:crypto';

/** Уровни структурного лога (C4.1). */
export type LogLevel = 'info' | 'warn' | 'error';

/** Одна запись = одно событие: JSON-объект, наружу — строкой на stdout. */
export interface LogRecord {
  ts: string;
  level: LogLevel;
  event: string;
  [key: string]: unknown;
}

export type LogSink = (record: LogRecord) => void;

/** Продакшн-приёмник: строка JSON на stdout (контейнер отдаёт её как есть). */
const consoleSink: LogSink = (record) => {
  process.stdout.write(`${JSON.stringify(record)}\n`);
};

export interface LoggerOptions {
  sink?: LogSink;
  /** З13: время — через параметры; тесты фиксируют его. */
  now?: () => Date;
}

export function createLogger(options: LoggerOptions = {}) {
  const sink = options.sink ?? consoleSink;
  const now = options.now ?? (() => new Date());
  return (level: LogLevel, event: string, fields: Record<string, unknown> = {}): void => {
    sink({ ts: now().toISOString(), level, event, ...fields });
  };
}

/**
 * Ошибка сериализуется явно: JSON.stringify молча теряет Error.stack. Только
 * для непойманного (записи event 'unhandled'); у пойманных oRPC-ошибок в лог
 * идёт лишь код — сообщения каталога статичны, данные запроса не логируются.
 */
export function serializeError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return error.stack === undefined
      ? { name: error.name, message: error.message }
      : { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: 'NonError', message: String(error) };
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._~-]{8,128}$/;

/**
 * Идентификатор запроса: из заголовка x-request-id, если он безопасной формы
 * (whitelist против log-injection и мусора в ответе), иначе свежий uuid.
 * UUID и W3C traceparent проходят whitelist — будущий трейс-id ляжет сюда же.
 */
export function requestIdOf(request: Request, generateId: () => string = randomUUID): string {
  const header = request.headers.get('x-request-id');
  if (header !== null && REQUEST_ID_PATTERN.test(header)) {
    return header;
  }
  return generateId();
}
