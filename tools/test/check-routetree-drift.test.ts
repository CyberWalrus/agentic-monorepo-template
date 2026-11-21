/**
 * Тесты гейта дрейфа routeTree.gen.ts (b7.1, tools/check-routetree-drift.ts).
 *
 * Ядро тестируется по фикстурам (evaluateVersions/evaluateDrift — чистые
 * функции): спавн CLI в юнит-тестах не нужен, кейсы «чистое состояние»,
 * «дрейф» и «файл отсутствует» краснеют по семантике входов, а не из-за
 * невозможности спавна. Один интеграционный кейс спавнит чекер на реальном
 * workspace и держит инвариант «committed не тронут» (генерация строго во
 * временный файл). Проводка проверяется инвариантами по образцу
 * tools/test/check-required-tasks.test.ts:134-181.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  cliBinPath,
  evaluateDrift,
  evaluateVersions,
  generatorVersions,
  type GenerationRun,
} from '../check-routetree-drift.ts';
import { ROUTE_TREE_FOOTER, withRouteTreeFooter } from '../../apps/web/scripts/routes-gen.ts';
import { fast } from '../verify-steps.ts';

// Интеграционный кейс спавнит чекер с реальной генерацией (~0.3s + прогрев);
// дефолтных 5s мало под параллельной нагрузкой verify (приём e20-теста).
vi.setConfig({ testTimeout: 30_000 });

const repoDir = resolve(import.meta.dirname, '..', '..');
const checker = join(repoDir, 'tools', 'check-routetree-drift.ts');

/** Минимальный фейковый вывод tsr: достаточно для чистых функций. */
const FAKE_TSR_OUTPUT = 'export const routeTree = rootRoute\n  ._addFileTypes()\n';

function generated(output: string | null, ok = true, stderr = ''): GenerationRun {
  return { ok, stderr, output };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('чистое ядро: версии генератора', () => {
  it('совпадающие версии — проблем нет', () => {
    expect(
      evaluateVersions({ ok: true, version: '1.167.46' }, { ok: true, version: '1.167.46' }),
    ).toEqual([]);
  });

  it('расхождение версий краснит с шагом починки (З11)', () => {
    const problems = evaluateVersions(
      { ok: true, version: '1.168.0' },
      { ok: true, version: '1.167.46' },
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('1.168.0');
    expect(problems[0]).toContain('1.167.46');
    expect(problems[0]).toContain('pnpm-workspace.yaml');
    expect(problems[0]).toContain('@tanstack/router-cli');
  });

  it('срыв резолва — красный, а не зелёная пустота (fail-closed, З4)', () => {
    expect(
      evaluateVersions({ ok: false, stderr: 'MODULE_NOT_FOUND' }, { ok: true, version: '1' }),
    ).toEqual(['@tanstack/router-generator не резолвится из чейна react-start: MODULE_NOT_FOUND']);
    expect(
      evaluateVersions({ ok: true, version: '1' }, { ok: false, stderr: 'boom' })[0],
    ).toContain('apps/web (pnpm install)');
  });

  it('реальный workspace: vite-чейн и CLI резолвятся в одну версию', () => {
    const { chain, cli } = generatorVersions(join(repoDir, 'apps', 'web', 'node_modules'));
    expect(chain).toEqual({ ok: true, version: cli.ok ? cli.version : '' });
    expect(evaluateVersions(chain, cli)).toEqual([]);
  });

  it('bin tsr резолвится из реального workspace и существует', () => {
    const bin = cliBinPath(join(repoDir, 'apps', 'web', 'node_modules'));
    if (!bin.ok) {
      throw new Error(`cliBinPath failed: ${bin.stderr}`);
    }
    expect(bin.path.endsWith('tsr.cjs')).toBe(true);
  });
});

describe('чистое ядро: дрейф', () => {
  it('чистое состояние — проблем нет', () => {
    expect(evaluateDrift(withRouteTreeFooter(FAKE_TSR_OUTPUT), generated(FAKE_TSR_OUTPUT))).toEqual(
      [],
    );
  });

  it('дрейф: ручная правка committed — красит с якорями «файл» и «pnpm regen»', () => {
    const problems = evaluateDrift(
      `${withRouteTreeFooter(FAKE_TSR_OUTPUT)}\n// evil manual edit\n`,
      generated(FAKE_TSR_OUTPUT),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('routeTree.gen.ts');
    expect(problems[0]).toContain('pnpm regen');
  });

  it('committed без футера (голый tsr) — тоже дрейф', () => {
    expect(evaluateDrift(FAKE_TSR_OUTPUT, generated(FAKE_TSR_OUTPUT))).toHaveLength(1);
  });

  it('committed отсутствует — красный (fail-closed, З4)', () => {
    expect(evaluateDrift(null, generated(FAKE_TSR_OUTPUT))[0]).toContain('pnpm regen');
  });

  it('срыв спавна CLI — красный с причиной', () => {
    expect(evaluateDrift('anything', generated(null, false, 'Cannot find module\nmore'))[0]).toBe(
      'tsr generate failed: Cannot find module',
    );
  });

  it('exit 0 без файла — красный, а не зелёная пустота (fail-closed, З4)', () => {
    expect(evaluateDrift('anything', generated(null))[0]).toContain('не создал файл');
  });
});

describe('чистое ядро: футер (единая трансформация с routes:gen)', () => {
  it('голый вывод превращается в committed-вид: пустая строка + футер', () => {
    const expected = `${FAKE_TSR_OUTPUT}\n${ROUTE_TREE_FOOTER}\n`;
    expect(withRouteTreeFooter(FAKE_TSR_OUTPUT)).toBe(expected);
  });

  it('идемпотентен: повторный вызов не меняет текст', () => {
    const once = withRouteTreeFooter(FAKE_TSR_OUTPUT);
    expect(withRouteTreeFooter(once)).toBe(once);
  });

  it('футер совпадает с хвостом committed-файла (константа == плагин Start)', () => {
    const committed = readFileSync(join(repoDir, 'apps/web/src/routeTree.gen.ts'), 'utf8');
    expect(committed.endsWith(`${ROUTE_TREE_FOOTER}\n`)).toBe(true);
    expect(withRouteTreeFooter(committed)).toBe(committed);
  });
});

describe('проводка гейта routetree', () => {
  it('verify-steps содержит шаг routetree в fast-волне', () => {
    expect(fast.map((step) => step.name)).toContain('routetree');
    const step = fast.find((item) => item.name === 'routetree');
    expect(step?.command).toBe('pnpm');
    expect(step?.args).toEqual(['routetree:check']);
  });

  it('package.json ведёт шаг к гейту', () => {
    const pkg: unknown = JSON.parse(readFileSync(join(repoDir, 'package.json'), 'utf8'));
    const scripts = isRecord(pkg) ? pkg['scripts'] : undefined;
    expect(isRecord(scripts) ? scripts['routetree:check'] : undefined).toBe(
      'node tools/check-routetree-drift.ts',
    );
  });

  it('CI исполняет шаг в job static', () => {
    const ci = readFileSync(join(repoDir, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toMatch(/pnpm routetree:check/);
  });

  it('бюджет шага в verify-budgets.json', () => {
    const budgets: unknown = JSON.parse(readFileSync(join(repoDir, 'verify-budgets.json'), 'utf8'));
    const fastDict = isRecord(budgets) ? budgets['fast'] : undefined;
    expect(isRecord(fastDict) ? fastDict['routetree'] : undefined).toBeTypeOf('number');
  });

  it('чекер в deny protected-paths.json (ADR 0014)', () => {
    const paths: unknown = JSON.parse(
      readFileSync(join(repoDir, 'tools', 'protected-paths.json'), 'utf8'),
    );
    const deny = isRecord(paths) && Array.isArray(paths['deny']) ? paths['deny'] : [];
    expect(deny).toContain('tools/check-routetree-drift.ts');
  });

  it('чекер в KNOWN_GATES check-tool-class (fail-closed-якорь, З4)', () => {
    const source = readFileSync(join(repoDir, 'tools', 'check-tool-class.ts'), 'utf8');
    expect(source).toContain("'tools/check-routetree-drift.ts'");
  });

  it('канарейка красит шаг routetree (З5)', () => {
    const source = readFileSync(join(repoDir, 'tools', 'gate-canaries.ts'), 'utf8');
    expect(source).toMatch(/steps:\s*'routetree'/);
    expect(source).toMatch(/отличается от свежей генерации/);
  });

  it('единый источник футера: гейт импортирует routes-gen, не копию (З10)', () => {
    const source = readFileSync(checker, 'utf8');
    expect(source).toContain("from '../apps/web/scripts/routes-gen.ts'");
  });

  it('regen заменяет build-ногу на routes:gen (без сборки — критерий b7.1)', () => {
    const pkg: unknown = JSON.parse(readFileSync(join(repoDir, 'package.json'), 'utf8'));
    const scripts = isRecord(pkg) ? pkg['scripts'] : undefined;
    expect(isRecord(scripts) ? scripts['regen'] : undefined).toBe(
      'pnpm --filter @repo/contracts openapi && pnpm --filter @repo/web routes:gen',
    );
    const webPkg: unknown = JSON.parse(
      readFileSync(join(repoDir, 'apps/web/package.json'), 'utf8'),
    );
    const webScripts = isRecord(webPkg) ? webPkg['scripts'] : undefined;
    expect(isRecord(webScripts) ? webScripts['routes:gen'] : undefined).toBe(
      'node scripts/routes-gen.ts',
    );
  });
});

describe('интеграция: чекер на реальном workspace', () => {
  it('exit 0, committed-файл не тронут (генерация во временный файл)', () => {
    const committedPath = join(repoDir, 'apps/web/src/routeTree.gen.ts');
    const before = readFileSync(committedPath, 'utf8');
    const result = spawnSync(process.execPath, [checker], { encoding: 'utf8', timeout: 60_000 });
    if (result.error !== undefined) {
      throw result.error;
    }
    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('routetree: ok');
    expect(readFileSync(committedPath, 'utf8')).toBe(before);
  });
});
