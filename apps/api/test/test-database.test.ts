import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { getContainerRuntimeClient } from 'testcontainers';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { migrateTaskDatabase, taskMigrationsFolder } from '../src/tasks/database.ts';
import * as schema from '../src/tasks/schema.ts';

import {
  createPostgresTestDatabase,
  POSTGRES_TEST_IMAGE,
  postgresTestContainerName,
  postgresTestInstanceKey,
  type PostgresTestDatabase,
} from './test-database.ts';

// Таймаут на уровне файла: **/vitest.config.ts защищён (как в C1.2).
const CONTAINER_TIMEOUT_MS = 120_000;

const options = {
  image: POSTGRES_TEST_IMAGE,
  migrationsFolder: taskMigrationsFolder,
  migrate: migrateTaskDatabase,
};

// Открытые базы на случай падения посреди теста: afterAll закрывает остатки,
// чтобы refcount не протёк и контейнеры остановились штатно.
const opened: PostgresTestDatabase[] = [];

async function create(coordinationDir?: string): Promise<PostgresTestDatabase> {
  const database = await createPostgresTestDatabase(
    coordinationDir === undefined ? options : { ...options, coordinationDir },
  );
  opened.push(database);
  return database;
}

async function shut(database: PostgresTestDatabase): Promise<void> {
  const index = opened.indexOf(database);
  if (index !== -1) {
    opened.splice(index, 1);
  }
  await database.close();
}

// Каталог жизненного цикла — инъектированный (pid-scoped): тесты lifecycle
// стартуют свой экземпляр и не трогают refcount общего контейнера прогона
// (rev sanity c1.4). afterAll сносит каталог вместе с остатками состояния.
const lifecycleDir = join(tmpdir(), `agentic-pg-selftest-${process.pid}`);

const instanceFileCount = (): number =>
  readdirSync(lifecycleDir).filter((name) => name.startsWith('instance-')).length;

afterAll(async () => {
  // Закрытия независимы (каждое — своя база и refcount--): параллельно.
  await Promise.all(opened.splice(0).map(shut));
  rmSync(lifecycleDir, { recursive: true, force: true });
});

describe('createPostgresTestDatabase', () => {
  it(
    'gives each worker an independent database from the shared template',
    async () => {
      const first = await create();
      const second = await create();

      // Имена баз различаются: изоляция структурная (база на воркер),
      // а не договорённость «чисти таблицу перед тестом».
      expect(second.databaseName).not.toBe(first.databaseName);

      await first.db.insert(schema.tasks).values({
        id: '10000000-0000-4000-8000-000000000001',
        title: 'in first',
        completed: false,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      await second.db.insert(schema.tasks).values({
        id: '10000000-0000-4000-8000-000000000002',
        title: 'in second',
        completed: false,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      // Обе базы из одного шаблона (схема миграций на месте), данные не пересекаются.
      expect((await first.db.select().from(schema.tasks)).map((task) => task.title)).toEqual([
        'in first',
      ]);
      expect((await second.db.select().from(schema.tasks)).map((task) => task.title)).toEqual([
        'in second',
      ]);

      await shut(first);
      await shut(second);
    },
    CONTAINER_TIMEOUT_MS,
  );

  it(
    'drops the worker database on close and stops the container when the last worker leaves',
    async () => {
      rmSync(lifecycleDir, { recursive: true, force: true }); // чистый старт экземпляра

      const first = await create(lifecycleDir);
      const second = await create(lifecycleDir);
      const disposable = await create(lifecycleDir);

      // Три воркера — один общий экземпляр контейнера.
      expect(instanceFileCount()).toBe(1);

      await shut(disposable);

      // pg_database глобален: закрытая база удалена из контейнера, а экземпляр
      // жив, пока есть хоть один воркер (refcount 2).
      const names = (await first.db.execute(sql`select datname from pg_database`)).rows.map((row) =>
        String(row['datname']),
      );
      expect(names).not.toContain(disposable.databaseName);
      expect(instanceFileCount()).toBe(1);

      await shut(first);
      await shut(second);

      // Последний ушедший останавливает контейнер: state экземпляра убран.
      expect(instanceFileCount()).toBe(0);

      // Остановка проверяется фактом, а не только по state-файлу: регрессия
      // в самом удалении (removeContainerById) красит тест (rev test-quality c1.4).
      const runtime = await getContainerRuntimeClient();
      const remaining = (await runtime.container.list()).filter((info) =>
        (info.Names ?? []).includes(`/${postgresTestContainerName(lifecycleDir, options)}`),
      );
      expect(remaining).toEqual([]);
    },
    CONTAINER_TIMEOUT_MS,
  );

  it(
    'replaces an instance whose fingerprint or container is stale',
    async () => {
      rmSync(lifecycleDir, { recursive: true, force: true });

      // Подсунутый (или оставшийся от прошлой схемы миграций) state: формат
      // валидный, но контейнер недостижим, fingerprint чужой. Хелпер обязан
      // заменить экземпляр, а не подключиться к протухшему шаблону.
      const staleKey = postgresTestInstanceKey(options);
      mkdirSync(lifecycleDir, { recursive: true });
      writeFileSync(
        join(lifecycleDir, `instance-${staleKey}.json`),
        JSON.stringify({
          uri: 'postgres://test:test@localhost:1/postgres',
          containerId: 'a'.repeat(64),
          fingerprint: '0'.repeat(16),
          templateName: `template_${staleKey}`,
          refcount: 1,
        }),
      );

      const replaced = await create(lifecycleDir);
      const state: unknown = JSON.parse(
        readFileSync(join(lifecycleDir, `instance-${staleKey}.json`), 'utf8'),
      );
      if (
        typeof state !== 'object' ||
        state === null ||
        !('fingerprint' in state) ||
        typeof state.fingerprint !== 'string'
      ) {
        throw new Error('instance state was not rewritten');
      }
      expect(state.fingerprint).not.toBe('0'.repeat(16));

      await shut(replaced);
    },
    CONTAINER_TIMEOUT_MS,
  );

  it(
    'recovers a coordination lock left by a dead holder',
    async () => {
      rmSync(lifecycleDir, { recursive: true, force: true });

      // Мёртвый держатель: pid завершившегося процесса (spawnSync дожидается выхода).
      const dead = spawnSync('true');
      if (dead.pid === undefined) {
        throw new Error('spawnSync did not report the process id');
      }
      const lockDir = join(lifecycleDir, `lock-${postgresTestInstanceKey(options)}`);
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(join(lockDir, 'holder.json'), JSON.stringify({ pid: dead.pid }));

      // Хелпер ломает мёртвый лок, стартует экземпляр и штатно закрывается.
      const recovered = await create(lifecycleDir);
      await shut(recovered);

      expect(instanceFileCount()).toBe(0);
    },
    CONTAINER_TIMEOUT_MS,
  );

  it(
    'recovers a lock whose holder file is unreadable or malformed',
    async () => {
      rmSync(lifecycleDir, { recursive: true, force: true });

      // Кривой PID-файл (обрванная запись, не JSON, чужой формат): лок должен
      // сломаться сразу, а не повесить последователь до 115-секундного таймаута
      // (фикс закреплён тестом — rev test-quality c1.4).
      const lockDir = join(lifecycleDir, `lock-${postgresTestInstanceKey(options)}`);
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(join(lockDir, 'holder.json'), 'not json');

      const recovered = await create(lifecycleDir);
      await shut(recovered);

      expect(instanceFileCount()).toBe(0);
    },
    CONTAINER_TIMEOUT_MS,
  );
});

describe('postgresTestInstanceKey', () => {
  it('разные migrate на одной папке — разные ключи (урок c1.7: общая заглушка опустошала шаблон)', () => {
    const base = { image: POSTGRES_TEST_IMAGE, migrationsFolder: taskMigrationsFolder };

    const migrated = postgresTestInstanceKey({ ...base, migrate: migrateTaskDatabase });
    const stubbed = postgresTestInstanceKey({ ...base, migrate: () => Promise.resolve() });

    expect(stubbed).not.toBe(migrated);
    // Контракт стабилен: тот же набор опций — тот же ключ (переиспользование
    // контейнера внутри прогона и между прогонами сохраняется).
    expect(postgresTestInstanceKey({ ...base, migrate: migrateTaskDatabase })).toBe(migrated);
    expect(postgresTestInstanceKey({ ...base, migrate: () => Promise.resolve() })).toBe(stubbed);
  });
});
