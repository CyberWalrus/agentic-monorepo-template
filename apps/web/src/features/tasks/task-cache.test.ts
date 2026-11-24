import { describe, expect, it } from 'vitest';

import type { Task } from '@repo/contracts';

import { applyTaskToggle, rollbackTaskToggle } from './task-cache.ts';

function task(overrides: Partial<Task> & Pick<Task, 'id' | 'completed'>): Task {
  return { title: 'Task', createdAt: '2026-11-14T00:00:00.000Z', ...overrides };
}

describe('applyTaskToggle', () => {
  it('flips the target task and leaves the rest unchanged', () => {
    const cached = [
      task({ id: 'task-1', completed: false }),
      task({ id: 'task-2', completed: true, title: 'Second' }),
      task({ id: 'task-3', completed: false, title: 'Third' }),
    ];

    const result = applyTaskToggle(cached, 'task-2');

    expect(result).toEqual([
      { ...cached[0] },
      { ...cached[1], completed: false },
      { ...cached[2] },
    ]);
  });

  it('does not mutate the cached array', () => {
    const cached = [
      task({ id: 'task-1', completed: false }),
      task({ id: 'task-2', completed: false, title: 'Second' }),
    ];
    const snapshot = cached.map((item) => ({ ...item }));

    const result = applyTaskToggle(cached, 'task-1');

    expect(result).not.toBe(cached);
    expect(cached).toEqual(snapshot);
  });

  it('keeps the list unchanged for an unknown id', () => {
    const cached = [task({ id: 'task-1', completed: false })];

    const result = applyTaskToggle(cached, 'task-42');

    expect(result).toEqual(cached);
  });

  it('handles an empty list', () => {
    expect(applyTaskToggle([], 'task-1')).toEqual([]);
  });

  it('keeps an empty cache empty', () => {
    expect(applyTaskToggle(undefined, 'task-1')).toBeUndefined();
  });
});

describe('rollbackTaskToggle', () => {
  const milk = task({ id: 'task-1', completed: false });
  const dog = task({ id: 'task-2', completed: true, title: 'Second' });
  const snapshot = [milk, dog];

  it('restores only the toggled task and keeps a task added to the cache meanwhile', () => {
    const cat = task({ id: 'task-3', completed: false, title: 'Third' });
    const current = [{ ...milk, completed: true }, dog, cat];

    const restored = rollbackTaskToggle(current, 'task-1', snapshot);

    expect(restored).toEqual([milk, dog, cat]);
  });

  it('keeps a change to another task that reached the cache meanwhile', () => {
    const current = [
      { ...milk, completed: true },
      { ...dog, completed: false },
    ];

    const restored = rollbackTaskToggle(current, 'task-1', snapshot);

    expect(restored).toEqual([milk, { ...dog, completed: false }]);
  });

  it('restores only completed, keeping fresh fields of the toggled task', () => {
    const current = [{ ...milk, completed: true, title: 'Buy oat milk' }, dog];

    const restored = rollbackTaskToggle(current, 'task-1', snapshot);

    expect(restored).toEqual([{ ...milk, title: 'Buy oat milk' }, dog]);
  });

  it('does not mutate the current list', () => {
    const current = [{ ...milk, completed: true }, dog];
    const snapshotOfCurrent = current.map((item) => ({ ...item }));

    rollbackTaskToggle(current, 'task-1', snapshot);

    expect(current).toEqual(snapshotOfCurrent);
  });

  it('falls back to the snapshot when the cache holds no current state', () => {
    expect(rollbackTaskToggle(undefined, 'task-1', snapshot)).toBe(snapshot);
  });

  it('has nothing to restore without a snapshot', () => {
    expect(rollbackTaskToggle(undefined, 'task-1', undefined)).toBeUndefined();
  });

  it('leaves the cache alone when the optimistic update never applied', () => {
    // Снимка не было — оптимистика ничего не меняла, а текущий список пришёл
    // позже с сервера и уже верен.
    const fresh = [milk, dog];

    expect(rollbackTaskToggle(fresh, 'task-1', undefined)).toBe(fresh);
  });

  it('does not resurrect the toggled task after it left the cache', () => {
    const current = [dog];

    expect(rollbackTaskToggle(current, 'task-1', snapshot)).toBe(current);
  });

  it('leaves the list unchanged when the task already matches the snapshot', () => {
    const current = [{ ...milk }, dog];

    expect(rollbackTaskToggle(current, 'task-1', snapshot)).toBe(current);
  });

  it('leaves the list unchanged for an id missing from the snapshot', () => {
    // Задача появилась в кэше после клика — оптимистика её не касалась.
    const cat = task({ id: 'task-3', completed: true, title: 'Third' });
    const current = [milk, cat];

    expect(rollbackTaskToggle(current, 'task-3', snapshot)).toBe(current);
  });
});
