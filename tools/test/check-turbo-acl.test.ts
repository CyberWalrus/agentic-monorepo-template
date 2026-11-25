/**
 * Канарейка и тесты e27 — read-only ACL токена turbo-кэша (ADR 0017, правило 2).
 *
 * Логика чекера гоняется на локальном стабе remote-кэша (`node:http`, тот же
 * процесс, что и запросы): read-only токен — зелёный; пишущий — красный, exit 1;
 * «проверить не удалось» — exit 2 (конфиг неполный, токен не читает, сервер
 * недоступен, неожиданный ответ). Отдельно закреплены форма запроса как у turbo
 * (метод, путь `/v8/artifacts/<hash>`, `teamId`, `Bearer`), отсутствие токена в
 * выводе, CLI без сети, проводка (токен канарейки — из environment cache-read;
 * каждый job ci.yml с TURBO_TOKEN объявляет environment), замыкание гейта
 * (deny, KNOWN_GATES, denyWrite) и ссылки в ADR 0017 и architecture.md.
 *
 * CLI гоняется spawned-процессом только на путях без сети: сетевые сценарии
 * покрыты вызовом checkTurboAcl в том же процессе, что и стаб, — тесту не нужен
 * обмен между процессами по loopback.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';

import { checkTurboAcl, formatTurboAclLines } from '../check-turbo-acl.ts';

const repoDir = resolve(import.meta.dirname, '..', '..');
const tool = join(repoDir, 'tools', 'check-turbo-acl.ts');

const TOKEN = 'probe-secret-token';
const HASH = 'ab'.repeat(32);

// --- Стаб remote-кэша -----------------------------------------------------------

type StubMode =
  | 'read-only'
  | 'write'
  | 'dead-token'
  | 'no-read'
  | 'write-500'
  | 'exists'
  | 'flaky'
  | 'echo';

interface SeenRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: string;
}

interface Stub {
  api: string;
  requests: SeenRequest[];
}

const servers: ReturnType<typeof createServer>[] = [];

function respond(mode: StubMode, write: boolean, served: number): number {
  if (mode === 'flaky' && served === 1) {
    // Первый запрос любого прогона — 503, дальше исправный read-only.
    return 503;
  }
  if (mode === 'dead-token') {
    return 401;
  }
  if (mode === 'no-read' || mode === 'exists') {
    return mode === 'no-read' ? 403 : 200;
  }
  if (mode === 'write-500') {
    return write ? 500 : 404;
  }
  if (mode === 'write') {
    return write ? 200 : 404;
  }
  // read-only, flaky (после первого запроса), echo.
  return write ? 403 : 404;
}

async function startStub(mode: StubMode): Promise<Stub> {
  const requests: SeenRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      requests.push({
        method: request.method ?? '',
        url: request.url ?? '',
        authorization: request.headers.authorization,
        contentType: request.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf8'),
      });
      const write = request.method === 'PUT';
      response.statusCode = respond(mode, write, requests.length);
      // echo: сервер возвращает то, что ему прислали в Authorization, — так
      // проверяется, что тело ответа с токеном не уходит в вывод как есть.
      response.end(
        mode === 'echo' && write
          ? `rejected ${request.headers.authorization ?? ''}`
          : `stub ${mode}`,
      );
    });
  });
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      done();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('стаб не слушает порт');
  }
  servers.push(server);
  return { api: `http://127.0.0.1:${address.port}`, requests };
}

afterAll(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => {
            done();
          });
        }),
    ),
  );
});

// --- Разбор workflow -------------------------------------------------------------

interface JobBlock {
  id: string;
  body: string;
}

/** Job'ы workflow: блоки с ключом на отступе 2 после `jobs:`. */
function jobBlocks(workflow: string): JobBlock[] {
  const jobsAt = workflow.indexOf('\njobs:\n');
  if (jobsAt < 0) {
    return [];
  }
  const blocks: JobBlock[] = [];
  let current: JobBlock | null = null;
  for (const line of workflow.slice(jobsAt).split('\n')) {
    const match = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (match?.[1] !== undefined) {
      current = { id: match[1], body: '' };
      blocks.push(current);
    } else if (current !== null) {
      current.body += `${line}\n`;
    }
  }
  return blocks;
}

/** Тело job без комментариев, условий и пустых строк: сверяет два описания одной джобы. */
function normalizedJob(body: string): string {
  return body
    .split('\n')
    .filter((line) => line.trim() !== '' && !/^\s*(#|if:)/.test(line))
    .join('\n');
}

function objectFile(path: string): Record<string, unknown> {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${path} не объект`);
  }
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    record[key] = value;
  }
  return record;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

const textOf = (result: { lines: Array<{ text: string }> }): string =>
  result.lines.map((entry) => entry.text).join('\n');

// --- Вердикты ---------------------------------------------------------------------------

it('секрета нет — skipped, exit 0, предупреждение вместо проверки, сеть не трогается', async () => {
  let calls = 0;
  const result = await checkTurboAcl({
    env: { TURBO_TOKEN: '', TURBO_TEAM: 'team', TURBO_API: 'http://127.0.0.1:9' },
    fetchImpl: async () => {
      calls += 1;
      return new Response('x');
    },
  });
  expect(result.verdict).toBe('skipped');
  expect(result.exitCode).toBe(0);
  expect(result.lines).toHaveLength(1);
  expect(result.lines[0]?.level).toBe('warning');
  expect(result.lines[0]?.text).toContain('TURBO_TOKEN');
  expect(calls).toBe(0);
});

it('токен заведён без TURBO_API или TURBO_TEAM — unknown, exit 2, сеть не трогается', async () => {
  let calls = 0;
  const fetchImpl = async (): Promise<Response> => {
    calls += 1;
    return new Response('x');
  };
  const noApi = await checkTurboAcl({
    env: { TURBO_TOKEN: TOKEN, TURBO_TEAM: 'team' },
    fetchImpl,
  });
  const noTeam = await checkTurboAcl({
    env: { TURBO_TOKEN: TOKEN, TURBO_API: 'http://127.0.0.1:9' },
    fetchImpl,
  });
  for (const result of [noApi, noTeam]) {
    expect(result.verdict).toBe('unknown');
    expect(result.exitCode).toBe(2);
    expect(result.lines[0]?.level).toBe('error');
  }
  expect(noApi.lines[0]?.text).toContain('TURBO_API');
  expect(noTeam.lines[0]?.text).toContain('TURBO_TEAM');
  expect(calls).toBe(0);
});

it('read-only токен: чтение 404, запись отклонена 403 — зелёный', async () => {
  const stub = await startStub('read-only');
  const result = await checkTurboAcl({
    env: { TURBO_TOKEN: TOKEN, TURBO_TEAM: 'probe-team', TURBO_API: stub.api },
    hash: HASH,
    retryDelayMs: 0,
  });
  expect(result.verdict).toBe('read-only');
  expect(result.exitCode).toBe(0);
  expect(result.lines.some((line) => line.level === 'error')).toBe(false);
  expect(textOf(result)).toContain('404');
  expect(textOf(result)).toContain('403');
  expect(stub.requests.map((request) => request.method)).toEqual(['GET', 'PUT']);
});

it('фикстурный пишущий токен: PUT принят (2xx) — красный, exit 1', async () => {
  const stub = await startStub('write');
  const result = await checkTurboAcl({
    env: { TURBO_TOKEN: TOKEN, TURBO_TEAM: 'probe-team', TURBO_API: stub.api },
    hash: HASH,
    retryDelayMs: 0,
  });
  expect(result.verdict).toBe('write');
  expect(result.exitCode).toBe(1);
  expect(result.lines.at(-1)?.level).toBe('error');
  expect(result.lines.at(-1)?.text).toContain('200');
  expect(result.lines.at(-1)?.text).toContain('cache-read');
});

it('форма запроса как у turbo: /v8/artifacts/<hash>?teamId=…, Authorization: Bearer, октеты в теле', async () => {
  const stub = await startStub('read-only');
  await checkTurboAcl({
    env: { TURBO_TOKEN: TOKEN, TURBO_TEAM: 'probe team', TURBO_API: `${stub.api}/` },
    hash: HASH,
    retryDelayMs: 0,
  });
  const [read, write] = stub.requests;
  const path = `/v8/artifacts/${HASH}?teamId=probe%20team`;
  expect(read?.method).toBe('GET');
  expect(read?.url).toBe(path);
  expect(read?.authorization).toBe(`Bearer ${TOKEN}`);
  expect(write?.method).toBe('PUT');
  expect(write?.url).toBe(path);
  expect(write?.authorization).toBe(`Bearer ${TOKEN}`);
  expect(write?.contentType).toBe('application/octet-stream');
  // Тело — заглушка артефакта (октеты, не текст с токеном), не пустое.
  expect(write?.body).not.toContain(TOKEN);
  expect(write?.body.length).toBeGreaterThan(0);
});

it.each([
  ['401', 'dead-token'],
  ['403', 'no-read'],
] as const)(
  'токен не читает (%s на GET) — unknown, exit 2, запись не пробуется',
  async (status, mode) => {
    const stub = await startStub(mode);
    const result = await checkTurboAcl({
      env: { TURBO_TOKEN: TOKEN, TURBO_TEAM: 'team', TURBO_API: stub.api },
      hash: HASH,
      retryDelayMs: 0,
    });
    expect(result.verdict).toBe('unknown');
    expect(result.exitCode).toBe(2);
    expect(textOf(result)).toContain(status);
    expect(textOf(result)).toContain('не читает');
    expect(stub.requests.map((request) => request.method)).toEqual(['GET']);
  },
);

it('сервер ошибается на запись (500) — один повтор, затем unknown, exit 2: неясно, пишет ли токен', async () => {
  const stub = await startStub('write-500');
  const result = await checkTurboAcl({
    env: { TURBO_TOKEN: TOKEN, TURBO_TEAM: 'team', TURBO_API: stub.api },
    hash: HASH,
    retryDelayMs: 0,
  });
  expect(result.verdict).toBe('unknown');
  expect(result.exitCode).toBe(2);
  expect(textOf(result)).toContain('500');
  expect(stub.requests.map((request) => request.method)).toEqual(['GET', 'PUT', 'PUT']);
});

it('разовый сбой (503) — повтор спасает: read-only, зелёный', async () => {
  const stub = await startStub('flaky');
  const result = await checkTurboAcl({
    env: { TURBO_TOKEN: TOKEN, TURBO_TEAM: 'team', TURBO_API: stub.api },
    hash: HASH,
    retryDelayMs: 0,
  });
  expect(result.verdict).toBe('read-only');
  expect(result.exitCode).toBe(0);
  expect(stub.requests.map((request) => request.method)).toEqual(['GET', 'GET', 'PUT']);
});

it('сервер недоступен — unknown, exit 2, с причиной и без токена в выводе', async () => {
  const result = await checkTurboAcl({
    env: { TURBO_TOKEN: TOKEN, TURBO_TEAM: 'team', TURBO_API: 'http://127.0.0.1:9' },
    hash: HASH,
    retryDelayMs: 0,
    fetchImpl: async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    },
  });
  expect(result.verdict).toBe('unknown');
  expect(result.exitCode).toBe(2);
  expect(textOf(result)).toContain('ECONNREFUSED');
  expect(textOf(result)).not.toContain(TOKEN);
});

it('таймаут запроса — unknown, exit 2 (висящий сервер не вешает канарейку)', async () => {
  const result = await checkTurboAcl({
    env: { TURBO_TOKEN: TOKEN, TURBO_TEAM: 'team', TURBO_API: 'http://127.0.0.1:9' },
    hash: HASH,
    timeoutMs: 20,
    retryDelayMs: 0,
    fetchImpl: (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason);
        });
      }),
  });
  expect(result.verdict).toBe('unknown');
  expect(result.exitCode).toBe(2);
  expect(textOf(result)).toContain('TimeoutError');
});

it('случайный хеш уже есть в кэше (GET 200) — unknown, exit 2, запись не пробуется', async () => {
  const stub = await startStub('exists');
  const result = await checkTurboAcl({
    env: { TURBO_TOKEN: TOKEN, TURBO_TEAM: 'team', TURBO_API: stub.api },
    hash: HASH,
    retryDelayMs: 0,
  });
  expect(result.verdict).toBe('unknown');
  expect(result.exitCode).toBe(2);
  expect(stub.requests.map((request) => request.method)).toEqual(['GET']);
});

it('токен не попадает в вывод, даже если сервер возвращает его в теле ответа', async () => {
  const stub = await startStub('echo');
  const result = await checkTurboAcl({
    env: { TURBO_TOKEN: TOKEN, TURBO_TEAM: 'team', TURBO_API: stub.api },
    hash: HASH,
    retryDelayMs: 0,
  });
  expect(result.verdict).toBe('read-only');
  expect(stub.requests[1]?.body).not.toContain(TOKEN);
  expect(textOf(result)).not.toContain(TOKEN);
  expect(textOf(result)).toContain('***');
});

it('формат вывода: предупреждение и ошибка — команды workflow, инфо — plain text', async () => {
  const skipped = await checkTurboAcl({ env: {} });
  const broken = await checkTurboAcl({ env: { TURBO_TOKEN: TOKEN } });
  const ok = await checkTurboAcl({
    env: { TURBO_TOKEN: TOKEN, TURBO_TEAM: 'team', TURBO_API: 'http://127.0.0.1:9' },
    fetchImpl: async (_url, init) =>
      new Response('x', { status: init.method === 'PUT' ? 403 : 404 }),
  });
  expect(ok.verdict).toBe('read-only');
  expect(formatTurboAclLines(skipped.lines)).toMatch(/^::warning::.*\n?$/);
  expect(formatTurboAclLines(broken.lines)).toMatch(/^::error::.*\n?$/);
  expect(formatTurboAclLines(ok.lines)).not.toContain('::');
  expect(formatTurboAclLines(ok.lines)).toContain('read-only');
});

// --- CLI без сети ----------------------------------------------------------------------

function runCli(env: Record<string, string>): { status: number | null; output: string } {
  const run = spawnSync(process.execPath, [tool], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { PATH: process.env['PATH'] ?? '', ...env },
  });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

it('CLI: секрета нет — exit 0 и ::warning::', () => {
  const run = runCli({});
  expect(run.status).toBe(0);
  expect(run.output).toMatch(/^::warning::.*TURBO_TOKEN.*$/m);
});

it('CLI: токен без API — exit 2 и ::error::', () => {
  const run = runCli({ TURBO_TOKEN: 'probe-secret-token', TURBO_TEAM: 'team' });
  expect(run.status).toBe(2);
  expect(run.output).toMatch(/^::error::.*TURBO_API.*$/m);
  expect(run.output).not.toContain('probe-secret-token');
});

// --- Проводка ------------------------------------------------------------------------------

it('проводка: job turbo-acl в canaries.yml берёт токен из environment cache-read', () => {
  const canaries = readFileSync(join(repoDir, '.github', 'workflows', 'canaries.yml'), 'utf8');
  const job = jobBlocks(canaries).find((entry) => entry.id === 'turbo-acl');
  expect(job).toBeDefined();
  expect(job?.body).toContain('\n    environment: cache-read\n');
  expect(job?.body).toContain('TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}\n');
  expect(job?.body).toContain('TURBO_TEAM: ${{ vars.TURBO_TEAM }}\n');
  expect(job?.body).toContain('TURBO_API: ${{ vars.TURBO_API }}\n');
  expect(job?.body).toContain('run: node tools/check-turbo-acl.ts\n');
  // На PR вердикту не доверяют: проверку исполнял бы сам код PR — job пропущен,
  // токен PR-коду лишний раз не выдаётся.
  expect(job?.body).toContain("if: ${{ github.event_name != 'pull_request' }}");
});

it('проводка: всюду, где workflow зовёт чекер, токен — из cache-read, никогда из cache-write', () => {
  const wfDir = join(repoDir, '.github', 'workflows');
  const hosts: string[] = [];
  for (const name of readdirSync(wfDir).toSorted()) {
    for (const job of jobBlocks(readFileSync(join(wfDir, name), 'utf8'))) {
      if (!job.body.includes('node tools/check-turbo-acl.ts')) {
        continue;
      }
      hosts.push(`${name}:${job.id}`);
      expect(job.body).toContain('\n    environment: cache-read\n');
      expect(job.body).not.toContain('cache-write');
    }
  }
  // Два хоста: push в main и ручной прогон (canaries.yml) и расписание
  // (nightly.yml) — без ночного канарейка не периодическая.
  expect(hosts).toEqual(['canaries.yml:turbo-acl', 'nightly.yml:turbo-acl']);
});

it('проводка: ночной прогон — job turbo-acl в nightly.yml безусловный и в needs у report failure', () => {
  const wfDir = join(repoDir, '.github', 'workflows');
  const nightly = readFileSync(join(wfDir, 'nightly.yml'), 'utf8');
  // Расписание — сам смысл ночного хоста.
  expect(nightly.slice(0, nightly.indexOf('\njobs:\n'))).toMatch(/\n {2}schedule:\n {4}- cron: /);
  const jobs = jobBlocks(nightly);
  const job = jobs.find((entry) => entry.id === 'turbo-acl');
  expect(job).toBeDefined();
  expect(job?.body).toContain('run: node tools/check-turbo-acl.ts\n');
  expect(job?.body).not.toMatch(/\n {4}if:/);
  // Красный ночной прогон обязан завести issue: вне job report он молчал бы
  // до следующего взгляда человека (тот же класс, что закрыл e26).
  const report = jobs.find((entry) => entry.id === 'report');
  expect(report?.body).toContain('gh issue create');
  expect(report?.body).toMatch(/\n {4}needs:[\s\S]*\n {8}turbo-acl,\n/);
  // Та же джоба, что в canaries.yml, минус пропуск PR и комментарии: два
  // описания не разъезжаются (environment, переменные, шаги).
  const canaries = readFileSync(join(wfDir, 'canaries.yml'), 'utf8');
  const canaryJob = jobBlocks(canaries).find((entry) => entry.id === 'turbo-acl');
  expect(normalizedJob(job?.body ?? '')).toBe(normalizedJob(canaryJob?.body ?? ''));
});

it('ci.yml: каждый job с TURBO_TOKEN берёт его из environment, вне push — cache-read', () => {
  const ci = readFileSync(join(repoDir, '.github', 'workflows', 'ci.yml'), 'utf8');
  const jobsAt = ci.indexOf('\njobs:\n');
  expect(jobsAt).toBeGreaterThan(0);
  // Repo-секрет наследовали бы все job без environment — механизм замолчал бы.
  expect(ci.slice(0, jobsAt)).not.toMatch(/^\s+TURBO_TOKEN:/m);
  const tokenLine = /^\s+TURBO_TOKEN: \$\{\{ secrets\.TURBO_TOKEN \}\}$/m;
  const jobs = jobBlocks(ci).filter((job) => tokenLine.test(job.body));
  expect(jobs.map((job) => job.id)).toEqual([
    'static',
    'unit',
    'mutation',
    'e2e',
    'visual',
    'perf',
    'bundle-delta',
  ]);
  for (const job of jobs) {
    const environment = /\n {4}environment: (.+)\n/.exec(job.body)?.[1]?.trim();
    expect(environment).toBeDefined();
    const readOnlyOutsidePush =
      environment === 'cache-read' ||
      environment === "${{ github.event_name == 'push' && 'cache-write' || 'cache-read' }}";
    expect(readOnlyOutsidePush).toBe(true);
  }
});

// --- Замыкание гейта и документация ----------------------------------------------------

it('замыкание: чекер в deny, в KNOWN_GATES и в denyWrite (ADR 0014)', () => {
  const deny = strings(objectFile(join(repoDir, 'tools', 'protected-paths.json'))['deny']);
  expect(deny).toContain('tools/check-turbo-acl.ts');
  expect(readFileSync(join(repoDir, 'tools', 'check-tool-class.ts'), 'utf8')).toContain(
    "'tools/check-turbo-acl.ts'",
  );
  expect(readFileSync(join(repoDir, '.claude', 'settings.json'), 'utf8')).toContain(
    '"tools/check-turbo-acl.ts"',
  );
});

it('ADR 0017 и architecture.md (A7) ссылаются на канарейку', () => {
  for (const doc of ['docs/adr/0017-remote-cache-trust.md', 'docs/architecture.md']) {
    expect(readFileSync(join(repoDir, doc), 'utf8')).toContain('check-turbo-acl.ts');
  }
});
