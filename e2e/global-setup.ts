/**
 * Гейт «свой сервер» (З9, A5): `/__test__/instance` обязан ответить
 * instance-id этого прогона (reports/instance-token). Чужой процесс на порту
 * API красит прогон до первого теста с сообщением, кому принадлежит порт.
 *
 * Идентификатор отдаёт только тестовый контур (e68): публичный `/health`
 * отвечает одним статусом, поэтому зонд идёт сюда. Сервер, который стартует
 * конфиг Playwright, всегда несёт ENABLE_TEST_API=1.
 *
 * Гейты всегда стартуют свой сервер. Ручной сервер можно переиспользовать
 * только явно: REUSE_SERVER=1 + токен этого worktree (его пишет оркестратор
 * `pnpm dev`) и ENABLE_TEST_API=1, иначе конфиг не переиспользует занятый
 * порт вовсе, а без тестового API зонд ниже красит прогон.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { assertOwnServer, readInstanceToken } from '../tools/instance.ts';
import { apiOriginFor, resolvePorts } from '../tools/ports.ts';

const TOKEN_FILE = 'reports/instance-token';

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
  const url = `${API_URL}/__test__/instance`;
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
  if (!response.ok) {
    // Сервер на порту есть, но `/__test__/*` не отвечает: тестовый API выключен.
    // Так отличим ручной сервер без ENABLE_TEST_API=1 (голый `pnpm dev`) от
    // чужого процесса — и то, и другое красит прогон до первого теста.
    throw new Error(
      `${url} answered ${response.status} — the port is owned by a server without the test API ` +
        'or by a foreign process. For a manual server start it with ENABLE_TEST_API=1; ' +
        'otherwise stop whatever occupies the port and rerun.',
    );
  }
  const health: unknown = await response.json().catch(() => undefined);
  assertOwnServer({ url, expected, health });
}
