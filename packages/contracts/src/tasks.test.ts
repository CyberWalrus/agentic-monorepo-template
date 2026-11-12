import { describe, expect, it } from 'vitest';

import { CreateTaskInputSchema, TASK_TITLE_MAX_LENGTH, TaskSchema } from './tasks.ts';

describe('CreateTaskInputSchema', () => {
  it('trims the title', () => {
    expect(CreateTaskInputSchema.parse({ title: '  Buy milk  ' })).toEqual({ title: 'Buy milk' });
  });

  it('rejects a title that is empty after trimming', () => {
    const result = CreateTaskInputSchema.safeParse({ title: '   ' });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('Title is required');
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
});
