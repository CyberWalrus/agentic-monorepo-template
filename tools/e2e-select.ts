/**
 * Выбор E2E-тестов по фичам (B4.1, vision «E2E затронутых фич»).
 *
 * Изменение в `apps/web/src/features/<f>/` или `e2e/features/<f>/` запускает
 * только `e2e/features/<f>/`; любой другой путь (packages, apps/api, src/lib,
 * корневые конфиги, e2e вне фич-каталогов) — всё. Пустой дифф и любая
 * неразборчивая ситуация — всё: эвристика ошибается только в сторону
 * «запустить больше». Полноту страхуют merge queue и push/nightly: там
 * `E2E_FEATURES` не выставляется и гоняется весь проект functional.
 *
 * CLI: `node tools/e2e-select.ts --from-stdin` (изменённые пути построчно)
 * или `node tools/e2e-select.ts <path>…`; печатает `all` или список фич
 * через запятую — значение для env `E2E_FEATURES` в CI (job e2e). CI диффует
 * с `--no-renames`: переименование между фичами отдаёт оба пути, старая фича
 * тоже попадает в прогон (инвариант «ошибаться только в сторону больше»).
 *
 * «@critical идут всегда»: конфиг Playwright не игнорирует каталог незаданной
 * фичи, если в его исходниках есть литерал `@critical` — файл гоняется целиком
 * (перебор внутри файла разрешён правилом «больше»).
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const APP_FEATURE_RE = /^apps\/web\/src\/features\/([^/]+)(?:\/|$)/;
const E2E_FEATURE_RE = /^e2e\/features\/([^/]+)(?:\/|$)/;

export interface E2eSelection {
  mode: 'all' | 'subset';
  features: string[];
}

const ALL: E2eSelection = { mode: 'all', features: [] };

function repoRoot(): string {
  return resolve(import.meta.dirname, '..');
}

/**
 * Имя фичи: только lowercase-буквы, цифры и дефис (L1-ревью: произвольное имя
 * каталога — это glob в testIgnore; метасимволы в имени позволили бы отсечь
 * чужие файлы). Иное имя — не фича: выбор уходит в «всё» (fail-safe).
 */
const FEATURE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export function isFeatureName(name: string): boolean {
  return FEATURE_NAME_RE.test(name);
}

/** Каталоги фич в e2e/features: фича содержит хотя бы один *.spec.ts или *.visual.ts. */
export function e2eFeatureDirs(root: string = repoRoot()): string[] {
  const dir = join(root, 'e2e', 'features');
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => !name.startsWith('.') && isFeatureName(name) && isRealDir(join(dir, name)))
    .filter((name) => hasTestSource(join(dir, name)));
}

/** Каталог, а не симлинк (L2-ревью: симлинк-фича — вектор спуфинга выбора). */
function isRealDir(path: string): boolean {
  return lstatSync(path).isDirectory();
}

/** Рекурсивно: есть ли *.spec.ts или *.visual.ts (helpers без тестов — не фича, L2). */
function hasTestSource(dir: string): boolean {
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && /\.(spec|visual)\.ts$/.test(entry.name)) {
      return true;
    }
  }
  return false;
}

/**
 * Чистый выбор: какие фичи гонять по списку изменённых файлов.
 * knownE2eFeatures — существующие каталоги e2e/features: app-фича без своего
 * e2e-каталога — новая поверхность продукта, гоняем всё (fail-safe), пока у
 * неё не появились собственные E2E.
 */
export function selectE2eFeatures(
  changedFiles: string[],
  knownE2eFeatures: string[],
): E2eSelection {
  const selected = new Set<string>();
  const appFeatures = new Set<string>();
  for (const raw of changedFiles) {
    const file = raw.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '');
    if (file === '') {
      continue;
    }
    const app = APP_FEATURE_RE.exec(file);
    if (app?.[1] !== undefined) {
      // Имя вне чарсета — не признанная фича (L1): неизвестная поверхность — всё.
      if (!isFeatureName(app[1])) {
        return ALL;
      }
      selected.add(app[1]);
      appFeatures.add(app[1]);
      continue;
    }
    const e2e = E2E_FEATURE_RE.exec(file);
    if (e2e?.[1] !== undefined) {
      // Не-фича под e2e/features (helpers, симлинк, имя вне чарсета) — общая
      // кодовая база E2E: её изменение может затронуть любую фичу — гоняем всё.
      if (!knownE2eFeatures.includes(e2e[1])) {
        return ALL;
      }
      selected.add(e2e[1]);
      continue;
    }
    return ALL;
  }
  if (selected.size === 0) {
    return ALL;
  }
  for (const feature of appFeatures) {
    if (!knownE2eFeatures.includes(feature)) {
      return ALL;
    }
  }
  return { mode: 'subset', features: [...selected].toSorted() };
}

/** Значение env `E2E_FEATURES` из CI → выбор. Мусор и пустота — всё (fail-safe). */
export function parseE2eFeaturesEnv(
  value: string | undefined,
  knownE2eFeatures: string[],
): E2eSelection {
  if (value === undefined || value === '' || value === 'all') {
    return ALL;
  }
  const features = value
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  if (features.length === 0 || features.some((name) => !knownE2eFeatures.includes(name))) {
    return ALL;
  }
  return { mode: 'subset', features: [...new Set(features)].toSorted() };
}

/** Каталоги фич продукта apps/web/src/features: имена каталогов. */
export function appFeatureDirs(root: string = repoRoot()): string[] {
  const dir = join(root, 'apps', 'web', 'src', 'features');
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir).filter(
    (name) => !name.startsWith('.') && isFeatureName(name) && isRealDir(join(dir, name)),
  );
}

/**
 * testIgnore проекта functional. Инвариант «ошибаться только в сторону
 * больше» (B4.1): (1) e2e-фича БЕЗ одноимённой app-фичи — сквозная (a11y,
 * route-states проверяют весь интерфейс) — не игнорируется никогда, гоняется
 * в каждом PR; (2) незаданная фича с app-каталогом отдаёт в игнор свои
 * НЕКРИТИЧНЫЕ файлы по отдельности; файлы с литералом `@critical` (в том
 * числе ложные срабатывания на комментарии — перебор в сторону «больше»)
 * гоняются всегда. Пути относительно testDir конфига (e2e/).
 */
export function functionalTestIgnore(
  root: string,
  selected: string[],
  appFeatures: string[] = appFeatureDirs(root),
): string[] {
  const ignore: string[] = [];
  const e2eRoot = join(root, 'e2e');
  for (const feature of e2eFeatureDirs(root)) {
    if (selected.includes(feature) || !appFeatures.includes(feature)) {
      // Заданная фича или сквозная — гоняется целиком.
      continue;
    }
    const dir = join(e2eRoot, 'features', feature);
    const criticalFiles = tsFilesWithCritical(dir);
    if (criticalFiles.length === 0) {
      ignore.push(`features/${feature}/**`);
      continue;
    }
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) {
        continue;
      }
      const full = join(entry.parentPath, entry.name);
      if (criticalFiles.includes(full)) {
        continue;
      }
      // relative(e2eRoot, full) уже даёт 'features/<f>/<файл>' (testDir — e2e/).
      ignore.push(relative(e2eRoot, full).replaceAll('\\', '/'));
    }
  }
  // readdirSync не сортирует: детерминированный порядок для отчёта и тестов.
  return ignore.toSorted();
}

function tsFilesWithCritical(dir: string): string[] {
  const hits: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) {
      continue;
    }
    const full = join(entry.parentPath, entry.name);
    if (readFileSync(full, 'utf8').includes('@critical')) {
      hits.push(full);
    }
  }
  return hits;
}

function cli(): void {
  const args = process.argv.slice(2);
  const files =
    args[0] === '--from-stdin'
      ? readFileSync(0, 'utf8').split('\n').filter(Boolean)
      : args.filter((arg) => arg !== '--from-stdin');
  const selection = selectE2eFeatures(files, e2eFeatureDirs());
  console.log(selection.mode === 'all' ? 'all' : selection.features.join(','));
}

// CLI-режим: скрипт запущен как процесс (не импортирован конфигом, тестами
// или канарейками — они заходят через export). import.meta.filename может
// отсутствовать под loader-ом Playwright — тогда модуль только импортируется.
const thisFile = typeof import.meta.filename === 'string' ? resolve(import.meta.filename) : null;
if (thisFile !== null && process.argv[1] !== undefined && resolve(process.argv[1]) === thisFile) {
  cli();
}
