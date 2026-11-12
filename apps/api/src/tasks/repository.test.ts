import { describe, expect, it } from 'vitest';

import { InMemoryTaskRepository } from './repository.ts';

function createRepository() {
  let tick = 0;
  let id = 0;
  return new InMemoryTaskRepository({
    now: () => new Date(Date.UTC(2026, 10, 1, 10, 0, tick++)),
    generateId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
  });
}

describe('InMemoryTaskRepository', () => {
  it('creates an open task with generated id and timestamp', async () => {
    const repo = createRepository();

    const task = await repo.create('Write tests');

    expect(task).toEqual({
      id: '00000000-0000-4000-8000-000000000001',
      title: 'Write tests',
      completed: false,
      createdAt: '2026-11-01T10:00:00.000Z',
    });
  });

  it('lists tasks newest first', async () => {
    const repo = createRepository();
    await repo.create('first');
    await repo.create('second');
    await repo.create('third');

    const titles = (await repo.list()).map((task) => task.title);

    expect(titles).toEqual(['third', 'second', 'first']);
  });

  it('toggles completion back and forth', async () => {
    const repo = createRepository();
    const { id } = await repo.create('Toggle me');

    expect((await repo.toggle(id))?.completed).toBe(true);
    expect((await repo.toggle(id))?.completed).toBe(false);
    expect((await repo.list())[0]?.completed).toBe(false);
  });

  it('returns undefined when toggling an unknown task', async () => {
    const repo = createRepository();

    await expect(repo.toggle('00000000-0000-4000-8000-999999999999')).resolves.toBeUndefined();
  });

  it('replaces all tasks on reset', async () => {
    const repo = createRepository();
    await repo.create('old');
    const seeded = {
      id: '00000000-0000-4000-8000-000000000042',
      title: 'seeded',
      completed: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    };

    await repo.reset([seeded]);

    expect(await repo.list()).toEqual([seeded]);
  });
});
