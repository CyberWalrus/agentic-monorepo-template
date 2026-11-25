import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TaskSchema, type Task } from '@repo/contracts';

import {
  createPostgresTestDatabase,
  POSTGRES_TEST_IMAGE,
  type PostgresTestDatabase,
} from '../../test/test-database.ts';
import { migrateTaskDatabase, TASK_POOL_OPTIONS, taskMigrationsFolder } from './database.ts';
import { PostgresTaskRepository } from './postgres-repository.ts';
import { InMemoryTaskRepository } from './repository.ts';

/** Та же задача в канонической форме границы: UTC, `Z`, ровно три цифры дробной части. */
function canonical(task: Task): Task {
  return { ...task, createdAt: new Date(task.createdAt).toISOString() };
}

describe('TASK_POOL_OPTIONS', () => {
  // Значения закреплены как контракт (ср. ключ advisory-лока в database.ts):
  // каждый таймаут закрывает свой класс зависания (комментарий в database.ts),
  // рост значения — осознанная правка этого теста, а не случайный дрейф.
  it('bounds every way a connection can hang: pool wait, statement, idle', () => {
    expect(TASK_POOL_OPTIONS).toEqual({
      max: 10,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 15_000,
    });
  });
});

// e58: одна каноническая форма createdAt на границе — UTC с `Z` и
// миллисекундами, как у Date#toISOString(). Контракт пускает любую точность
// дробной секунды и её отсутствие; до e58 реализации расходились: InMemory
// сортировал список лексикографически по строке и отдавал её как пришла,
// Postgres — по моменту времени и через toISOString(). Здесь один и тот же
// набор задач проходит через обе реализации: порядок и формат ответа обязаны
// совпасть. Специфика InMemory — repository.test.ts.
describe('createdAt: InMemory and Postgres agree', () => {
  // Таймаут на уровне файла: **/vitest.config.ts защищён, дефолтный hookTimeout
  // Vitest (10 с) холодный старт контейнера не проходит (docs/test-database-isolation.md).
  const CONTAINER_TIMEOUT_MS = 120_000;

  // Формы, которые принимает контракт: `Z` обязателен, дробная часть — любой
  // длины или её нет.
  const WHOLE_SECOND: Task = {
    id: '00000000-0000-4000-8000-0000000000a1',
    title: 'whole second',
    completed: false,
    createdAt: '2026-11-01T10:00:00Z',
  };
  const SIX_DIGITS: Task = {
    id: '00000000-0000-4000-8000-0000000000a2',
    title: 'six fractional digits',
    completed: false,
    createdAt: '2026-11-01T10:00:00.250000Z',
  };
  const MICROSECONDS_BEFORE: Task = {
    id: '00000000-0000-4000-8000-0000000000a3',
    title: 'microseconds before',
    completed: false,
    createdAt: '2026-11-01T09:59:59.999999Z',
  };
  const ONE_DIGIT: Task = {
    id: '00000000-0000-4000-8000-0000000000a4',
    title: 'one fractional digit',
    completed: false,
    createdAt: '2026-11-01T10:00:00.5Z',
  };
  const MILLISECONDS: Task = {
    id: '00000000-0000-4000-8000-0000000000a5',
    title: 'milliseconds',
    completed: false,
    createdAt: '2026-11-01T10:00:01.000Z',
  };
  const SEED: readonly Task[] = [
    WHOLE_SECOND,
    SIX_DIGITS,
    MICROSECONDS_BEFORE,
    ONE_DIGIT,
    MILLISECONDS,
  ];
  /** Тот же набор, позже созданный раньше. */
  const NEWEST_FIRST: readonly Task[] = [
    MILLISECONDS,
    ONE_DIGIT,
    SIX_DIGITS,
    WHOLE_SECOND,
    MICROSECONDS_BEFORE,
  ];
  const EXACT: Task = {
    id: '00000000-0000-4000-8000-0000000000b1',
    title: 'exact',
    completed: false,
    createdAt: '2026-11-01T10:00:00.000Z',
  };
  const TENTH_OF_A_MICROSECOND: Task = {
    id: '00000000-0000-4000-8000-0000000000b2',
    title: 'a tenth of a microsecond',
    completed: false,
    createdAt: '2026-11-01T10:00:00.0001Z',
  };
  const CANONICAL_FORM = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

  // Изоляция c1.4: база на воркер из шаблона, тот же ключ экземпляра
  // (образ, каталог миграций, migrate), что у контрактного набора.
  let database: PostgresTestDatabase | undefined;

  beforeAll(async () => {
    database = await createPostgresTestDatabase({
      image: POSTGRES_TEST_IMAGE,
      migrationsFolder: taskMigrationsFolder,
      migrate: migrateTaskDatabase,
    });
  }, CONTAINER_TIMEOUT_MS);

  afterAll(async () => {
    if (database !== undefined) {
      await database.close();
    }
  });

  /** Обе реализации над одним набором: InMemory и Postgres в базе файла. */
  async function repositoriesSeededWith(seed: readonly Task[]) {
    if (database === undefined) {
      throw new Error('beforeAll did not start the Postgres test database');
    }
    const inMemory = new InMemoryTaskRepository();
    const postgres = new PostgresTaskRepository({ db: database.db });
    await inMemory.reset(seed);
    await postgres.reset(seed);
    return { inMemory, postgres };
  }

  it('lists the same seed newest first, by instant rather than by string', async () => {
    // Контроль набора: каждая форма проходит контракт — иначе тест проверял бы
    // то, что на границу не попадает.
    for (const task of SEED) {
      expect(TaskSchema.safeParse(task).success).toBe(true);
    }
    const { inMemory, postgres } = await repositoriesSeededWith(SEED);

    // newest first: позже созданный выше, как ни записана дробная часть
    // (до e58 InMemory ставил `…10:00:00Z` выше `…10:00:00.5Z`: `Z` больше `.`)
    const expected = NEWEST_FIRST.map(canonical);
    const [inMemoryList, postgresList] = await Promise.all([inMemory.list(), postgres.list()]);

    expect(inMemoryList).toEqual(expected);
    expect(postgresList).toEqual(expected);
    expect(inMemoryList).toEqual(postgresList);
  });

  it('answers createdAt in one canonical form from either storage', async () => {
    const { inMemory, postgres } = await repositoriesSeededWith(SEED);

    const [inMemoryList, postgresList] = await Promise.all([inMemory.list(), postgres.list()]);

    // Каждая строка — канонической формы и ровно та, что пишет Date#toISOString()
    // от неё же: другой записи момента на границе нет.
    for (const task of [...inMemoryList, ...postgresList]) {
      expect(task.createdAt).toMatch(CANONICAL_FORM);
      expect(task.createdAt).toBe(new Date(task.createdAt).toISOString());
    }
  });

  // Точность выше миллисекунд на границе не существует: обе задачи получают
  // одинаковый createdAt, порядок при равных createdAt контракт не определяет
  // (C1.1) — поэтому сверяются множества, а не последовательность.
  it('keeps every task when distinct instants collapse into one canonical createdAt', async () => {
    const { inMemory, postgres } = await repositoriesSeededWith([EXACT, TENTH_OF_A_MICROSECOND]);

    const [inMemoryList, postgresList] = await Promise.all([inMemory.list(), postgres.list()]);

    for (const listed of [inMemoryList, postgresList]) {
      expect(listed.map((task) => task.id).toSorted()).toEqual([
        EXACT.id,
        TENTH_OF_A_MICROSECOND.id,
      ]);
      expect(listed.map((task) => task.createdAt)).toEqual([
        '2026-11-01T10:00:00.000Z',
        '2026-11-01T10:00:00.000Z',
      ]);
    }
  });
});
