/**
 * Гейт «свой сервер» (З9, A5): конфиг Playwright выдаёт каждому прогону токен
 * (reports/instance-token, 0600), передаёт его API через INSTANCE_ID, global
 * setup сверяет ответ /health с этим токеном. Прогон не может незаметно пройти
 * против чужого процесса на том же порту: чужой сервер отвечает другим
 * instance-id (или не отвечает им вовсе) и красит прогон до первого теста.
 *
 * Канарейка шага verify невозможна (З6-исключение, в ряду test-count/perf):
 * удаление сверки не красит ни один шаг, пока на порту не стоит чужой сервер,
 * а decoy на занятом порту красит e2e и без сверки. Логика канареечна
 * юнит-тестами (tools/test/instance.test.ts) — паттерн «логика чекеров
 * канареечна отдельно».
 */

const TOKEN_PATTERN = /^[0-9a-f][0-9a-f-]{15,63}$/;

/** Экранирует управляющие символы: ответ чужого сервера не должен портить вывод гейта. */
function clean(text: string): string {
  let result = '';
  for (const char of text) {
    const code = char.charCodeAt(0);
    result += code >= 32 && code !== 127 ? char : `\\u${code.toString(16).padStart(4, '0')}`;
  }
  return result;
}

function preview(value: unknown): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? 'undefined');
  return clean(text.slice(0, 200));
}

/**
 * Токен из reports/instance-token. Форма проверяется до всякой интерполяции в
 * сообщения: файл может быть испорчен чужим процессом или руками.
 */
export function readInstanceToken(raw: string): string {
  const token = raw.trim();
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error(
      `reports/instance-token has an unexpected shape ("${clean(token.slice(0, 32))}", ` +
        `${token.length} chars); delete the file and rerun e2e`,
    );
  }
  return token;
}

export interface OwnServerProbe {
  /** URL, по которому спрашивали /health: попадает в каждое сообщение. */
  url: string;
  /** Токен этого прогона (readInstanceToken от reports/instance-token). */
  expected: string;
  /** Разобранный JSON-ответ /health. */
  health: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Сверяет ответ /health с токеном этого прогона. Чужой сервер = красный прогон. */
export function assertOwnServer({ url, expected, health }: OwnServerProbe): void {
  const status = isRecord(health) ? health['status'] : undefined;
  if (status !== 'ok') {
    throw new Error(
      `${url} did not answer with a health report: ${preview(health)} — ` +
        'stop whatever occupies the port and rerun.',
    );
  }
  const instance = isRecord(health) ? health['instance'] : undefined;
  if (typeof instance !== 'string' || instance.length === 0) {
    throw new Error(
      `${url} has no instance id — the port is owned by a server started outside e2e ` +
        '(without INSTANCE_ID). Stop that server: gates always start their own.',
    );
  }
  if (instance !== expected) {
    throw new Error(
      `${url} belongs to another instance (${clean(instance)}; this run is ${expected}) — ` +
        'another e2e run or a foreign server owns the port. Stop it and rerun.',
    );
  }
}
