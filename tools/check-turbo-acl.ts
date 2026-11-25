/**
 * Канарейка read-only ACL токена turbo-кэша (e27; ADR 0017, правило 2;
 * docs/architecture.md §3.3): токен environment `cache-read` обязан читать
 * remote-кэш и не писать в него. PR-job'ы ci.yml получают его прямо в env, и
 * код PR мог бы писать в кэш в обход клиента, если серверная гарантия
 * read-only сломалась (токен пересоздали с правом записи) — из репозитория
 * этого не видно, поэтому гарантия проверяется запросом к серверу.
 *
 * Как проверяет — тем же запросом, каким пишет сам turbo (протокол remote
 * cache: `/v8/artifacts/<hash>`, параметр `teamId`, `Authorization: Bearer`),
 * минуя клиент: клиент с read-only токеном молча пропускает неудачную запись.
 *   1. чтение: GET  — 404 значит «токен принят, артефакта с таким хешем нет»;
 *   2. запись: PUT  — тело-заглушка артефакта (октеты, не токен).
 *
 * Вердикты (exit-код джобы):
 *   - 0, skipped   — TURBO_TOKEN не заведён: предупреждение, проверять нечего;
 *   - 0, read-only — чтение разрешено (404), запись отклонена (401, 403);
 *   - 1, write     — PUT принят (2xx): токен пишет, гарантия не действует;
 *   - 2, unknown   — проверить не удалось: конфиг неполный, токен не читает,
 *                    сервер недоступен или ответил неожиданно.
 *
 * Fail-closed (З11): всё, что не доказано, красное — молчаливый пропуск
 * выглядел бы как «порядок». Отказом в записи засчитываются только 401 и 403:
 * иной код — человек читает тело ответа в выводе и решает, расширять ли
 * классификатор (журнал задачи e27). Токен в вывод не попадает: всё, что
 * пришло от сервера или из ошибки, проходит через маскировку. Один повтор на
 * сбой сети, таймаут и 5xx.
 *
 * Гоняет CI с environment `cache-read` — тот же токен, что у PR-job'ов ci.yml:
 * job `turbo-acl` в canaries.yml (push в `main`, ручной прогон; на PR пропущен —
 * вердикт исполнял бы сам код PR) и в nightly.yml (расписание: серверная
 * гарантия может сломаться без изменений в репозитории). Какой workflow как
 * зовёт чекер, сверяет тест проводки (tools/test/check-turbo-acl.test.ts).
 */
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

interface TurboAclOptions {
  /** Переменные окружения; по умолчанию process.env. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Транспорт; по умолчанию глобальный fetch. */
  fetchImpl?: FetchLike;
  /** Хеш артефакта-заглушки; по умолчанию случайный sha256-hex (64 символа). */
  hash?: string;
  /** Таймаут одного запроса; по умолчанию 10 с. */
  timeoutMs?: number;
  /** Пауза перед повтором; по умолчанию 1 с. */
  retryDelayMs?: number;
}

type TurboAclVerdict = 'skipped' | 'read-only' | 'write' | 'unknown';

interface TurboAclLine {
  level: 'info' | 'warning' | 'error';
  text: string;
}

interface TurboAclResult {
  verdict: TurboAclVerdict;
  /** 0 — зелёный (skipped, read-only); 1 — токен пишет; 2 — проверить не удалось. */
  exitCode: 0 | 1 | 2;
  lines: TurboAclLine[];
}

interface ProbeResponse {
  status: number;
  body: string;
}

type ProbeOutcome =
  | { ok: true; response: ProbeResponse }
  | { ok: false; status: number | null; reason: string; body: string; attempts: number };

const ATTEMPTS = 2;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;
/** Предел выдержки из тела ответа: причина видна, вывод не тонет. */
const BODY_EXCERPT = 300;
const ARTIFACT_ENDPOINT = 'v8/artifacts';

function isDenied(status: number): boolean {
  return status === 401 || status === 403;
}

function isAccepted(status: number): boolean {
  return status >= 200 && status < 300;
}

function clip(text: string): string {
  const flat = text.replaceAll(/\s+/g, ' ').trim();
  return flat.length > BODY_EXCERPT ? `${flat.slice(0, BODY_EXCERPT)}…` : flat;
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause: unknown = error.cause;
  const code =
    typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string'
      ? ` (${cause.code})`
      : '';
  return `${error.name}: ${error.message}${code}`;
}

/** Тело-заглушка артефакта: октеты (gzip), по которым не восстановить токен. */
function artifactBody(hash: string): Buffer {
  return gzipSync(
    Buffer.from(`turbo-acl-canary ${hash}: read-only ACL probe, not a turbo artifact\n`),
  );
}

/** Один запрос с повтором на сбой сети, таймаут и 5xx; ответы 4xx не повторяются. */
async function probe(params: {
  fetchImpl: FetchLike;
  method: 'GET' | 'PUT';
  url: string;
  headers: Record<string, string>;
  body?: Buffer;
  timeoutMs: number;
  retryDelayMs: number;
}): Promise<ProbeOutcome> {
  let status: number | null = null;
  let body = '';
  let reason = '';
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, params.retryDelayMs);
      });
    }
    try {
      const response = await params.fetchImpl(params.url, {
        method: params.method,
        headers: params.headers,
        ...(params.body === undefined ? {} : { body: params.body }),
        signal: AbortSignal.timeout(params.timeoutMs),
        cache: 'no-store',
      });
      status = response.status;
      body = clip(await response.text());
      reason = `HTTP ${status}`;
      if (response.status < 500) {
        return { ok: true, response: { status, body } };
      }
    } catch (error) {
      status = null;
      body = '';
      reason = describeError(error);
    }
  }
  return { ok: false, status, reason, body, attempts: ATTEMPTS };
}

function unreachable(step: string, outcome: Extract<ProbeOutcome, { ok: false }>): string {
  const excerpt = outcome.body === '' ? '' : ` Тело: ${outcome.body}`;
  return (
    `Remote-кэш недоступен или ошибается: ${step} → ${outcome.status ?? 'нет ответа'} — ` +
    `${outcome.reason} (попыток ${outcome.attempts}).${excerpt} Read-only ACL не проверен.`
  );
}

export async function checkTurboAcl(options: TurboAclOptions = {}): Promise<TurboAclResult> {
  const env: Readonly<Record<string, string | undefined>> = options.env ?? { ...process.env };
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  const token = env['TURBO_TOKEN']?.trim() ?? '';
  const team = env['TURBO_TEAM']?.trim() ?? '';
  const api = env['TURBO_API']?.trim() ?? '';
  const missing = [
    ['TURBO_API', api],
    ['TURBO_TEAM', team],
  ]
    .filter(([, value]) => value === '')
    .map(([name]) => name);

  const lines: TurboAclLine[] = [];
  // Всё, что пришло извне (тело ответа, текст ошибки), маскируется токеном.
  const mask = (text: string): string => (token === '' ? text : text.replaceAll(token, '***'));
  const say = (text: string): void => {
    lines.push({ level: 'info', text: mask(text) });
  };
  const fail = (verdict: 'write' | 'unknown', text: string): TurboAclResult => {
    lines.push({ level: 'error', text: mask(text) });
    return { verdict, exitCode: verdict === 'write' ? 1 : 2, lines };
  };

  if (token === '') {
    return {
      verdict: 'skipped',
      exitCode: 0,
      lines: [
        {
          level: 'warning',
          text:
            'TURBO_TOKEN не заведён (environment cache-read пуст) — read-only ACL turbo-кэша нечего проверять. ' +
            'Канарейка заработает с первым токеном: здесь появится вердикт, а не это предупреждение.',
        },
      ],
    };
  }
  if (missing.length > 0) {
    return fail(
      'unknown',
      `TURBO_TOKEN заведён, но не заданы ${missing.join(', ')} — проверить read-only ACL нечем: ` +
        'turbo включает remote-кэш только при всех трёх переменных.',
    );
  }
  let url: URL;
  try {
    url = new URL(api);
  } catch {
    return fail('unknown', `TURBO_API не похож на URL: ${api}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return fail(
      'unknown',
      `TURBO_API с протоколом ${url.protocol} — канарейка умеет только http и https.`,
    );
  }

  // Хеш случайный: у настоящего артефакта turbo такой не встретится, а read-проба
  // всегда должна давать 404 — иначе (200) хеш кто-то уже записал.
  const hash = options.hash ?? randomBytes(32).toString('hex');
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${ARTIFACT_ENDPOINT}/${hash}`;
  url.search = `?teamId=${encodeURIComponent(team)}`;
  const request = (method: 'GET' | 'PUT', headers: Record<string, string> = {}, body?: Buffer) =>
    probe({
      fetchImpl,
      method,
      url: url.toString(),
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'turbo-acl-canary', ...headers },
      ...(body === undefined ? {} : { body }),
      timeoutMs,
      retryDelayMs,
    });

  const read = await request('GET');
  if (!read.ok) {
    return fail('unknown', unreachable('GET', read));
  }
  const { status, body } = read.response;
  if (isDenied(status)) {
    return fail(
      'unknown',
      `Токен cache-read не читает: GET → ${status}. Remote-кэш для PR-джобов не работает, ` +
        `ACL записи не проверен.${body === '' ? '' : ` Тело: ${body}`}`,
    );
  }
  if (status !== 404) {
    return fail(
      'unknown',
      `Неожиданный ответ на чтение: GET → ${status}, ожидался 404 на случайный хеш.` +
        (body === '' ? '' : ` Тело: ${body}`),
    );
  }
  say(
    `чтение: GET ${ARTIFACT_ENDPOINT}/${hash.slice(0, 12)}… → 404 — токен cache-read принят, артефакта нет.`,
  );

  const write = await request(
    'PUT',
    { 'Content-Type': 'application/octet-stream' },
    artifactBody(hash),
  );
  if (!write.ok) {
    return fail('unknown', unreachable('PUT', write));
  }
  const writeStatus = write.response.status;
  const writeBody = write.response.body === '' ? '' : ` Тело: ${write.response.body}`;
  if (isAccepted(writeStatus)) {
    return fail(
      'write',
      `Токен cache-read ЗАПИСАЛ артефакт: PUT → ${writeStatus}. Серверная гарантия read-only не действует — ` +
        'код PR с этим токеном может писать в remote-кэш (ADR 0017, правило 2). ' +
        'Отзови токен в environment cache-read и заведи read-only.',
    );
  }
  if (!isDenied(writeStatus)) {
    return fail(
      'unknown',
      `Неожиданный ответ на запись: PUT → ${writeStatus} — неясно, пишет ли токен cache-read ` +
        `(отказом засчитываются только 401 и 403).${writeBody}`,
    );
  }
  say(`запись: PUT → ${writeStatus} — отклонена.${writeBody}`);
  say(
    'read-only подтверждён: токен cache-read читает remote-кэш и не пишет в него (ADR 0017, правило 2).',
  );
  return { verdict: 'read-only', exitCode: 0, lines };
}

/** Инфо — plain text, предупреждение и ошибка — команды workflow GitHub. */
export function formatTurboAclLines(lines: readonly TurboAclLine[]): string {
  return lines
    .map((entry) => (entry.level === 'info' ? entry.text : `::${entry.level}::${entry.text}`))
    .join('\n');
}

async function main(): Promise<void> {
  let result: TurboAclResult;
  try {
    result = await checkTurboAcl();
  } catch (error) {
    console.error(`turbo-acl: внутренняя ошибка канарейки: ${describeError(error)}`);
    process.exitCode = 2;
    return;
  }
  console.log(formatTurboAclLines(result.lines));
  process.exitCode = result.exitCode;
}

const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].endsWith('check-turbo-acl.ts');
if (invokedDirectly) {
  void main();
}
