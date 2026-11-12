import { describe, expect, it } from 'vitest';

import { formatSummary, summarizeTasks } from './summarize.ts';

describe('summarizeTasks', () => {
  it('counts total and remaining tasks', () => {
    const summary = summarizeTasks([
      { completed: true },
      { completed: false },
      { completed: false },
    ]);

    expect(summary).toEqual({ total: 3, remaining: 2 });
  });

  it('handles an empty list', () => {
    expect(summarizeTasks([])).toEqual({ total: 0, remaining: 0 });
  });
});

describe('formatSummary', () => {
  it.each([
    [{ total: 0, remaining: 0 }, 'No tasks yet'],
    [{ total: 3, remaining: 0 }, 'All 3 done'],
    [{ total: 3, remaining: 2 }, '2 of 3 remaining'],
    [{ total: 1, remaining: 1 }, '1 of 1 remaining'],
  ])('formats %o as %s', (summary, expected) => {
    expect(formatSummary(summary)).toBe(expected);
  });
});
