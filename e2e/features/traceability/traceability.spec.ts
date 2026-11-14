import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { expect, test } from '../../fixtures.ts';

// Гейт трассировки критериев приёмки (C8, З1 — детерминированное проверяет
// гейт). Планы: e2e/specs/<feature>.md, критерий — строка `- **AC-<n>**: текст`;
// тест ссылается на критерий тегом `[AC-<n>]` в заголовке, тег стоит перед
// `@critical`. Проверка двусторонняя и покомпонентная: ref резолвится только
// против плана своей фичи (каталог e2e/features/<f>/ ↔ e2e/specs/<f>.md),
// кросс-фичевые ссылки — ошибка. Гейт живёт в e2e-контуры (`pnpm e2e`,
// `pnpm verify --full`), в быстром `pnpm verify` его нет: шаг в tools/ и
// другой проект Playwright потребовали бы защищённых путей.
//
// Парсинг построчный, по образцу tools/check-test-integrity.ts: перенос
// строки внутри объявления теста ускользает. Против дрейфа regex — сверка
// числа объявлений test с числом распознанных заголовков и числа
// строк-критериев плана с числом уникальных id: частично невидимый тест или
// дубликат id красят прогон (чинить надо regex гейта, а не проверку).
// Смысловую адекватность тега гейт не проверяет (что тест реально покрывает
// критерий) — это остаётся за ревьюерами.

const E2E_DIR = resolve(import.meta.dirname, '../..');
const SPECS_DIR = join(E2E_DIR, 'specs');
const FEATURES_DIR = join(E2E_DIR, 'features');
const REPORT_PATH = resolve(E2E_DIR, '../reports/spec-traceability.md');

const CRITERION_RE = /^-\s*\*\*(AC-\d+)\*\*:\s*(.+)$/;
const TITLE_RE = /^\s*test\(\s*(['"])((?:(?!\1).)+)\1/;
const AC_REF_RE = /\[(AC-\d+)\]/g;

function escapeCell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

/** Критерии плана фичи: id → текст; пустой план и дубликат id — ошибка формата. */
function readCriteria(feature: string): Map<string, string> {
  const criteria = new Map<string, string>();
  const lines = readFileSync(join(SPECS_DIR, `${feature}.md`), 'utf8').split('\n');
  let declared = 0;
  for (const line of lines) {
    const match = CRITERION_RE.exec(line);
    if (match?.[1] && match[2]) {
      declared += 1;
      criteria.set(match[1], match[2]);
    }
  }
  expect(
    declared,
    `${feature}.md: не распознано ни одного критерия «- **AC-n**: …» — план пуст или формат дрейфовал`,
  ).toBeGreaterThan(0);
  expect(
    declared,
    `${feature}.md: дублирующийся AC-id — строк-критериев ${declared}, уникальных id ${criteria.size}`,
  ).toBe(criteria.size);
  return criteria;
}

/** Заголовки test(...) каждого spec-файла фичи, с защитой от дрейфа парсера. */
function readTestTitles(feature: string): string[] {
  const titles: string[] = [];
  const dir = join(FEATURES_DIR, feature);
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.spec.ts'))
    .toSorted();
  for (const name of files) {
    const file = join(dir, name);
    const lines = readFileSync(file, 'utf8').split('\n');
    const declared = lines.filter((line) => /^\s*test\(/.test(line)).length;
    const before = titles.length;
    for (const line of lines) {
      const match = TITLE_RE.exec(line);
      if (match?.[2]) {
        titles.push(`${name} › ${match[2]}`);
      }
    }
    const recognized = titles.length - before;
    expect(
      recognized,
      `${relative(E2E_DIR, file)}: ни одного test(...) не распознано — дрейф парсера гейта, чини regex гейта, а не гейт`,
    ).toBeGreaterThan(0);
    expect(
      declared,
      `${relative(E2E_DIR, file)}: строк test( — ${declared}, распознано заголовков — ${recognized}: часть тестов невидима гейту (перенос заголовка на другую строку?) — чини regex гейта, а не гейт`,
    ).toBe(recognized);
  }
  return titles;
}

// Заголовок держится в одну строку: парсер гейта построчный (ограничение
// задокументировано выше), многострочный test( он не увидит.
test('criteria trace to tests both ways, report generated [AC-1] [AC-2] [AC-3] [AC-4]', async () => {
  const features = readdirSync(FEATURES_DIR)
    .filter((name) => statSync(join(FEATURES_DIR, name)).isDirectory())
    .toSorted();

  // AC-4: планы и каталоги фич соответствуют 1:1, гейт не пустой.
  for (const feature of features) {
    expect(
      existsSync(join(SPECS_DIR, `${feature}.md`)),
      `у фичи «${feature}» нет плана e2e/specs/${feature}.md — новый каталог e2e/features/ приходит вместе с планом`,
    ).toBe(true);
  }
  const plans = readdirSync(SPECS_DIR)
    .filter((name) => name.endsWith('.md') && name !== 'README.md')
    .toSorted();
  expect(
    plans,
    'планы без каталога фичи: e2e/specs/<f>.md должен соответствовать e2e/features/<f>/',
  ).toEqual(features.map((feature) => `${feature}.md`));
  expect(
    features.length,
    'гейт трассировки пуст: нет ни одной фичи с планом — проверка проходит вакуумно',
  ).toBeGreaterThan(0);

  const report = [
    '# Spec traceability',
    '',
    'Сгенерировано e2e/features/traceability/traceability.spec.ts — в PR вставляется как есть, руками не заполняется.',
    '',
    '| Фича | Критерий | Тесты |',
    '| ---- | -------- | ----- |',
  ];
  let traced = 0;

  for (const feature of features) {
    const criteria = readCriteria(feature);
    const titles = readTestTitles(feature);
    const refsByTest = titles.map((title) => ({
      title,
      refs: [...title.matchAll(AC_REF_RE)].flatMap((match) => (match[1] ? [match[1]] : [])),
    }));

    for (const [id, text] of criteria) {
      const covering = refsByTest
        .filter((entry) => entry.refs.includes(id))
        .map((entry) => entry.title);
      // AC-1: у каждого критерия есть хотя бы один тест.
      expect(
        covering.length,
        `критерий ${feature}/${id} («${text}») не покрыт ни одним e2e-тестом — добавь тест с [${id}] в заголовке`,
      ).toBeGreaterThan(0);
      traced += 1;
      report.push(
        `| ${escapeCell(feature)} | ${escapeCell(`${id} ${text}`)} | ${covering.map(escapeCell).join('<br>')} |`,
      );
    }

    // AC-2: каждая ссылка теста существует в плане его же фичи.
    for (const { title, refs } of refsByTest) {
      const unknown = refs.filter((ref) => !criteria.has(ref));
      expect(
        unknown,
        `в «${title}» ссылки не из плана ${feature}.md: ${unknown.join(', ')} — тег ссылается на критерий чужой или несуществующей фичи`,
      ).toEqual([]);
    }
  }

  writeFileSync(REPORT_PATH, `${report.join('\n')}\n`);
  // AC-3: таблица «критерий → тесты» сгенерирована и в ней есть строка на
  // каждый критерий каждой фичи, а не только на первые.
  const written = readFileSync(REPORT_PATH, 'utf8');
  expect(
    written.split('\n').filter((line) => /^\| [a-z]/.test(line)).length,
    `${relative(E2E_DIR, REPORT_PATH)}: строк данных в таблице не равно числу критериев (${traced})`,
  ).toBe(traced);
});
