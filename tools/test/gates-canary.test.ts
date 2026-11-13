/**
 * Санити-тест таблицы канареек гейтов (З6, B1): каждая канарейка ссылается на
 * существующий шаг verify, имеет непустые apply и expect, целевой шаг входит в
 * её --only, и slow-шаги в --only требуют --full (full совпадает с slow).
 * Сам прогон канареек здесь не запускается — он тяжёлый (worktree + install) и
 * идёт из workflow canaries.yml и nightly (`pnpm canaries`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BLOAT, CANARIES } from '../gate-canaries.ts';
import { allStepNames, fast, post, slow } from '../verify-steps.ts';

const slowNames = new Set(slow.map((step) => step.name));

// Шаги, которым канарейка по документированным причинам не нужна:
// test-count — warning-only (exit 0 по контракту), e2e-report/perf —
// тяжёлые, их время покрывают бюджеты nightly (architecture.md З6).
// e2e канареечится с ADR 0005 (прокси /rpc) и в вайтлист больше не входит.
const CANARY_EXEMPT_STEPS = new Set(['test-count', 'e2e-report', 'perf']);

describe('таблица канареек гейтов', () => {
  const known = new Set(allStepNames);

  it('имена шагов существуют в verify, целевой шаг входит в --only', () => {
    for (const canary of CANARIES) {
      const steps = canary.steps.split(',');
      for (const step of steps) {
        expect(known.has(step), `шаг ${step} канарейки «${canary.name}» не найден в verify`).toBe(
          true,
        );
      }
      expect(steps, `целевой шаг «${canary.name}» должен быть в --only`).toContain(
        canary.failedStep,
      );
    }
  });

  it('каждый блокирующий шаг verify покрыт канарейкой (кроме вайтлиста З6)', () => {
    const canaried = new Set(CANARIES.flatMap((canary) => canary.steps.split(',')));
    const blocking = [...fast, ...post, ...slow].map((step) => step.name);
    for (const step of blocking) {
      if (CANARY_EXEMPT_STEPS.has(step)) {
        continue;
      }
      expect(
        canaried.has(step),
        `блокирующий шаг ${step} без канарейки — добавь канарейку или задокументируй исключение в З6`,
      ).toBe(true);
    }
    // Вайтлист не разрастается молча: каждый исключённый шаг обязан существовать.
    for (const step of CANARY_EXEMPT_STEPS) {
      expect(known.has(step), `исключённый шаг ${step} не найден в verify`).toBe(true);
    }
  });

  it('apply и expect непустые, expect — живой RegExp', () => {
    for (const canary of CANARIES) {
      expect(canary.apply, `apply «${canary.name}»`).toBeTypeOf('function');
      expect(canary.expect, `expect «${canary.name}»`).toBeInstanceOf(RegExp);
      expect(
        canary.expect.source.length,
        `expect «${canary.name}» не должен быть пустым`,
      ).toBeGreaterThan(3);
    }
  });

  it('только build/bundle помечены slow (--full)', () => {
    for (const canary of CANARIES) {
      const usesSlow = canary.steps.split(',').some((step) => slowNames.has(step));
      expect(canary.full ?? false, `--full «${canary.name}» должен совпадать с slow-шагами`).toBe(
        usesSlow,
      );
    }
  });

  it('bundle-канарейка перекрывает бюджет с запасом текущего факта', () => {
    // Если базовый бандл похудеет, дельта канарейки перестанет превышать
    // бюджет и она молча перестанет ловить. Факт — из последнего локального
    // прогона (reports/bundle.json пишет pnpm bundle), дельта — честный gzip
    // литерала (40 000 случайных base64-символов сжимаются до ~30КБ).
    const canary = CANARIES.find((item) => item.failedStep === 'bundle');
    expect(canary, 'bundle-канарейка в таблице').toBeDefined();
    const budgets: unknown = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '..', '..', 'perf-budgets.json'), 'utf8'),
    );
    const budget = isRecord(budgets)
      ? getNumberAt(budgets, ['web', 'bundle', 'maxTotalJsGzipKb'])
      : undefined;
    const bundleReport = resolve(import.meta.dirname, '..', '..', 'reports', 'bundle.json');
    if (!existsSync(bundleReport) || typeof budget !== 'number') {
      return; // отчёта нет (свежий клон) — проверяется при наличии прогона
    }
    const report: unknown = JSON.parse(readFileSync(bundleReport, 'utf8'));
    const total = isRecord(report) ? findCheckTotal(report) : undefined;
    if (total === undefined) {
      return;
    }
    const canaryDeltaKb = gzipSync(Buffer.from(BLOAT, 'utf8')).length / 1024;
    expect(canaryDeltaKb, 'дельта канарейки против запаса до бюджета').toBeGreaterThan(
      budget - total,
    );
  });
});

/** Достаёт число по пути ключей; на любом не-объекте/не-числе возвращает undefined. */
/** Объект-словарь (не массив): общий гуард для чтения недоверенного JSON. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Достаёт число по пути ключей; на любом не-объекте/не-числе возвращает undefined. */
function getNumberAt(root: Record<string, unknown>, path: string[]): number | undefined {
  let current: unknown = root;
  for (const key of path) {
    if (!isRecord(current) || !(key in current)) {
      return undefined;
    }
    current = current[key];
  }
  return typeof current === 'number' ? current : undefined;
}

/** Ищет в checks отчёта бандла метрику total JS (gzip, KB). */
function findCheckTotal(report: Record<string, unknown>): number | undefined {
  const checks = report['checks'];
  if (!Array.isArray(checks)) {
    return undefined;
  }
  const total = checks.find((item) => isRecord(item) && item['metric'] === 'total JS (gzip, KB)');
  if (!isRecord(total)) {
    return undefined;
  }
  return typeof total['value'] === 'number' ? total['value'] : undefined;
}
