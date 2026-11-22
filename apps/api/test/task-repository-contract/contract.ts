import { expect } from 'vitest';

import { TaskSchema, type Task } from '@repo/contracts';

import type { TaskRepository } from '../../src/tasks/repository.ts';

/**
 * Контрактный набор тестов TaskRepository (C1.1): один набор проверок
 * прогоняется против любой реализации, подстановка — фабрика в вызывающем
 * тесте. Каждая проверка получает свежий изолированный экземпляр; часы и
 * генератор идентификаторов реализации набору не нужны: порядок задаётся
 * reset-сидированием с явными createdAt, поэтому набор без изменений
 * прогоняется против реализаций с серверными id и датами (Postgres — C1.x).
 * Порядок при равных createdAt вне контракта: тай-брейк реализации вправе
 * выбирать сами (review test-quality-reviewer 2026-11-14).
 * Чувствительность набора держит канарейка in-memory.canary.test.ts:
 * реализация, потерявшая порядок, красит набор.
 *
 * Прогон набора против реализации:
 *
 * describe('TaskRepository contract: <implementation>', () => {
 *   it.each(taskRepositoryContractChecks)('$name', async ({ check }) => {
 *     await expect(check(new SomeRepository())).resolves.toBeUndefined();
 *   });
 * });
 */
export interface TaskRepositoryContractCheck {
  name: string;
  check: (repository: TaskRepository) => Promise<void>;
}

let seedSequence = 0;

/** Задача для reset-сидирования: id и createdAt по умолчанию уникальны, порядок задаётся явно. */
function seededTask(overrides: Partial<Task> = {}): Task {
  const sequence = ++seedSequence;
  return {
    id: overrides.id ?? `10000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    title: overrides.title ?? `seeded ${sequence}`,
    completed: overrides.completed ?? false,
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
  };
}

export const taskRepositoryContractChecks: readonly TaskRepositoryContractCheck[] = [
  {
    name: 'create returns a new open task that satisfies the Task contract',
    check: async (repository) => {
      const task = await repository.create('Write tests');

      expect(task.title).toBe('Write tests');
      expect(task.completed).toBe(false);
      expect(task.id).not.toBe('');
      expect(TaskSchema.parse(task)).toEqual(task);
    },
  },
  {
    name: 'create gives successive tasks distinct ids',
    check: async (repository) => {
      const first = await repository.create('first');
      const second = await repository.create('second');

      expect(second.id).not.toBe(first.id);
    },
  },
  {
    name: 'create makes the task visible in the list',
    check: async (repository) => {
      const older = seededTask({ createdAt: '2026-01-01T00:00:00.000Z' });
      await repository.reset([older]);

      await repository.create('fresh');

      const titles = (await repository.list()).map((task) => task.title);
      expect(titles).toContain('fresh');
      expect(titles).toContain(older.title);
    },
  },
  {
    name: 'list orders tasks newest first',
    check: async (repository) => {
      const first = seededTask({ title: 'first', createdAt: '2026-01-01T00:00:00.000Z' });
      const second = seededTask({ title: 'second', createdAt: '2026-01-02T00:00:00.000Z' });
      const third = seededTask({ title: 'third', createdAt: '2026-01-03T00:00:00.000Z' });

      await repository.reset([second, first, third]);

      expect((await repository.list()).map((task) => task.title)).toEqual([
        'third',
        'second',
        'first',
      ]);
    },
  },
  {
    name: 'toggle flips completion and persists it in the list',
    check: async (repository) => {
      const { id } = await repository.create('Toggle me');

      expect((await repository.toggle(id))?.completed).toBe(true);
      expect((await repository.list()).find((task) => task.id === id)?.completed).toBe(true);

      expect((await repository.toggle(id))?.completed).toBe(false);
      expect((await repository.list()).find((task) => task.id === id)?.completed).toBe(false);
    },
  },
  {
    name: 'toggle flips a seeded completed task back to open',
    check: async (repository) => {
      const seeded = seededTask({ completed: true });
      await repository.reset([seeded]);

      expect((await repository.toggle(seeded.id))?.completed).toBe(false);
    },
  },
  {
    name: 'toggle of an unknown id resolves undefined and leaves the store unchanged',
    check: async (repository) => {
      const seeded = seededTask();
      await repository.reset([seeded]);

      await expect(
        repository.toggle('00000000-0000-4000-8000-999999999999'),
      ).resolves.toBeUndefined();

      expect(await repository.list()).toEqual([seeded]);
    },
  },
  {
    name: 'remove deletes the task and returns it',
    check: async (repository) => {
      const created = await repository.create('Delete me');

      const removed = await repository.remove(created.id);

      expect(removed?.id).toBe(created.id);
      expect((await repository.list()).map((task) => task.id)).not.toContain(created.id);
    },
  },
  {
    name: 'remove of an unknown id resolves undefined and leaves the store unchanged',
    check: async (repository) => {
      const seeded = seededTask();
      await repository.reset([seeded]);

      await expect(
        repository.remove('00000000-0000-4000-8000-999999999999'),
      ).resolves.toBeUndefined();

      expect(await repository.list()).toEqual([seeded]);
    },
  },
  {
    name: 'create records the owner and ownerOf reads it back',
    check: async (repository) => {
      const created = await repository.create('Owned task', 'actor-1');

      await expect(repository.ownerOf(created.id)).resolves.toBe('actor-1');
    },
  },
  {
    name: 'create without an owner and ownerOf of an ownerless task resolve null',
    check: async (repository) => {
      const created = await repository.create('Ownerless task');

      await expect(repository.ownerOf(created.id)).resolves.toBeNull();
    },
  },
  {
    name: 'ownerOf of an unknown id resolves null: fail-closed, no oracle',
    check: async (repository) => {
      await expect(repository.ownerOf('00000000-0000-4000-8000-999999999999')).resolves.toBeNull();
    },
  },
  {
    name: 'reset gives seeded tasks no owner: e2e seed data stays ownerless',
    check: async (repository) => {
      const seeded = seededTask();
      await repository.reset([seeded]);

      await expect(repository.ownerOf(seeded.id)).resolves.toBeNull();
    },
  },
  {
    name: 'reset replaces the whole store',
    check: async (repository) => {
      await repository.create('old');
      const seeded = seededTask({ createdAt: '2026-01-01T00:00:00.000Z' });

      await repository.reset([seeded]);

      expect(await repository.list()).toEqual([seeded]);
    },
  },
  {
    name: 'reset with an empty list empties the store',
    check: async (repository) => {
      await repository.create('old');

      await repository.reset([]);

      expect(await repository.list()).toEqual([]);
    },
  },
  {
    // Рабочие пространства (ADR 0020): изоляция E2E-сценариев на уровне домена.
    name: 'list without a workspace shows only workspaceless tasks',
    check: async (repository) => {
      const ownerless = seededTask();
      const scoped = seededTask();
      await repository.reset([ownerless]);
      await repository.reset([scoped], 'ws-a');

      expect(await repository.list()).toEqual([ownerless]);
    },
  },
  {
    name: 'list scopes tasks to their workspace',
    check: async (repository) => {
      const first = seededTask();
      const second = seededTask();
      await repository.reset([first], 'ws-a');
      await repository.reset([second], 'ws-b');

      expect(await repository.list('ws-a')).toEqual([first]);
      expect(await repository.list('ws-b')).toEqual([second]);
      expect(await repository.list()).toEqual([]);
    },
  },
  {
    name: 'reset with a workspace replaces only that workspace',
    check: async (repository) => {
      const replaced = seededTask();
      await repository.reset([replaced], 'ws-a');
      const neighbour = seededTask();
      await repository.reset([neighbour], 'ws-b');

      const fresh = seededTask({ createdAt: '2026-01-01T00:00:00.000Z' });
      await repository.reset([fresh], 'ws-a');

      expect(await repository.list('ws-a')).toEqual([fresh]);
      expect(await repository.list('ws-b')).toEqual([neighbour]);
    },
  },
  {
    name: 'toggle and remove outside the workspace scope resolve undefined and leave the store',
    check: async (repository) => {
      const seeded = seededTask();
      await repository.reset([seeded], 'ws-a');

      await expect(repository.toggle(seeded.id)).resolves.toBeUndefined();
      await expect(repository.toggle(seeded.id, 'ws-b')).resolves.toBeUndefined();
      await expect(repository.remove(seeded.id, 'ws-b')).resolves.toBeUndefined();

      expect(await repository.list('ws-a')).toEqual([seeded]);
    },
  },
  {
    // Класс коллизии seed-данных (план-ревью c1.5): идентичные id в параллельных
    // workspace должны отказывать громко в обеих реализациях, а не затирать
    // соседа (InMemory Map) или падать PK-исключением только на Postgres.
    name: 'reset rejects seed ids already used by another workspace',
    check: async (repository) => {
      const clash = seededTask();
      await repository.reset([clash], 'ws-a');

      await expect(
        repository.reset([seededTask({ id: clash.id, title: 'imposter' })], 'ws-b'),
      ).rejects.toThrow(/unique across workspaces/);

      expect(await repository.list('ws-a')).toEqual([clash]);
      expect(await repository.list('ws-b')).toEqual([]);
    },
  },
  {
    // Повторный seed своего workspace с теми же id — легальная замена строк
    // (visual/perf сеют перед каждым сценарием); только чужой scope — отказ.
    name: 'reset with the same ids in the same workspace replaces the rows',
    check: async (repository) => {
      const seeded = seededTask({ completed: false });
      await repository.reset([seeded], 'ws-a');

      const retoggled = seededTask({ id: seeded.id, completed: true });
      await repository.reset([retoggled], 'ws-a');

      expect(await repository.list('ws-a')).toEqual([retoggled]);
    },
  },
  {
    name: 'reset rejects duplicate ids within one seed',
    check: async (repository) => {
      const seeded = seededTask();

      await expect(
        repository.reset([seeded, seededTask({ id: seeded.id, title: 'twin' })], 'ws-a'),
      ).rejects.toThrow(/Duplicate task id within one seed/);
    },
  },
  {
    name: 'create records the workspace and the list scopes by it',
    check: async (repository) => {
      const created = await repository.create('Workspace task', null, 'ws-a');

      expect((await repository.list('ws-a')).map((task) => task.id)).toEqual([created.id]);
      expect(await repository.list('ws-b')).toEqual([]);
      expect(await repository.list()).toEqual([]);
    },
  },
];
