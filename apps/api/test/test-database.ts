import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { getContainerRuntimeClient } from 'testcontainers';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Client } from 'pg';

import { connectTaskDatabase } from '../src/tasks/database.ts';

// Ryuk-реапер testcontainers гасит контейнер через ~10 c после закрытия
// сокетов создавшего процесса — последователь, подключённый обычным
// pg-клиентом, остался бы без базы под живыми тестами (rev c1.4). Поэтому
// контейнером распоряжается только этот хелпер: остановка — по refcount.
// Утечка при принудительном убийстве воркера переиспользуется или заменяется
// следующим прогоном; полная чистка — `docker rm -f agentic-pg-test-…`
// (docs/test-database-isolation.md).
process.env['TESTCONTAINERS_RYUK_DISABLED'] = 'true';

// Таймауты холодного старта — на уровне вызывающего файла (beforeAll 120 c,
// как в C1.2): **/vitest.config.ts защищён. Ожидание лока — меньше файлового,
// чтобы воркер-последователь не умер от собственного таймаута раньше объяснения.
const CONTAINER_START_TIMEOUT_MS = 120_000;
const LOCK_WAIT_TIMEOUT_MS = 115_000;
const LOCK_POLL_MS = 250;
// holder.json появляется сразу после mkdir лока; дольше — держатель умер в створе.
const HOLDER_GRACE_MS = 5_000;
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Закреплённый по digest образ Postgres для integration-тестов (решение c1.2:
 * прогон воспроизводим, порт случайный — два worktree не пересекаются, З9).
 */
export const POSTGRES_TEST_IMAGE =
  'postgres:17-alpine@sha256:d3244e8ce3f165ee3c93d9c4a4b1d0fe48b3a89e2287b717fdcbbde92d405065';

export interface PostgresTestDatabaseOptions {
  /** Образ контейнера; закрепляй по digest для воспроизводимости прогона. */
  image: string;
  /** Каталог миграций модуля: участвует в fingerprint шаблона и ключе экземпляра. */
  migrationsFolder: string;
  /**
   * Применение миграций к базе-шаблону (для drizzle — migrateTaskDatabase).
   * Личность функции входит в ключ экземпляра: файлы с разными контрактами
   * миграции получают разные контейнеры и не оспаривают содержимое шаблона.
   */
  migrate: (db: NodePgDatabase) => Promise<void>;
  /**
   * Каталог координации воркеров. По умолчанию tmpdir с ключом пути репозитория
   * (два worktree не пересекаются, З9). Тесты самого хелпера инъектируют свой
   * каталог, чтобы не влиять на общий контейнер прогона.
   */
  coordinationDir?: string;
}

/**
 * Ключ экземпляра координации: образ + каталог миграций + личность migrate.
 * Личность migrate обязательна в ключе: файлы с одинаковыми образом и папкой,
 * но разными контрактами миграции делили один контейнер, и содержимое шаблона
 * определялось тем, кто первым взял лок координации (c1.7: заглушка
 * task-pool опустошала общий шаблон → клонировавшие её postgres-тесты падали
 * 42P01 волной, копийные канарейки стояли красными). Теперь разные migrate —
 * разные контейнеры, коллизия контрактов невозможна по построению. Файлы
 * состояния — `instance-<key>.json` и `lock-<key>` в каталоге координации.
 * Экспортирован для тестов самого хелпера: они моделируют состояния
 * координации (мёртвый лок, протухший fingerprint) по этому контракту.
 */
export function postgresTestInstanceKey(
  options: Pick<PostgresTestDatabaseOptions, 'image' | 'migrationsFolder' | 'migrate'>,
): string {
  return sha256(
    `${options.image}\n${resolve(options.migrationsFolder)}\n${String(options.migrate)}`,
  ).slice(0, 12);
}

/**
 * Имя контейнера экземпляра: каталог координации + ключ. Инъектированный
 * каталог тестов хелпера даёт своё имя — общий контейнер прогона не задевается.
 * Экспортирован по той же причине, что и ключ.
 */
export function postgresTestContainerName(
  coordinationDir: string,
  options: Pick<PostgresTestDatabaseOptions, 'image' | 'migrationsFolder' | 'migrate'>,
): string {
  const instanceKey = postgresTestInstanceKey(options);
  return `agentic-pg-test-${sha256(`${coordinationDir}\n${instanceKey}`).slice(0, 12)}`;
}

export interface PostgresTestDatabase {
  /** Drizzle поверх пула подключений своей базы. */
  db: NodePgDatabase;
  /** Имя базы воркера: уникально в контейнере, полезно в сообщениях тестов. */
  databaseName: string;
  /**
   * Строка подключения к этой базе: тестам, вызывающим код по URI, а не через
   * готовый drizzle (c1.6: миграции под advisory-локом открывают своё
   * соединение по строке подключения).
   */
  connectionString: string;
  /**
   * Удаляет базу воркера и снимает ссылку на контейнер. Последний
   * закрывший останавливает контейнер; его базу-шаблон не трогает.
   * Базу из `createEmptyDatabase` закрывать раньше родительской: refcount
   * у неё общий с родителем, и закрытие родителя может остановить контейнер.
   */
  close(): Promise<void>;
  /**
   * Пустая база (без схемы, не из шаблона) в том же контейнере: сценарии
   * «поднялся с нуля» (c1.6: гонка миграций против пустой базы). Живёт
   * за счёт refcount родителя — закрыть её раньше родительской `close()`.
   */
  createEmptyDatabase(): Promise<Omit<PostgresTestDatabase, 'createEmptyDatabase'>>;
}

interface InstanceState {
  /** Строка подключения к дефолтной базе контейнера. */
  uri: string;
  containerId: string;
  fingerprint: string;
  templateName: string;
  /** Сколько живых баз воркеров держит контейнер. */
  refcount: number;
}

/** Валидация вместо `as`: файл состояния мог обраться на полуслове — или быть подменён. */
function isInstanceState(value: unknown): value is InstanceState {
  return (
    typeof value === 'object' &&
    value !== null &&
    'uri' in value &&
    typeof value['uri'] === 'string' &&
    isLocalPostgresUri(value['uri']) &&
    'containerId' in value &&
    typeof value['containerId'] === 'string' &&
    DOCKER_ID_PATTERN.test(value['containerId']) &&
    'fingerprint' in value &&
    typeof value['fingerprint'] === 'string' &&
    'templateName' in value &&
    typeof value['templateName'] === 'string' &&
    TEMPLATE_NAME_PATTERN.test(value['templateName']) &&
    'refcount' in value &&
    typeof value['refcount'] === 'number' &&
    Number.isInteger(value['refcount']) &&
    value['refcount'] >= 1
  );
}

// Корень репозитория: apps/api/test/test-database.ts → на три уровня вверх
// от каталога файла. Ключ каталога координации: два worktree не пересекаются (З9).
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

// Права каталога координации и state-файлов: только владелец прогона (rev
// security c1.4: файлы живут в tmpdir, uri и refcount не должны читаться и
// тем более подменяться другими пользователями общего хоста).
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const DOCKER_ID_PATTERN = /^[0-9a-f]{64}$/;
const TEMPLATE_NAME_PATTERN = /^template_[0-9a-f]{12}$/;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** URI state-файла обязан вести в контейнер на той же машине — не в чужой мир. */
function isLocalPostgresUri(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'postgres:' &&
      ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

/**
 * Запись с эксклюзивным созданием ('wx'): предсозданный симлинк на пути
 * записи не затирает чужой файл, а приводит к новому суффиксу (rev security
 * c1.4). Финальная подмена — renameSync, он симлинк заменяет, а не следует ему.
 */
function writePrivateFile(path: string, data: string): void {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const target = attempt === 0 ? path : `${path}.${randomBytes(3).toString('hex')}`;
    let fd: number;
    try {
      fd = openSync(target, 'wx', FILE_MODE);
    } catch (error) {
      const retryable = error instanceof Error && 'code' in error && error.code === 'EEXIST';
      if (!retryable) {
        throw error;
      }
      continue;
    }
    try {
      writeSync(fd, data);
    } finally {
      closeSync(fd);
    }
    if (target !== path) {
      renameSync(target, path);
    }
    return;
  }
  throw new Error(`Не удалось записать ${path}: все суффиксы имени заняты.`);
}

/** hash(образ + содержимое migrations/**): смена миграций — новый контейнер, шаблон не протухает. */
function migrationsFingerprint(image: string, migrationsFolder: string): string {
  const entries: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).toSorted()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full, `${prefix}${name}/`);
      } else {
        entries.push(`${prefix}${name}:${sha256(readFileSync(full, 'utf8'))}`);
      }
    }
  };
  walk(migrationsFolder, '');
  return sha256(`${image}\n${entries.join('\n')}`).slice(0, 16);
}

/** Уникальная база воркера: pid + случайный суффикс, пересечений между воркерами нет. */
function workerDatabaseName(): string {
  return `w_${process.pid}_${randomBytes(3).toString('hex')}`;
}

/** Пустая база в контейнере (для сценариев «с нуля»): тот же pid + случайный суффикс. */
function emptyDatabaseName(): string {
  return `e_${process.pid}_${randomBytes(3).toString('hex')}`;
}

function adminUriFor(uri: string, database: string): string {
  const url = new URL(uri);
  url.pathname = `/${database}`;
  return url.toString();
}

async function withAdminClient<T>(uri: string, run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({
    connectionString: adminUriFor(uri, 'postgres'),
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

/** Жив ли контейнер: короткое подключение с SELECT 1. */
async function isReachable(uri: string): Promise<boolean> {
  try {
    await withAdminClient(uri, (client) => client.query('SELECT 1'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Убрать контейнер по id, сверив имя с ожидаемым: state-файл в каталоге
 * координации мог быть подменён — без сверки прогон удалил бы произвольный
 * контейнер общего демона (rev security c1.4). Контейнера нет — уже чисто.
 */
async function removeContainerById(containerId: string, expectedName: string): Promise<void> {
  try {
    const runtime = await getContainerRuntimeClient();
    const container = runtime.container.getById(containerId);
    const info = await container.inspect();
    const name = info.Name.startsWith('/') ? info.Name.slice(1) : info.Name;
    if (name !== expectedName) {
      return;
    }
    await container.remove({ force: true });
  } catch {
    // Контейнера нет (убран предыдущим прогоном) — цель достигнута.
  }
}

/** Мусорные контейнеры нашего имени без instance.json (снёсся tmpdir): убрать перед стартом. */
async function removeContainersByName(name: string): Promise<void> {
  try {
    const runtime = await getContainerRuntimeClient();
    const staleIds = (await runtime.container.list())
      .filter((info) => (info.Names ?? []).includes(`/${name}`))
      .map((info) => info.Id);
    await Promise.all(staleIds.map((id) => removeContainerById(id, name)));
  } catch {
    // Docker недоступен: старт ниже упадёт с внятным объяснением.
  }
}

/**
 * Изоляция integration-тестов на Postgres: один контейнер на прогон, миграции
 * один раз в базу-шаблон, каждый воркер получает свою базу через
 * `CREATE DATABASE … TEMPLATE` (решение c1.4). Воркер — тестовый файл:
 * vitest гоняет файлы параллельно, и чистка таблицы в одном воркере не
 * задевает соседа. Изоляцию на этом уровне даёт база — локи вроде
 * SHARED_DATA_LOCK здесь не нужны (лок — механика E2E, снимается в c1.5).
 *
 * Координация воркеров — mkdir-мьютекс + instance-файл в каталоге координации:
 * первый воркер стартует контейнер и мигрирует шаблон, остальные подключаются;
 * последний закрывший останавливает контейнер. Ключ экземпляра включает
 * личность migrate (см. postgresTestInstanceKey): разные контракты миграции
 * не делят контейнер. Ryuk отключён (см. выше).
 *
 * Фича копирует вызов со своими параметрами — см.
 * docs/test-database-isolation.md.
 */
export async function createPostgresTestDatabase(
  options: PostgresTestDatabaseOptions,
): Promise<PostgresTestDatabase> {
  const coordinationDir =
    options.coordinationDir ?? join(tmpdir(), `agentic-pg-${sha256(repoRoot).slice(0, 12)}`);
  const instanceKey = postgresTestInstanceKey(options);
  const instanceFile = join(coordinationDir, `instance-${instanceKey}.json`);
  const lockDir = join(coordinationDir, `lock-${instanceKey}`);
  // Имя включает каталог координации: инъектированный каталог тестов хелпера
  // получает свой контейнер и не задевает общий контейнер прогона.
  const containerName = postgresTestContainerName(coordinationDir, options);
  const fingerprint = migrationsFingerprint(options.image, options.migrationsFolder);

  const readState = (): InstanceState | undefined => {
    if (!existsSync(instanceFile)) {
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(instanceFile, 'utf8'));
      return isInstanceState(parsed) ? parsed : undefined; // оборванная запись: пересоздаём
    } catch {
      return undefined;
    }
  };

  const writeState = (state: InstanceState): void => {
    // Эксклюзивная запись + атомарная подмена: читатели не видят полуфайл,
    // предсозданный симлинк не затирает чужой файл (rev security c1.4).
    writePrivateFile(instanceFile, JSON.stringify(state));
  };

  const startSharedInstance = async (): Promise<InstanceState> => {
    await removeContainersByName(containerName);
    let container: StartedPostgreSqlContainer;
    try {
      container = await new PostgreSqlContainer(options.image)
        .withName(containerName)
        .withStartupTimeout(CONTAINER_START_TIMEOUT_MS)
        .start();
    } catch (error) {
      throw new Error(
        'Не удалось запустить контейнер Postgres: интеграционным тестам на Postgres нужен работающий Docker (образ тест поднимает сам). Запусти Docker и повтори.',
        { cause: error },
      );
    }
    const uri = container.getConnectionUri();
    const templateName = `template_${instanceKey}`;
    await withAdminClient(uri, (client) => client.query(`CREATE DATABASE "${templateName}"`));
    const template = await connectTaskDatabase(adminUriFor(uri, templateName));
    try {
      await options.migrate(template.db);
    } finally {
      // Клонирование TEMPLATE требует 0 подключений к шаблону.
      await template.close();
    }
    return { uri, containerId: container.getId(), fingerprint, templateName, refcount: 1 };
  };

  // Весь переход состояния экземпляра — под локом, включая refcount++:
  // два воркера одновременно не читают и не пишут instance-файл.
  const ensureSharedInstance = async (): Promise<InstanceState> => {
    const state = readState();
    if (
      state !== undefined &&
      state.fingerprint === fingerprint &&
      (await isReachable(state.uri))
    ) {
      state.refcount += 1;
      writeState(state);
      return state;
    }
    if (state !== undefined) {
      // Контейнер мёртв (docker перезапущен) или миграции сменились: заменить.
      await removeContainerById(state.containerId, containerName);
    }
    const fresh = await startSharedInstance();
    writeState(fresh);
    return fresh;
  };

  const releaseSharedInstance = async (): Promise<void> => {
    const state = readState();
    if (state === undefined) {
      return; // уже убран другим закрытием
    }
    state.refcount -= 1;
    if (state.refcount <= 0) {
      await removeContainerById(state.containerId, containerName);
      rmSync(instanceFile, { force: true });
    } else {
      writeState(state);
    }
  };

  /** Мёртвый держатель: PID-файла нет дольше грэйса или процесс держателя не существует. */
  const holderIsGone = (): boolean => {
    const holderFile = join(lockDir, 'holder.json');
    if (!existsSync(holderFile)) {
      // mkdir без holder.json дольше грэйса: держатель умер между mkdir и записью.
      try {
        const created = statSync(lockDir).ctimeMs;
        return Date.now() - created > HOLDER_GRACE_MS;
      } catch {
        return false; // лок уже сняли — опрос повторит mkdir
      }
    }
    let pid: number;
    try {
      const holder: unknown = JSON.parse(readFileSync(holderFile, 'utf8'));
      if (
        typeof holder !== 'object' ||
        holder === null ||
        !('pid' in holder) ||
        typeof holder.pid !== 'number' ||
        holder.pid < 1
      ) {
        return true; // кривой PID-файл — держатель не справился, лок считаем мёртвым
      }
      pid = holder.pid;
    } catch {
      return true; // нечитаемый holder.json — то же
    }
    try {
      process.kill(pid, 0); // ESRCH — процесса нет; EPERM — жив под другим пользователем
      return false;
    } catch (error) {
      return error instanceof Error && 'code' in error && error.code === 'ESRCH';
    }
  };

  // Каталог координации — приватный владельцу прогона: чужой пользователь
  // общего хоста не читает uri из state-файла и не подкладывает свои (rev
  // security c1.4). Каталог чужого владельца — ошибка с объяснением.
  const ensureCoordinationDir = (): void => {
    mkdirSync(coordinationDir, { recursive: true, mode: DIR_MODE });
    try {
      chmodSync(coordinationDir, DIR_MODE);
    } catch {
      throw new Error(
        `Каталог координации ${coordinationDir} принадлежит другому пользователю. Удали его (rm -rf) и повтори прогон.`,
      );
    }
  };

  // Опрос лока — setTimeout-рекурсией, а не await в цикле: опрос честно
  // серийный, но глотки event loop не блокируют соседние воркеры.
  const acquireLock = (): Promise<void> =>
    new Promise((resolveLock, rejectLock) => {
      ensureCoordinationDir();
      const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
      const attempt = (): void => {
        try {
          mkdirSync(lockDir, { mode: DIR_MODE });
        } catch {
          // Каталог занят: дождаться держателя либо сломать мёртвый лок (PID-файл).
          const stale = holderIsGone();
          if (stale) {
            rmSync(lockDir, { recursive: true, force: true });
          } else if (Date.now() > deadline) {
            rejectLock(
              new Error(
                `Не дождались лока координации за ${LOCK_WAIT_TIMEOUT_MS} мс (${lockDir}): держатель жив. Проверь, не идёт ли параллельный прогон того же worktree.`,
              ),
            );
            return;
          }
          setTimeout(attempt, LOCK_POLL_MS);
          return;
        }
        writePrivateFile(join(lockDir, 'holder.json'), JSON.stringify({ pid: process.pid }));
        resolveLock();
      };
      attempt();
    });

  const withLock = async <T>(run: () => Promise<T>): Promise<T> => {
    await acquireLock();
    try {
      return await run();
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
    }
  };

  const instance = await withLock(ensureSharedInstance);

  // Подключение к базе экземпляра + общий вид базы (без `createEmptyDatabase`:
  // он один на воркер). close() всегда удаляет базу; экземплярные хвосты
  // (refcount) — в `afterDrop`.
  const connectDatabase = async (
    databaseName: string,
    afterDrop: () => Promise<void>,
  ): Promise<Omit<PostgresTestDatabase, 'createEmptyDatabase'>> => {
    const connectionString = adminUriFor(instance.uri, databaseName);
    const database = await connectTaskDatabase(connectionString);
    return {
      db: database.db,
      databaseName,
      connectionString,
      close: async () => {
        await database.close();
        // WITH (FORCE): оборвать возможные остаточные подключения перед удалением.
        await withAdminClient(instance.uri, (client) =>
          client.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`),
        );
        await afterDrop();
      },
    };
  };

  const databaseName = workerDatabaseName();
  await withAdminClient(instance.uri, (client) =>
    client.query(`CREATE DATABASE "${databaseName}" TEMPLATE "${instance.templateName}"`),
  );
  const worker = await connectDatabase(databaseName, () => withLock(releaseSharedInstance));

  const createEmptyDatabase = async (): Promise<
    Omit<PostgresTestDatabase, 'createEmptyDatabase'>
  > => {
    const name = emptyDatabaseName();
    await withAdminClient(instance.uri, (client) => client.query(`CREATE DATABASE "${name}"`));
    return connectDatabase(name, async () => {});
  };

  return { ...worker, createEmptyDatabase };
}
