/**
 * Санити-тест таблицы канареек гейтов (З6, B1): каждая канарейка ссылается на
 * существующий шаг verify, имеет непустые apply и expect, целевой шаг входит в
 * её --only, и slow-шаги в --only требуют --full (full совпадает с slow).
 * Сам прогон канареек здесь не запускается — он тяжёлый (worktree + install) и
 * идёт из workflow canaries.yml и nightly (`pnpm canaries`).
 *
 * Канарейки шага boundaries сверяются с правилами конфига границ поимённо
 * (e47): покрытие «шаг покрыт» не замечало, что правил без канарейки всё больше.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BLOAT, BLOAT_DELTA, CANARIES, type GateCanary } from '../gate-canaries.ts';
import { allStepNames, fast, post, serialFast, slow } from '../verify-steps.ts';

const slowNames = new Set(slow.map((step) => step.name));

// Шаги, которым канарейка по документированным причинам не нужна:
// test-count — warning-only (exit 0 по контракту), e2e-report — тяжёлый,
// его время покрывают бюджеты nightly (architecture.md З6). e2e канареечится
// с ADR 0005 (прокси /rpc), perf — с A6 PR-1 (лишний /rpc-запрос), в вайтлист
// больше не входят. tool-class — образец B4.1: удаление шага делает
// `verify --only` красным без JSON-отчёта, поэтому логика чекера канареечится
// фикстурами tools/test/check-tool-class, а проводка — wiring-канарейкой на
// test:hooks (ADR 0014, e9).
const CANARY_EXEMPT_STEPS = new Set(['test-count', 'e2e-report', 'tool-class']);

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
    // b14: покрытие — ЧЕЙ-ТО failedStep, не членство в union steps. Build годами
    // проходил формально через union соседей «build,bundle», хотя ни одна
    // канарейка не требовала красный build: членство в union допускает только
    // попутный прогон шага-пререквизита, красить обязан целевой шаг.
    const failedTargets = new Set(CANARIES.map((canary) => canary.failedStep));
    const blocking = [...serialFast, ...fast, ...post, ...slow].map((step) => step.name);
    for (const step of blocking) {
      if (CANARY_EXEMPT_STEPS.has(step)) {
        continue;
      }
      expect(
        failedTargets.has(step),
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

// --- Канарейки границ по правилам (e47) ----------------------------------------------

const DEPENDENCY_CONFIG = resolve(import.meta.dirname, '..', '..', '.dependency-cruiser.cjs');

/**
 * Правила границ без канарейки на своём имени — с причиной. Вайтлист не растёт
 * молча: каждое имя обязано быть правилом в конфиге (тест ниже).
 */
const BOUNDARIES_RULE_CANARY_EXEMPT = new Map<string, string>([
  [
    'no-deep-package-imports',
    'правило недостижимо на текущем дереве: подпуть вне exports-карты пакета не разрешается (ловит not-to-unresolvable — канарейка «глубокий импорт пакета»), а симлинк node_modules/@repo/* раскрывается в packages/* (preserveSymlinks: false), поэтому пути «node_modules/@repo/<имя>/…» нет ни у одного модуля графа',
  ],
]);

/**
 * Имена правил `forbidden` из конфига границ. Конфиг — CommonJS, как его
 * загружает dependency-cruiser. Битый конфиг бросает: проверка не отключается.
 */
function dependencyRuleNames(): string[] {
  const config: unknown = createRequire(import.meta.url)(DEPENDENCY_CONFIG);
  const forbidden: unknown = isRecord(config) ? config['forbidden'] : undefined;
  if (!Array.isArray(forbidden) || forbidden.length === 0) {
    throw new Error(`${DEPENDENCY_CONFIG}: ожидается непустой массив forbidden`);
  }
  return forbidden.map((rule: unknown, index: number) => {
    const name = isRecord(rule) ? rule['name'] : undefined;
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`${DEPENDENCY_CONFIG}: forbidden[${index}] без name`);
    }
    return name;
  });
}

/** Канарейка ожидает именно это правило: имя — литерал в expect, и expect матчит имя. */
function expectsRule(canary: GateCanary, rule: string): boolean {
  // Двусторонне: одного test мало — /no-/ матчит четыре правила; одного
  // includes мало — /not-to-dev-dep-2/ накрыл бы not-to-dev-dep. Регулярка
  // пересобирается без флагов: у RegExp с g тест помнит lastIndex.
  return canary.expect.source.includes(rule) && new RegExp(canary.expect.source).test(rule);
}

describe('канарейки шага boundaries — по правилам, а не по шагу (e47)', () => {
  // Вердикт канарейки выносит целевой шаг: сосед в steps границу не доказывает.
  const boundaries = CANARIES.filter((canary) => canary.failedStep === 'boundaries');

  it('у каждого правила границ есть канарейка с expect на его name', () => {
    const uncovered = dependencyRuleNames().filter(
      (rule) =>
        !BOUNDARIES_RULE_CANARY_EXEMPT.has(rule) &&
        !boundaries.some((canary) => expectsRule(canary, rule)),
    );

    expect(
      uncovered,
      'правила границ без канарейки — добавь канарейку с expect на его name или запиши причину в BOUNDARIES_RULE_CANARY_EXEMPT',
    ).toEqual([]);
  });

  it('expect каждой канарейки границ называет существующее правило', () => {
    // Обратное направление: переименовали правило в конфиге или написали expect
    // на путь зонда — красный шаг test:hooks, не ночной «НЕ УПАЛ».
    const rules = dependencyRuleNames();
    const unnamed = boundaries.filter((canary) => !rules.some((rule) => expectsRule(canary, rule)));

    expect(
      unnamed.map((canary) => `«${canary.name}» /${canary.expect.source}/`),
      'канарейки boundaries, чей expect — не имя ни одного правила границ',
    ).toEqual([]);
  });

  it('вайтлист не растёт молча: причина названа для существующего правила', () => {
    const rules = dependencyRuleNames();
    const stale = [...BOUNDARIES_RULE_CANARY_EXEMPT.keys()].filter((rule) => !rules.includes(rule));

    expect(stale, 'исключённые правила, которых нет в .dependency-cruiser.cjs').toEqual([]);
  });
});

describe('strict-канарейка: проба жива только при noUncheckedIndexedAccess (b13)', () => {
  const repoRoot = resolve(import.meta.dirname, '..', '..');

  function runTsc(probe: string, flags: string[]): { status: number | null; output: string } {
    const result = spawnSync(
      'pnpm',
      ['exec', 'tsc', '--noEmit', '--ignoreConfig', ...flags, probe],
      {
        encoding: 'utf8',
        cwd: repoRoot,
        timeout: 60_000,
      },
    );
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }

  // Два спавна tsc на маленьком файле (~1-2s каждый): дефолтного таймаута мало
  // под параллельной нагрузкой verify (приём check-required-tasks.test.ts).
  it('проба красит tsc с флагом, зелёная без него, путь пробы — живой якорь', () => {
    // Условие возврата b13: канарейка дублит защиту B8 как защита в глубину,
    // её смысл держится на том, что ошибка пробы видна ИМЕННО при
    // noUncheckedIndexedAccess. Если правка пробы или тип тихо сделает её
    // флагонезависимой (как соседние «type-ошибки»), этот инвариант краснеет
    // в test:hooks раньше, чем ночная канарейка «пролетит».
    const canary = CANARIES.find((item) => item.name === 'strict-флаг tsconfig ослаблен');
    if (canary === undefined) {
      throw new Error('канарейки «strict-флаг tsconfig ослаблен» нет в таблице');
    }
    const root = mkdtempSync(join(tmpdir(), 'b13-strict-probe-'));
    try {
      canary.apply(root);
      const probe = join(root, 'apps', 'api', 'src', 'evil-strict-probe.ts');
      const withFlag = runTsc(probe, ['--strict', '--noUncheckedIndexedAccess']);
      expect(withFlag.status, 'проба при noUncheckedIndexedAccess обязана красить').not.toBe(0);
      expect(withFlag.output, 'путь пробы в ошибке — якорь expect канарейки').toMatch(
        /evil-strict-probe/,
      );
      const withoutFlag = runTsc(probe, ['--strict']);
      expect(withoutFlag.status, 'без флага проба обязана компилироваться (strict не ловит)').toBe(
        0,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
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

const BUDGETS_PATH = resolve(import.meta.dirname, '..', '..', 'perf-budgets.json');
const BUNDLE_REPORT = resolve(import.meta.dirname, '..', '..', 'reports', 'bundle.json');
const PERF_REPORT = resolve(import.meta.dirname, '..', '..', 'e2e', 'reports', 'perf.json');

/** Читает perf-budgets.json или бросает: битый порог не должен молча отключать проверку. */
function readBudgets(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(BUDGETS_PATH, 'utf8'));
  if (!isRecord(parsed)) {
    throw new Error('perf-budgets.json: ожидается объект');
  }
  return parsed;
}

function requireThreshold(budgets: Record<string, unknown>): number {
  const threshold = getNumberAt(budgets, ['web', 'bundle', 'maxPrGrowthKb']);
  if (typeof threshold !== 'number') {
    throw new Error('perf-budgets.json: нет web.bundle.maxPrGrowthKb');
  }
  return threshold;
}

/** Ищет в checks отчёта бандла метрику по имени; нет — бросает (fail-closed). */
function requireCheckMetric(report: Record<string, unknown>, metric: string): number {
  const checks = report['checks'];
  const found = Array.isArray(checks)
    ? checks.find((item) => isRecord(item) && item['metric'] === metric)
    : undefined;
  if (!isRecord(found) || typeof found['value'] !== 'number') {
    throw new Error(
      `reports/bundle.json: нет метрики «${metric}» — инвариант порогов не проверяется`,
    );
  }
  return found['value'];
}

describe('дельта-канарейка и инвариант порогов (A6 PR-2, ADR 0013)', () => {
  it('дельта канарейки перекрывает порог роста с запасом', () => {
    // Если базовый бандл похудеет или порог поднимут, дельта канарейки
    // перестанет превышать maxPrGrowthKb и канарейка молча перестанет ловить.
    const canary = CANARIES.find((item) => item.failedStep === 'bundle-delta');
    expect(canary, 'дельта-канарейка в таблице').toBeDefined();
    const threshold = requireThreshold(readBudgets());
    const canaryDeltaKb = gzipSync(Buffer.from(BLOAT_DELTA, 'utf8')).length / 1024;
    expect(canaryDeltaKb, 'gzip дельты канарейки против maxPrGrowthKb').toBeGreaterThan(threshold);
  });

  it('запас каждого абсолютного бандл-потолка больше дельта-порога', () => {
    // Иначе абсолют краснеет раньше дельта-гейта, и label
    // bundle-growth-approved не разблокирует рост (находка sanity-ревью A6
    // PR-2). Факты — из отчётов последнего прогона; нет отчёта (свежий клон) —
    // проверка пропускается.
    const budgets = readBudgets();
    const threshold = requireThreshold(budgets);
    if (!existsSync(BUNDLE_REPORT) || !existsSync(PERF_REPORT)) {
      return;
    }
    const bundle: unknown = JSON.parse(readFileSync(BUNDLE_REPORT, 'utf8'));
    if (!isRecord(bundle)) {
      return;
    }
    const total = requireCheckMetric(bundle, 'total JS (gzip, KB)');
    const totalCeiling = getNumberAt(budgets, ['web', 'bundle', 'maxTotalJsGzipKb']);
    if (typeof totalCeiling !== 'number') {
      throw new Error('perf-budgets.json: нет web.bundle.maxTotalJsGzipKb');
    }
    expect(
      totalCeiling - total,
      `запас total JS (${totalCeiling} − ${total.toFixed(1)}) больше дельта-порога ${threshold}`,
    ).toBeGreaterThan(threshold);
    const largest = requireCheckMetric(bundle, 'largest JS chunk (gzip, KB)');
    const largestCeiling = getNumberAt(budgets, ['web', 'bundle', 'maxLargestJsChunkGzipKb']);
    if (typeof largestCeiling !== 'number') {
      throw new Error('perf-budgets.json: нет web.bundle.maxLargestJsChunkGzipKb');
    }
    expect(
      largestCeiling - largest,
      `запас крупнейшего чанка (${largestCeiling} − ${largest.toFixed(1)}) больше дельта-порога ${threshold}`,
    ).toBeGreaterThan(threshold);
    const perf: unknown = JSON.parse(readFileSync(PERF_REPORT, 'utf8'));
    const page = isRecord(perf) ? perf['page:/'] : undefined;
    if (!isRecord(page) || typeof page['jsWireKb'] !== 'number') {
      throw new Error('e2e/reports/perf.json: нет page:/.jsWireKb');
    }
    const wireCeiling = getNumberAt(budgets, ['web', 'pages', '/', 'maxJsWireKb']);
    if (typeof wireCeiling !== 'number') {
      throw new Error('perf-budgets.json: нет web.pages./.maxJsWireKb');
    }
    expect(
      wireCeiling - page['jsWireKb'],
      `запас wire-байт (${wireCeiling} − ${page['jsWireKb'].toFixed(1)}) больше дельта-порога ${threshold}`,
    ).toBeGreaterThan(threshold);
  });
});

describe('якоря канареек живы на текущем дереве (правка регистрации /rpc, 2026-11-24)', () => {
  // Канарейки идут по фильтру путей (canaries.yml): PR, меняющий файл-якорь вне
  // фильтра, их не запускает. e55 переписала регистрацию /rpc в server-app.ts —
  // якоря двух канареек исчезли, мерж прошёл зелёным, а краснить стало на всех
  // следующих PR, где пути фильтра есть. Здесь каждая канарейка применяется к
  // копии дерева: пропавший якорь красит test:hooks в том же PR.
  const repoRoot = resolve(import.meta.dirname, '..', '..');
  // Канарейки, которым нужна настоящая ветка (создают task/evil-*): без
  // репозитория apply бросает «canary setup failed»; их держит раннер канареек.
  const needGit: ReadonlySet<string> = new Set([
    'файл задачи не перенесён в done/',
    'дифф вне touches задачи',
  ]);
  // Копируется только дерево исходников: зависимости, сборка, отчёты и покрытия
  // (apps/api/coverage после прогона тестов) канарейкам не нужны
  const notCopied = new Set([
    'node_modules',
    '.git',
    'dist',
    'coverage',
    '.turbo',
    '.stryker-tmp',
    'reports',
    'playwright-report',
    'test-results',
    '.cache',
  ]);
  const depth = repoRoot.split(sep).length;
  // Симлинк не копируется: в копии он вёл бы в настоящее дерево, и канарейка,
  // пишущая через него, поправила бы оригинал
  const copyFilter = (source: string): boolean =>
    !lstatSync(source).isSymbolicLink() &&
    !source
      .split(sep)
      .slice(depth)
      .some((part) => notCopied.has(part));

  it('apply каждой канарейки не бросает на копии дерева', () => {
    const root = mkdtempSync(join(tmpdir(), 'canary-anchors-'));
    const pristine = join(root, 'pristine');
    try {
      cpSync(repoRoot, pristine, { recursive: true, filter: copyFilter });
      const failures: string[] = [];
      let applied = 0;
      for (const canary of CANARIES) {
        if (needGit.has(canary.name)) {
          continue;
        }
        const copy = join(root, 'copy');
        rmSync(copy, { recursive: true, force: true });
        cpSync(pristine, copy, { recursive: true });
        try {
          canary.apply(copy);
          applied += 1;
        } catch (e) {
          failures.push(`${canary.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      expect(applied, 'сколько канареек проверено').toBe(CANARIES.length - needGit.size);
      expect(failures, 'канарейки, чей якорь не найден в дереве').toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('список канареек, требующих git, называет существующие канарейки', () => {
    const names = new Set(CANARIES.map((canary) => canary.name));
    expect([...needGit].filter((name) => !names.has(name))).toEqual([]);
  });
});
