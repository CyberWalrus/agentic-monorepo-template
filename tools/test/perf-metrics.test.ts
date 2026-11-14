/** median (tools/perf-metrics.ts): нечётный/чётный набор и пустой вход (NaN). */
import { describe, expect, it } from 'vitest';
import { median } from '../perf-metrics.ts';

describe('median', () => {
  it('нечётный набор — средний элемент', () => {
    expect(median([30, 10, 20])).toBe(20);
  });

  it('чётный набор — старший из двух средних', () => {
    expect(median([10, 20, 30, 40])).toBe(30);
  });

  it('пустой набор — NaN (пустые замеры не маскируются нулём)', () => {
    expect(median([])).toBeNaN();
  });
});
