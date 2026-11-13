/**
 * Санити бюджета времени verify (З6, B1): файл verify-budgets.json покрывает
 * все шаги verify числами, тоталы не меньше максимального шага, файл защищён
 * парой З10 (protected-paths.json + sandbox denyWrite) и не в turbo
 * globalDependencies (правка калибровки не должна обваливать кэш turbo).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { budgetMsFor, parseBudgets } from '../verify-budgets-loader.ts';
import { fast, post, slow } from '../verify-steps.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const repoDir = resolve(import.meta.dirname, '..', '..');

const budgets: unknown = JSON.parse(readFileSync(resolve(repoDir, 'verify-budgets.json'), 'utf8'));

describe('verify-budgets.json', () => {
  const b = isRecord(budgets) ? budgets : {};

  it('форма: fast/slow — словари чисел, тоталы — числа', () => {
    expect(isRecord(b), 'корневой объект').toBe(true);
    for (const key of ['fast', 'slow'] as const) {
      expect(isRecord(b[key]), `${key} — словарь`).toBe(true);
      const dict = isRecord(b[key]) ? b[key] : {};
      for (const [step, seconds] of Object.entries(dict)) {
        expect(
          typeof seconds === 'number' && seconds > 0,
          `${key}.${step} — положительное число`,
        ).toBe(true);
      }
    }
    expect(typeof b['totalFast'], 'totalFast — число').toBe('number');
    expect(typeof b['totalSlow'], 'totalSlow — число').toBe('number');
  });

  it('каждый шаг verify имеет бюджет, и наоборот — без неизвестных шагов', () => {
    const fastDict = isRecord(b['fast']) ? b['fast'] : {};
    const slowDict = isRecord(b['slow']) ? b['slow'] : {};
    for (const step of [...fast, ...post].map((item) => item.name)) {
      expect(typeof fastDict[step] === 'number', `шаг ${step} (fast/post) без бюджета`).toBe(true);
    }
    for (const step of slow.map((item) => item.name)) {
      expect(typeof slowDict[step] === 'number', `шаг ${step} (slow) без бюджета`).toBe(true);
    }
    // И наоборот: в файле нет бюджетов для несуществующих шагов.
    const stepNames = new Set([...fast, ...post, ...slow].map((item) => item.name));
    for (const [key, dict] of [
      ['fast', fastDict],
      ['slow', slowDict],
    ] as const) {
      for (const step of Object.keys(dict)) {
        expect(stepNames.has(step), `бюджет для неизвестного шага ${key}.${step}`).toBe(true);
      }
    }
  });

  it('тоталы вмещают сумму своей волны с запасом', () => {
    const fastDict = isRecord(b['fast']) ? b['fast'] : {};
    const slowDict = isRecord(b['slow']) ? b['slow'] : {};
    const fastMax = Math.max(0, ...Object.values(fastDict).map(Number));
    const slowMax = Math.max(0, ...Object.values(slowDict).map(Number));
    const slowSum = Object.values(slowDict).reduce(
      (sum: number, seconds) => sum + (typeof seconds === 'number' ? seconds : 0),
      0,
    );
    // totalSlow вмещает СУММУ slow-волны (wall-clock fast идёт параллельно, но
    // slow — последовательно и поверх): иначе nightly краснеет при зелёных
    // пошаговых бюджетах без понятной причины.
    expect(typeof b['totalFast'] === 'number' && b['totalFast'] >= fastMax).toBe(true);
    expect(typeof b['totalSlow'] === 'number' && b['totalSlow'] >= slowSum).toBe(true);
    expect(typeof b['totalSlow'] === 'number' && b['totalSlow'] >= slowMax).toBe(true);
  });

  it('файл защищён парой З10 и вне turbo globalDependencies', () => {
    const protectedPaths: unknown = JSON.parse(
      readFileSync(resolve(repoDir, 'tools', 'protected-paths.json'), 'utf8'),
    );
    expect(
      isRecord(protectedPaths) && Array.isArray(protectedPaths['deny'])
        ? protectedPaths['deny']
        : [],
    ).toContain('verify-budgets.json');

    const settings: unknown = JSON.parse(
      readFileSync(resolve(repoDir, '.claude', 'settings.json'), 'utf8'),
    );
    const denyWrite =
      isRecord(settings) && isRecord(settings['sandbox'])
        ? settings['sandbox']['filesystem']
        : undefined;
    const denyList =
      isRecord(denyWrite) && Array.isArray(denyWrite['denyWrite']) ? denyWrite['denyWrite'] : [];
    expect(denyList).toContain('verify-budgets.json');

    // turbo.json — JSONC (комментарии): проверяем текстом, что budgets-файл
    // не объявлен в globalDependencies (правка калибровки не обваливает кэш turbo).
    const turboText = readFileSync(resolve(repoDir, 'turbo.json'), 'utf8');
    expect(turboText.includes('"verify-budgets.json"')).toBe(false);
  });
});

describe('parseBudgets (загрузчик verify.ts)', () => {
  const valid = { fast: { lint: 10 }, slow: { e2e: 150 }, totalFast: 180, totalSlow: 480 };

  it('валидный файл разбирается', () => {
    const parsed = parseBudgets(structuredClone(valid));
    expect(parsed.fast['lint']).toBe(10);
    expect(parsed.slow['e2e']).toBe(150);
    expect(parsed.totalFast).toBe(180);
  });

  it.each([
    ['не объект', 'str', 'fast' in {} ? '{}' : 'expected an object'],
    ['массив', [], 'expected an object'],
    ['без fast', { slow: { e2e: 150 }, totalFast: 1, totalSlow: 2 }, '"fast" must be an object'],
    [
      'slow с нечислом',
      { fast: { a: 1 }, slow: { e2e: '150' }, totalFast: 1, totalSlow: 2 },
      '"slow.e2e" must be a number',
    ],
    ['totalFast не число', { fast: {}, slow: {}, totalFast: 'x', totalSlow: 2 }, 'must be numbers'],
  ])('%s — бросок', (_name, input, message) => {
    expect(() => parseBudgets(input)).toThrow(message);
  });

  it('budgetMsFor: fast/slow волны и неизвестный шаг', () => {
    const parsed = parseBudgets(structuredClone(valid));
    expect(budgetMsFor('lint', false, parsed)).toBe(10_000);
    expect(budgetMsFor('e2e', true, parsed)).toBe(150_000);
    expect(budgetMsFor('lint', true, parsed)).toBeUndefined();
    expect(budgetMsFor('unknown', false, parsed)).toBeUndefined();
  });
});
