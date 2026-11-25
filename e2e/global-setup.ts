/**
 * Гейт «свой сервер» (З9, A5): /health обязан ответить instance-id этого
 * прогона (reports/instance-token). Чужой процесс на порту API красит прогон
 * до первого теста с сообщением, кому принадлежит порт.
 *
 * Instance-id /health отдаёт только сервер с включённым тестовым API (e68):
 * у каждого сервера, который стартует конфиг Playwright, он включён.
 *
 * Гейты всегда стартуют свой сервер. Ручной сервер можно переиспользовать
 * только явно: REUSE_SERVER=1 + токен этого worktree (его пишет оркестратор
 * `pnpm dev`) и ENABLE_TEST_API=1, иначе конфиг не переиспользует занятый
 * порт вовсе, а без тестового API проверка ниже красит прогон.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { assertOwnServer, readInstanceToken } from '../tools/instance.ts';
import { apiOriginFor, resolvePorts } from '../tools/ports.ts';

const TOKEN_FILE = 'reports/instance-token';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export default async function globalSetup(): Promise<void> {
  // Порты читаем из файла выбора конфига (см. resolvePorts): зонд после старта
  // серверов уехал бы на чужой порт.
  const { api } = await resolvePorts(resolve(import.meta.dirname, '..'));
  const API_URL = apiOriginFor(api);
  let raw: string;
  try {
    raw = readFileSync(TOKEN_FILE, 'utf8');
  } catch {
    throw new Error(
      `${TOKEN_FILE} is missing — run e2e through playwright.config.ts of this checkout, it issues the run token`,
    );
  }
  const expected = readInstanceToken(raw);
  const url = `${API_URL}/health`;
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error: unknown) {
    // Readiness-poll только что прошёл: сюда попадает узкая гонка или порт занял
    // процесс, отвечающий невалидным HTTP. В обоих случаях прогон объясняет себя.
    throw new Error(`${url} is not reachable: stop whatever occupies the port and rerun`, {
      cause: error,
    });
  }
  const health: unknown = await response.json().catch(() => undefined);
  // «Здоров, но без идентификатора» — сервер без ENABLE_TEST_API=1 (ручной
  // `pnpm dev` без него): называем причину точнее общего «without INSTANCE_ID».
  if (isRecord(health) && health['status'] === 'ok' && !('instance' in health)) {
    throw new Error(
      `${url} is healthy but gives no instance id — the port is owned by a server without the ` +
        'test API (ENABLE_TEST_API=1). Start a manual server with it or stop whatever occupies ' +
        'the port and rerun.',
    );
  }
  assertOwnServer({ url, expected, health });
}
