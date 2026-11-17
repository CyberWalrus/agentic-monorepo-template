/**
 * Чекер выбора E2E по фичам (B4.1): чистая функция selectE2eFeatures канареечна
 * на уровне чекера (З6) — опасные направления (своя фича не запустилась, чужие
 * некритичные тесты не отсечены, мусор в env → не «всё») пинятся здесь; проводку
 * конфига держит тест-привязка внизу файла + канарейка в gate-canaries.ts.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  e2eFeatureDirs,
  functionalTestIgnore,
  parseE2eFeaturesEnv,
  selectE2eFeatures,
} from '../e2e-select.ts';

const ALL = { mode: 'all', features: [] } as const;

describe('selectE2eFeatures', () => {
  const known = ['tasks', 'a11y', 'api-origin', 'route-states', 'traceability'];

  it('изменение app-фичи запускает только её e2e-фичу', () => {
    expect(selectE2eFeatures(['apps/web/src/features/tasks/use-tasks.ts'], known)).toEqual({
      mode: 'subset',
      features: ['tasks'],
    });
  });

  it('изменение e2e-файла фичи запускает её фичу', () => {
    expect(selectE2eFeatures(['e2e/features/a11y/a11y.spec.ts'], known)).toEqual({
      mode: 'subset',
      features: ['a11y'],
    });
  });

  it('две фичи — обе, отсортированные', () => {
    expect(
      selectE2eFeatures(
        ['apps/web/src/features/tasks/x.ts', 'e2e/features/api-origin/y.spec.ts'],
        known,
      ),
    ).toEqual({ mode: 'subset', features: ['api-origin', 'tasks'] });
  });

  it('packages, apps/api, src/lib, конфиги, e2e-фикстуры — всё', () => {
    const everything = [
      'packages/contracts/src/tasks.ts',
      'apps/api/src/app.ts',
      'apps/web/src/lib/api-client.ts',
      'apps/web/vite.config.ts',
      'e2e/fixtures.ts',
      'e2e/perf/tasks.perf.ts',
      'tools/ports.ts',
      'package.json',
      'turbo.json',
      '.github/workflows/ci.yml',
    ];
    for (const file of everything) {
      expect(selectE2eFeatures([file], known)).toEqual(ALL);
    }
  });

  it('пустой дифф и пустые пути — всё (fail-safe)', () => {
    expect(selectE2eFeatures([], known)).toEqual(ALL);
    expect(selectE2eFeatures(['', '  '], known)).toEqual(ALL);
  });

  it('app-фича без e2e-каталога — всё: новая поверхность, полный прогон', () => {
    expect(selectE2eFeatures(['apps/web/src/features/new-thing/page.tsx'], known)).toEqual(ALL);
  });

  it('e2e-фича без app-каталога — подмножество (её и запускаем)', () => {
    expect(selectE2eFeatures(['e2e/features/traceability/x.spec.ts'], known)).toEqual({
      mode: 'subset',
      features: ['traceability'],
    });
  });

  it('не-фича под e2e/features (helpers) — общая кодовая база E2E: всё', () => {
    expect(selectE2eFeatures(['e2e/features/helpers/util.ts'], known)).toEqual(ALL);
  });

  it('переименование между фичами: обе стороны пути выбирают обе фичи (M4, CI диффует с --no-renames)', () => {
    expect(
      selectE2eFeatures(
        ['apps/web/src/features/a11y/new.ts', 'apps/web/src/features/tasks/old.ts'],
        known,
      ),
    ).toEqual({ mode: 'subset', features: ['a11y', 'tasks'] });
  });

  it('имя фичи вне чарсета (L1) — не признанная фича: всё', () => {
    for (const name of ['a11?', 'evil{a,b}', '../escape', 'has space']) {
      expect(selectE2eFeatures([`apps/web/src/features/${name}/x.ts`], known)).toEqual(ALL);
    }
  });

  it('windows-разделители и ./ префикс нормализуются', () => {
    expect(selectE2eFeatures(['.\\apps\\web\\src\\features\\tasks\\a.ts'], known)).toEqual({
      mode: 'subset',
      features: ['tasks'],
    });
  });
});

describe('parseE2eFeaturesEnv', () => {
  const known = ['tasks', 'a11y'];

  it('пусто/undefined/all — всё', () => {
    expect(parseE2eFeaturesEnv(undefined, known)).toEqual(ALL);
    expect(parseE2eFeaturesEnv('', known)).toEqual(ALL);
    expect(parseE2eFeaturesEnv('all', known)).toEqual(ALL);
  });

  it('список — подмножество, дубли и пробелы съедаются', () => {
    expect(parseE2eFeaturesEnv(' tasks , tasks ,a11y ', known)).toEqual({
      mode: 'subset',
      features: ['a11y', 'tasks'],
    });
  });

  it('неизвестная фича — всё (fail-safe, мусор в env не сужает прогон)', () => {
    expect(parseE2eFeaturesEnv('tasks,evil', known)).toEqual(ALL);
  });
});

describe('functionalTestIgnore (на фикстурном дереве)', () => {
  let root = '';

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('незаданная фича без @critical — каталог в игнор; с @critical — только некритичные файлы', () => {
    root = join(mkdtempSync(join(tmpdir(), 'e2e-select-')), 'repo');
    for (const feature of ['alpha', 'beta']) {
      mkdirSync(join(root, 'e2e', 'features', feature), { recursive: true });
      writeFileSync(
        join(root, 'e2e', 'features', feature, 'plain.spec.ts'),
        "test('x', () => {});\n",
      );
    }
    // alpha: критичный и некритичный файлы — игнорируется только некритичный.
    writeFileSync(
      join(root, 'e2e', 'features', 'alpha', 'crit.spec.ts'),
      "test('crit @critical', () => {});\n",
    );
    const appFeatures = ['alpha', 'beta'];
    expect(functionalTestIgnore(root, ['tasks'], appFeatures)).toEqual([
      'features/alpha/plain.spec.ts',
      'features/beta/**',
    ]);
    // Заданная фича не отдаёт ничего; незаданная alpha — только некритичный файл.
    expect(functionalTestIgnore(root, ['beta'], appFeatures)).toEqual([
      'features/alpha/plain.spec.ts',
    ]);
    expect(functionalTestIgnore(root, ['alpha', 'beta'], appFeatures)).toEqual([]);
    // Литеральный контракт (L1): упоминание @critical даже в комментарии делает
    // файл критичным — направление безопасное (тест гоняется всегда). alpha
    // выбрана и не отдаёт ничего; незаданная beta отдаёт только свой
    // некритичный файл, «критичный по комментарию» гоняется.
    writeFileSync(
      join(root, 'e2e', 'features', 'beta', 'talks-about-it.spec.ts'),
      "// см. правило @critical в docs\ntest('plain', () => {});\n",
    );
    expect(functionalTestIgnore(root, ['alpha'], appFeatures)).toEqual([
      'features/beta/plain.spec.ts',
    ]);
  });

  it('сквозная e2e-фича (без app-каталога) не игнорируется никогда (H1)', () => {
    root = join(mkdtempSync(join(tmpdir(), 'e2e-select-')), 'repo');
    mkdirSync(join(root, 'e2e', 'features', 'own'), { recursive: true });
    mkdirSync(join(root, 'e2e', 'features', 'crosscut'), { recursive: true });
    writeFileSync(join(root, 'e2e', 'features', 'own', 'plain.spec.ts'), "test('x', () => {});\n");
    writeFileSync(
      join(root, 'e2e', 'features', 'crosscut', 'a11y.spec.ts'),
      "test('y', () => {});\n",
    );
    // crosscut не имеет app-каталога: PR на tasks его не отсекает.
    expect(functionalTestIgnore(root, ['own'], ['own'])).toEqual([]);
    // own — с app-каталогом и незаданная — игнорируется целиком.
    expect(functionalTestIgnore(root, ['crosscut'], ['own'])).toEqual(['features/own/**']);
  });

  it('вложенный @critical-файл не игнорируется, некритичные отдаются пофайлово', () => {
    root = join(mkdtempSync(join(tmpdir(), 'e2e-select-')), 'repo');
    mkdirSync(join(root, 'e2e', 'features', 'deep', 'nested'), { recursive: true });
    writeFileSync(join(root, 'e2e', 'features', 'deep', 'a.spec.ts'), "test('a', () => {});\n");
    writeFileSync(
      join(root, 'e2e', 'features', 'deep', 'nested', 'b.spec.ts'),
      "test('b @critical', () => {});\n",
    );
    expect(functionalTestIgnore(root, [], ['deep'])).toEqual(['features/deep/a.spec.ts']);
  });

  it('каталог без *.spec.ts и *.visual.ts — не фича (L2): в известные фичи не попадает', () => {
    root = join(mkdtempSync(join(tmpdir(), 'e2e-select-')), 'repo');
    mkdirSync(join(root, 'e2e', 'features', 'real', 'nested'), { recursive: true });
    writeFileSync(join(root, 'e2e', 'features', 'real', 'a.spec.ts'), "test('a', () => {});\n");
    mkdirSync(join(root, 'e2e', 'features', 'helpers'), { recursive: true });
    writeFileSync(join(root, 'e2e', 'features', 'helpers', 'util.ts'), 'export const x = 1;\n');
    mkdirSync(join(root, 'e2e', 'features', 'empty'), { recursive: true });
    expect(e2eFeatureDirs(root)).toEqual(['real']);
  });

  it('симлинк-каталог — не фича (L2-ревью, security): выбор уходит в «всё»', () => {
    root = join(mkdtempSync(join(tmpdir(), 'e2e-select-')), 'repo');
    mkdirSync(join(root, 'e2e', 'features', 'real'), { recursive: true });
    writeFileSync(join(root, 'e2e', 'features', 'real', 'a.spec.ts'), "test('a', () => {});\n");
    mkdirSync(join(root, 'apps', 'web', 'src', 'features', 'tasks'), { recursive: true });
    symlinkSync(join(root, 'e2e', 'features', 'real'), join(root, 'e2e', 'features', 'tasks2'));
    // tasks2 — симлинк: не фича; изменение по его пути — неизвестная поверхность.
    expect(e2eFeatureDirs(root)).toEqual(['real']);
    expect(selectE2eFeatures(['e2e/features/tasks2/a.spec.ts'], e2eFeatureDirs(root))).toEqual(ALL);
  });

  it('на живом репозитории игнорируется только фича с app-каталогом (tasks)', () => {
    const repoRoot = resolve(import.meta.dirname, '../..');
    // Задача tasks: сквозные (a11y, api-origin, route-states, traceability)
    // не попадают в игнор ни при каком выборе (H1).
    expect(
      functionalTestIgnore(repoRoot, [], ['tasks']).every((path) =>
        path.startsWith('features/tasks/'),
      ),
    ).toBe(true);
    expect(functionalTestIgnore(repoRoot, ['tasks'])).toEqual([]);
  });

  it('e2eFeatureDirs на живом репозитории видит пять фич', () => {
    const dirs = e2eFeatureDirs(resolve(import.meta.dirname, '../..'));
    expect(dirs).toContain('tasks');
    expect(dirs).toContain('a11y');
  });

  it('проводка: конфиг Playwright держит выбор E2E (срыв — канарейка gate-canaries)', () => {
    const config = readFileSync(
      resolve(import.meta.dirname, '../../e2e/playwright.config.ts'),
      'utf8',
    );
    // Короткие ассерты (урок канарейки прокси): toContain на большом конфиге
    // печатает дифф на сотни строк, название теста вылетает из хвоста вывода
    // verify, и expect канарейки не находит якорь-заголовок.
    expect(config.includes("from '../tools/e2e-select.ts'")).toBe(true);
    expect(config.includes("parseE2eFeaturesEnv(process.env['E2E_FEATURES']")).toBe(true);
    expect(config.includes('testIgnore: e2eIgnore')).toBe(true);
  });
});
