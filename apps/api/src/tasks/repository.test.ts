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

// Поведение интерфейса (CRUD, порядок, отсутствие ресурса) зафиксировано
// контрактным набором в test/task-repository-contract/; здесь — только
// то, что специфично для in-memory реализации.

describe('InMemoryTaskRepository', () => {
  it('creates a task with the injected id generator and clock', async () => {
    const repo = createRepository();

    const task = await repo.create('Write tests');

    expect(task).toEqual({
      id: '00000000-0000-4000-8000-000000000001',
      title: 'Write tests',
      completed: false,
      createdAt: '2026-11-01T10:00:00.000Z',
    });
  });

  it('orders tasks created later first using the captured clock', async () => {
    const repo = createRepository();
    await repo.create('first');
    await repo.create('second');
    await repo.create('third');

    const titles = (await repo.list()).map((task) => task.title);

    expect(titles).toEqual(['third', 'second', 'first']);
  });

  // e52: комбинация дефекта — задача с владельцем в одном рабочем
  // пространстве, remove из другого. Домен задачу не трогает и отвечает
  // undefined (отказ из этого делает роутер), владелец остаётся на месте.
  it('keeps an owned task in place when remove comes from another workspace', async () => {
    const repo = createRepository();
    const owned = await repo.create('Write tests', 'owner-1', 'ws-a');

    await expect(repo.remove(owned.id, 'ws-b')).resolves.toBeUndefined();

    expect(await repo.list('ws-a')).toEqual([owned]);
    expect(await repo.ownerOf(owned.id)).toBe('owner-1');
    // Контроль: из своего рабочего пространства та же задача удаляется.
    await expect(repo.remove(owned.id, 'ws-a')).resolves.toEqual(owned);
    expect(await repo.list('ws-a')).toEqual([]);
  });
});
