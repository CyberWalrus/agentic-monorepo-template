import { describe, expect, it } from 'vitest';

import type { Task } from '@repo/contracts';

import { InMemoryTaskRepository, type TaskRepository } from '../../src/tasks/repository.ts';

import { taskRepositoryContractChecks } from './contract.ts';

/**
 * Канарейка контрактного набора (критерий приёмки C1.1): набор обязан
 * ловить сломанные реализации, иначе он зелёный впустую. Реализация,
 * потерявшая порядок list(), должна красить проверки порядка; здоровая
 * реализация через тот же механизм проходит все проверки без исключений
 * (защита от вакуумно-зелёной канарейки).
 */
class OrderingLosingTaskRepository implements TaskRepository {
  readonly #inner = new InMemoryTaskRepository();

  async list() {
    return (await this.#inner.list()).toReversed();
  }

  create(title: string) {
    return this.#inner.create(title);
  }

  toggle(id: string) {
    return this.#inner.toggle(id);
  }

  reset(tasks: readonly Task[]) {
    return this.#inner.reset(tasks);
  }
}

/** Прогоняет все проверки набора (каждая на своём экземпляре) и возвращает имена упавших. */
async function failingCheckNames(createRepository: () => TaskRepository): Promise<string[]> {
  const verdicts = await Promise.all(
    taskRepositoryContractChecks.map(async ({ name, check }) => {
      try {
        await check(createRepository());

        return null;
      } catch {
        return name;
      }
    }),
  );

  return verdicts.filter((name) => name !== null);
}

describe('TaskRepository contract canary', () => {
  it('catches an implementation that loses list ordering', async () => {
    const failures = await failingCheckNames(() => new OrderingLosingTaskRepository());

    expect(failures).toContain('list orders tasks newest first');
  });

  it('passes every check for a healthy implementation', async () => {
    const failures = await failingCheckNames(() => new InMemoryTaskRepository());

    expect(failures).toEqual([]);
  });
});
