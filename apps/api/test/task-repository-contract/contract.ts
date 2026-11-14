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
];
