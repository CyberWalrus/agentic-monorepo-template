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
  /**
   * Идентификатор экземпляра (`INSTANCE_ID`): с ним каждая запись лога несёт
   * поле `instanceId` (e68). Публичный `/health` идентификатор больше не
   * отдаёт — «какой экземпляр это написал» ищут в логе, а не в ответе сервера.
   * Без значения ключа в записях нет.
   */
  instanceId?: string;
}

export function createLogger(options: LoggerOptions = {}) {
  const sink = options.sink ?? consoleSink;
  const now = options.now ?? (() => new Date());
  const instanceId = options.instanceId;
  return (level: LogLevel, event: string, fields: Record<string, unknown> = {}): void => {
    sink({
      ts: now().toISOString(),
      level,
      event,
      ...(instanceId === undefined ? {} : { instanceId }),
      ...fields,
    });
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
 * Форма идентификатора, безопасная для лога и ответа (whitelist против
 * log-injection): UUID и W3C traceparent проходят. Отдельный предикат — тем
 * же правилом валидируется выборка `/__test__/logs` (C4).
 */
export function isSafeRequestId(value: string): boolean {
  return REQUEST_ID_PATTERN.test(value);
}

/**
 * Идентификатор запроса: из заголовка x-request-id, если он безопасной формы
 * (whitelist против log-injection и мусора в ответе), иначе свежий uuid.
 * UUID и W3C traceparent проходят whitelist — будущий трейс-id ляжет сюда же.
 */
export function requestIdOf(request: Request, generateId: () => string = randomUUID): string {
  const header = request.headers.get('x-request-id');
  if (header !== null && isSafeRequestId(header)) {
    return header;
  }
  return generateId();
}

/** Кольцевой буфер записей лога: E2E-прогон копит события для выборки по id (C4). */
export interface LogBuffer {
  write: LogSink;
  records(): readonly LogRecord[];
}

/**
 * Ограниченный кольцевой буфер (C4): при включённом тест-API каждое событие
 * лога попадает и в него; `/__test__/logs` отдаёт срез по идентификаторам
 * запроса, поэтому логи сценария не смешиваются с записями соседних
 * параллельных тестов. Ёмкость ограничивает память: при переполнении
 * вытесняются самые старые записи — буфер для диагностики падений, не аудит.
 */
export function createLogBuffer(capacity = 4096): LogBuffer {
  const ring: LogRecord[] = [];
  return {
    write: (record) => {
      ring.push(record);
      if (ring.length > capacity) {
        ring.shift();
      }
    },
    records: (): readonly LogRecord[] => [...ring],
  };
}
