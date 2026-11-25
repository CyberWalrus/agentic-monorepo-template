import { describe, expect, it } from 'vitest';

import {
  CreateTaskInputSchema,
  TASK_TITLE_MAX_LENGTH,
  TaskSchema,
  tasksContract,
} from './tasks.ts';
import { isWorkspaceReader, workspaceScopedOperations } from './workspace.ts';

describe('CreateTaskInputSchema', () => {
  it('trims the title', () => {
    expect(CreateTaskInputSchema.parse({ title: '  Buy milk  ' })).toEqual({ title: 'Buy milk' });
  });

  it('rejects a title that is empty after trimming', () => {
    const result = CreateTaskInputSchema.safeParse({ title: '   ' });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('Title is required');
  });

  it('rejects an unknown key instead of dropping it silently', () => {
    const result = CreateTaskInputSchema.safeParse({ title: 'x', extra: 1 });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toMatchObject([{ code: 'unrecognized_keys', keys: ['extra'] }]);
  });

  it('accepts a title of exactly the maximum length', () => {
    const title = 'a'.repeat(TASK_TITLE_MAX_LENGTH);

    expect(CreateTaskInputSchema.parse({ title })).toEqual({ title });
  });

  it('rejects a title longer than the maximum length', () => {
    const title = 'a'.repeat(TASK_TITLE_MAX_LENGTH + 1);

    expect(CreateTaskInputSchema.safeParse({ title }).success).toBe(false);
  });
});

describe('TaskSchema', () => {
  const valid = {
    id: '0b6f5f0e-6a43-4b8e-9d55-5a4f8f3a3c11',
    title: 'Write tests',
    completed: false,
    createdAt: '2026-11-01T10:00:00.000Z',
  };

  it('accepts a valid task', () => {
    expect(TaskSchema.parse(valid)).toEqual(valid);
  });

  it('rejects a non-uuid id', () => {
    expect(TaskSchema.safeParse({ ...valid, id: '42' }).success).toBe(false);
  });

  it('rejects a non-ISO createdAt', () => {
    expect(TaskSchema.safeParse({ ...valid, createdAt: 'yesterday' }).success).toBe(false);
  });

  // e58: createdAt на границе — UTC с `Z`. Смещение часового пояса не
  // принимается, а точность дробной части может быть любой — приведение к
  // одной форме делают хранилища (apps/api/src/tasks).
  it('accepts any precision of the fractional part, or none', () => {
    for (const createdAt of [
      '2026-11-01T10:00:00Z',
      '2026-11-01T10:00:00.5Z',
      '2026-11-01T10:00:00.000Z',
      '2026-11-01T10:00:00.123456Z',
    ]) {
      expect(TaskSchema.safeParse({ ...valid, createdAt }).success).toBe(true);
    }
  });

  it('rejects a UTC offset in createdAt', () => {
    for (const createdAt of ['2026-11-01T12:00:00+02:00', '2026-11-01T10:00:00.000+00:00']) {
      expect(TaskSchema.safeParse({ ...valid, createdAt }).success).toBe(false);
    }
  });

  it('documents createdAt as the canonical UTC form the answers carry', () => {
    const description = TaskSchema.shape.createdAt.description ?? '';

    expect(description).toMatch(/with the `Z` suffix, a UTC offset is rejected/);
    expect(description).toMatch(/Date#toISOString\(\), milliseconds included/);
  });
});

// e58: каждая процедура задач читает заголовок рабочего пространства — список
// и мутации ограничены scope запроса (ADR 0020). Метка держит спеку: операция
// без неё осталась бы без описанного заголовка, и клиент из openapi.json о
// нём не узнал бы. Новая процедура домена обязана решить это явно.
describe('tasksContract and the workspace header', () => {
  it('marks every procedure as a reader of the workspace header', () => {
    const readers = Object.values(tasksContract).filter(
      (procedure) => !isWorkspaceReader(procedure),
    );

    expect(readers).toEqual([]);
  });

  it('names the operations whose spec documents the header', () => {
    expect([...workspaceScopedOperations(tasksContract)].toSorted()).toEqual([
      'DELETE /tasks/{id}',
      'GET /tasks',
      'POST /tasks',
      'POST /tasks/{id}/toggle',
    ]);
  });
});
