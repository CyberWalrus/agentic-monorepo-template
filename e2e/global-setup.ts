/**
 * Гейт «свой сервер» (З9, A5): /health обязан ответить instance-id этого
 * прогона (reports/instance-token). Чужой процесс на порту API красит прогон
 * до первого теста с сообщением, кому принадлежит порт.
 *
 * Ручной сервер (без INSTANCE_ID) красит прогон намеренно: гейты обязаны
 * запускать свой сервер. Повторное использование ручного сервера вернётся
 * в A5 PR-3 через явный флаг REUSE_SERVER и токен от dev-оркестратора.
 */
import { readFileSync } from 'node:fs';

import { assertOwnServer, readInstanceToken } from '../tools/instance.ts';

const TOKEN_FILE = 'reports/instance-token';
// До портов из worktree (A5 PR-3) адрес повторяет константу из playwright.config.ts.
const API_URL = 'http://localhost:3001';

export default async function globalSetup(): Promise<void> {
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
  assertOwnServer({ url, expected, health });
}
