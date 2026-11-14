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
  it('restores the exact pre-mutation snapshot', () => {
    const previous = [task({ id: 'task-1', completed: false })];

    const restored = rollbackTaskToggle(previous);

    expect(restored).toBe(previous);
  });

  it('has nothing to restore without a snapshot', () => {
    expect(rollbackTaskToggle(undefined)).toBeUndefined();
  });
});
