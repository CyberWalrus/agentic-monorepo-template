import type { Task } from '@repo/contracts';
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

  // e60: список без пагинации — выше 20 задач он не проверялся ни на одном
  // уровне. Пятьдесят созданных задач возвращаются целиком, newest first:
  // обрезка и сбой порядка видны по невозвращённым и переставленным id.
  it('returns all 50 created tasks, newest first', async () => {
    const repo = createRepository();
    // create синхронен до первого await: часы тикают в порядке вызовов, даже
    // когда обещания ждутся вместе.
    const created = await Promise.all(
      Array.from({ length: 50 }, (_, index) => repo.create(`Task ${index + 1}`)),
    );

    const listed = await repo.list();

    expect(listed).toHaveLength(50);
    expect(listed.map((task) => task.id)).toEqual(created.map((task) => task.id).toReversed());
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

  // e53: сбойный seed не оставляет в хранилище ни стёртого, ни частичного
  // набора — замена атомарна, как транзакция Postgres. Тот же сценарий на
  // обеих реализациях гоняет контрактный набор; здесь — на реализации с
  // дефектом, с тем, что в контракт не входит: сбойный reset сохраняет
  // владельца оставшейся строки.
  it('leaves the store untouched when a seed is rejected', async () => {
    const repo = createRepository();
    const kept = await repo.create('Keep me', 'owner-1', 'ws-a');
    const neighbour = await repo.create('Neighbour', null, 'ws-b');
    const replaced = { ...kept, title: 'Replaced' };

    // Первая строка набора валидна, вторая занимает id чужого рабочего пространства.
    await expect(
      repo.reset([replaced, { ...kept, id: neighbour.id, title: 'Imposter' }], 'ws-a'),
    ).rejects.toThrow(
      `Task id ${neighbour.id} already exists in workspace "ws-b" — seed data must use ids unique across workspaces (ADR 0020)`,
    );

    expect(await repo.list('ws-a')).toEqual([kept]);
    expect(await repo.ownerOf(kept.id)).toBe('owner-1');
    expect(await repo.list('ws-b')).toEqual([neighbour]);
    // Контроль: хранилище не заклинило — валидный набор с тем же id заменяет строку.
    await repo.reset([replaced], 'ws-a');
    expect(await repo.list('ws-a')).toEqual([replaced]);
  });

  // e58: createdAt на границе — одна каноническая форма, UTC с `Z` и
  // миллисекундами. Контракт пускает и целые секунды, и любую точность дробной
  // части; здесь — как InMemory к ней приходит. Те же наборы против Postgres
  // гоняет database.test.ts («createdAt: InMemory and Postgres agree»).
  describe('createdAt in one canonical form', () => {
    const WHOLE_SECOND: Task = {
      id: '00000000-0000-4000-8000-0000000000a1',
      title: 'whole second',
      completed: false,
      createdAt: '2026-11-01T10:00:00Z',
    };
    const MICROSECONDS: Task = {
      id: '00000000-0000-4000-8000-0000000000a2',
      title: 'microseconds',
      completed: false,
      createdAt: '2026-11-01T10:00:00.123456Z',
    };

    it('orders seeded tasks by instant, not by the string form', async () => {
      const repo = createRepository();
      // Набор лежит в хронологическом порядке: сортировка, не переставляющая
      // строки, тоже красит.
      await repo.reset([WHOLE_SECOND, MICROSECONDS]);

      const titles = (await repo.list()).map((task) => task.title);

      // До e58 целая секунда стояла выше: лексикографически `Z` больше `.`.
      expect(titles).toEqual(['microseconds', 'whole second']);
    });

    it('answers a seeded createdAt in the canonical form from list, toggle and remove', async () => {
      const repo = createRepository();
      await repo.reset([WHOLE_SECOND, MICROSECONDS]);
      const micro = { ...MICROSECONDS, createdAt: '2026-11-01T10:00:00.123Z' };
      const whole = { ...WHOLE_SECOND, createdAt: '2026-11-01T10:00:00.000Z' };

      expect(await repo.list()).toEqual([micro, whole]);
      expect(await repo.toggle(MICROSECONDS.id)).toEqual({ ...micro, completed: true });
      expect(await repo.remove(MICROSECONDS.id)).toEqual({ ...micro, completed: true });
    });

    it('leaves the store untouched when a seed carries an unparseable createdAt', async () => {
      const repo = createRepository();
      const kept = await repo.create('Keep me');

      await expect(repo.reset([{ ...MICROSECONDS, createdAt: 'yesterday' }])).rejects.toThrow(
        'Invalid time value',
      );

      expect(await repo.list()).toEqual([kept]);
    });
  });
});
