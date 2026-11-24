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

  remove(id: string) {
    return this.#inner.remove(id);
  }

  ownerOf(id: string) {
    return this.#inner.ownerOf(id);
  }

  reset(tasks: readonly Task[]) {
    return this.#inner.reset(tasks);
  }
}

/**
 * Реализация с дефектом e53: сбойный reset стирал данные до того, как набор
 * подтверждён. Через интерфейс это воспроизводится очисткой scope до
 * делегирования: с валидным набором результат неотличим от атомарной замены,
 * со сбойным хранилище остаётся стёртым.
 */
class WipeFirstResetTaskRepository implements TaskRepository {
  readonly #inner = new InMemoryTaskRepository();

  list(workspaceId?: string) {
    return this.#inner.list(workspaceId);
  }

  create(title: string, ownerId?: string | null, workspaceId?: string) {
    return this.#inner.create(title, ownerId, workspaceId);
  }

  toggle(id: string, workspaceId?: string) {
    return this.#inner.toggle(id, workspaceId);
  }

  remove(id: string, workspaceId?: string) {
    return this.#inner.remove(id, workspaceId);
  }

  ownerOf(id: string) {
    return this.#inner.ownerOf(id);
  }

  async reset(tasks: readonly Task[], workspaceId?: string): Promise<void> {
    await this.#inner.reset([], workspaceId);
    await this.#inner.reset(tasks, workspaceId);
  }
}

/**
 * Проверки атомарности сбойного reset (e53): ровно их красит реализация,
 * которая стирает данные до подтверждения набора.
 */
const FAILED_RESET_CHECK_NAMES = [
  'a failed global reset leaves the whole store untouched',
  'a failed workspace reset leaves that workspace and its neighbours untouched',
  'a failed workspace reset keeps earlier seed rows out when a later row clashes',
  'a workspace reset that reuses an ownerless id fails and leaves the store untouched',
  'a seed with a duplicate and a foreign id reports the duplicate and leaves the store untouched',
];

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

  it('catches an implementation that wipes the store before the seed is confirmed', async () => {
    const failures = await failingCheckNames(() => new WipeFirstResetTaskRepository());

    expect(failures).toEqual(FAILED_RESET_CHECK_NAMES);
  });

  it('passes every check for a healthy implementation', async () => {
    const failures = await failingCheckNames(() => new InMemoryTaskRepository());

    expect(failures).toEqual([]);
  });
});
