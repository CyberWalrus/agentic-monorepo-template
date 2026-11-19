/**
 * Проверка копии шаблона (канарейка копии, d8.3; ADR 0008, «Проверка»).
 * Чистая логика без copier, две стороны. Шаблонная (checkTemplateSide — раннер
 * гоняет её ДО `copier copy`, детект раньше исполнения, ревью security):
 * copier.yml без _tasks/_migrations (они исполняют команды на машине человека;
 * regex снимает кавычки ключей — квотированный ключ YAML парсится так же),
 * пара docs/CODEOWNERS ↔ .github/CODEOWNERS.jinja синхронна с точностью до
 * владельца. Сторона копии (checkCopySide — после копирования): каркас и объём
 * (без --vcs-ref copier молча создаёт пустую копию и выходит с кодом 0 — журнал
 * d8), отсутствие файлов разработки и имени владельца шаблона (whitelist —
 * только строка _src_path в .copier-answers.yml, d8.2), симлинков быть не
 * должно, снимки ruleset, рендер CODEOWNERS и сохранённые ответы (_commit).
 * Логика канареечна в tools/test/template-copy.test.ts; запускает её
 * tools/run-template-copy-canary.ts — CI и человек (З5-исключение: copier
 * из PyPI вне allowlist доменов песочницы, ADR 0004).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface TemplateCopyFailure {
  check: string;
  detail: string;
}

export interface TemplateCopyReport {
  ok: boolean;
  failures: TemplateCopyFailure[];
}

/**
 * Файлы разработки шаблона, которых в копии быть не должно. Производный от
 * `_exclude` copier.yml список: дрейф пары ловит wiring-тест в
 * tools/test/template-copy.test.ts (образец — «рассинхрон З10-пары»).
 */
export const FORBIDDEN_IN_COPY = [
  'docs/roadmap.md',
  'docs/research',
  'backlog',
  'docs/template-state.md',
  'docs/CODEOWNERS',
  'copier.yml',
  'copier.yaml',
  '.github/CODEOWNERS.jinja',
] as const;

/** Каркас копии: без него копия неполная, даже если файлов формально много. */
const REQUIRED_IN_COPY = [
  'package.json',
  'pnpm-workspace.yaml',
  'turbo.json',
  'AGENTS.md',
  '.copier-answers.yml',
  '.github/workflows/ci.yml',
  '.github/CODEOWNERS',
  'apps/api/package.json',
  'apps/web/package.json',
  'packages/contracts/package.json',
  'packages/ui/package.json',
] as const;

/**
 * Минимальный объём копии. Проба d8.2: 244 файла. Порог сознательно ниже —
 * отсекает пустую копию от сломанного --vcs-ref (единицы файлов) и обвал;
 * частичный рендер с сохранившимся объёмом подстраховывают required-файлы и
 * снимки ruleset. Порог рядом с фактом двигает человек (З7).
 */
const MIN_COPY_FILES = 100;

/**
 * Все файлы копии рекурсивно. Обход идёт по всему содержимому, включая
 * скрытые пути (в копии есть .github, .copier-answers.yml) — пропуск скрытых
 * сломал бы owner-скан и forbidden-чеки. Симлинки не файлы: собираются
 * отдельно, в копии их быть не должно.
 */
export function walkFiles(root: string): { files: string[]; symlinks: string[] } {
  const files: string[] = [];
  const symlinks: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        symlinks.push(full);
      } else if (entry.isDirectory()) {
        visit(full);
      } else if (entry.isFile()) {
        files.push(full);
      } else if (statSync(full).isDirectory()) {
        visit(full);
      } else {
        files.push(full);
      }
    }
  };
  visit(root);
  return { files, symlinks };
}

/** Владелец из строки `*` CODEOWNERS — источник для генерических проверок (d8.3). */
export function readOwner(codeownersText: string): string | null {
  return /^\*\s+(@\S+)\s*$/m.exec(codeownersText)?.[1] ?? null;
}

/** Рендер шаблона CODEOWNERS: единственная подстановка — владелец (d8.2). */
export function renderCodeowners(jinjaText: string, owner: string): string {
  return jinjaText.replaceAll('{{ repo_owner }}', owner);
}

/** Шаблонная сторона: гоняется до copier copy (детект раньше исполнения). */
export function checkTemplateSide(templateRoot: string): TemplateCopyFailure[] {
  const failures: TemplateCopyFailure[] = [];
  const fail = (check: string, detail: string): void => {
    failures.push({ check, detail });
  };

  const copierYml = readFileSync(join(templateRoot, 'copier.yml'), 'utf8');
  for (const key of ['_tasks', '_migrations']) {
    // Кавычки ключа сняты: "_tasks": парсится YAML-ом в тот же ключ
    // (ревью security). Остаточная поверхность — flow-стиль `{_tasks: …}`:
    // copier требует блочные вопросы, flow-документ не валиден для него.
    if (new RegExp(`^['"]?${key}['"]?\\s*:`, 'm').test(copierYml)) {
      fail(
        'copier.yml',
        `запрещённый ключ ${key}: copier исполняет команды на машине человека (ADR 0008)`,
      );
    }
  }

  const templateCodeowners = readFileSync(join(templateRoot, 'docs/CODEOWNERS'), 'utf8');
  const jinja = readFileSync(join(templateRoot, '.github/CODEOWNERS.jinja'), 'utf8');
  const templateOwner = readOwner(templateCodeowners);
  if (templateOwner === null) {
    fail(
      'CODEOWNERS',
      'в docs/CODEOWNERS шаблона нет строки «* @владелец» — владелец для проверок не извлекается',
    );
  } else if (renderCodeowners(jinja, templateOwner) !== templateCodeowners) {
    fail(
      'CODEOWNERS',
      'docs/CODEOWNERS расходится с .github/CODEOWNERS.jinja при подстановке владельца шаблона — пара рассинхронизирована',
    );
  }
  return failures;
}

/** Сторона копии: гоняется после copier copy. */
export function checkCopySide(templateRoot: string, copyRoot: string): TemplateCopyFailure[] {
  const failures: TemplateCopyFailure[] = [];
  const fail = (check: string, detail: string): void => {
    failures.push({ check, detail });
  };

  const templateCodeowners = readFileSync(join(templateRoot, 'docs/CODEOWNERS'), 'utf8');
  const jinja = readFileSync(join(templateRoot, '.github/CODEOWNERS.jinja'), 'utf8');
  const templateOwner = readOwner(templateCodeowners);

  const { files: copyFiles, symlinks } = walkFiles(copyRoot);
  const relOf = (full: string): string => full.slice(copyRoot.length + 1);
  const relPaths = new Set(copyFiles.map(relOf));

  for (const symlink of symlinks) {
    fail('копия', `в копии симлинк (быть не должно): ${relOf(symlink)}`);
  }

  if (copyFiles.length < MIN_COPY_FILES) {
    fail(
      'копия',
      `копия пуста или неполная: ${copyFiles.length} файлов, ожидалось >= ${MIN_COPY_FILES}`,
    );
  }
  for (const required of REQUIRED_IN_COPY) {
    if (!relPaths.has(required)) {
      fail('копия', `в копии нет обязательного файла ${required}`);
    }
  }

  for (const forbidden of FORBIDDEN_IN_COPY) {
    const leaked = [...relPaths].some((p) => p === forbidden || p.startsWith(`${forbidden}/`));
    if (leaked) {
      fail('копия', `в копию попал файл разработки шаблона: ${forbidden}`);
    }
  }

  const answersPath = join(copyRoot, '.copier-answers.yml');
  if (existsSync(answersPath) && !readFileSync(answersPath, 'utf8').includes('_commit')) {
    fail(
      'ответы',
      '.copier-answers.yml без _commit — copier update не привяжется к версии шаблона',
    );
  }

  // Снимки ruleset — generic-проверка по списку шаблона: чрезмерный _exclude
  // не уберёт их молча (d8.3). copier рендерит *.jinja и отрезает суффикс
  // (как CODEOWNERS.jinja → CODEOWNERS), поэтому .jinja-снимок ищется в копии
  // под именем без суффикса и сравнивать его байт в байт нельзя.
  const rulesetsDir = join(templateRoot, '.github/rulesets');
  if (existsSync(rulesetsDir)) {
    for (const entry of readdirSync(rulesetsDir, { withFileTypes: true })) {
      if (!entry.isFile()) {
        continue;
      }
      const isRendered = entry.name.endsWith('.jinja');
      const copyName = isRendered ? entry.name.slice(0, -'.jinja'.length) : entry.name;
      const rel = join('.github/rulesets', copyName);
      const copyPath = join(copyRoot, rel);
      if (!existsSync(copyPath)) {
        fail('rulesets', `снимок ruleset отсутствует в копии: ${rel}`);
        continue;
      }
      if (
        !isRendered &&
        readFileSync(copyPath, 'utf8') !== readFileSync(join(rulesetsDir, entry.name), 'utf8')
      ) {
        fail('rulesets', `снимок ruleset изменился при копировании: ${rel}`);
      }
    }
  }

  // Владелец шаблона не должен утечь ни в один файл копии. В .copier-answers.yml
  // легитимный носитель — только значение _src_path (d8.2): из скана исключается
  // строка с ним, остальные строки файла сканируются как остальные.
  if (templateOwner !== null) {
    for (const full of copyFiles) {
      const rel = relOf(full);
      const text = readFileSync(full, 'utf8');
      const chunks =
        rel === '.copier-answers.yml'
          ? text.split('\n').filter((line) => !line.includes('_src_path'))
          : [text];
      if (chunks.some((chunk) => chunk.includes(templateOwner))) {
        fail('владелец', `имя владельца шаблона (${templateOwner}) утекло в копию: ${rel}`);
      }
    }
  }

  // Рендер CODEOWNERS в копии: jinja шаблона с владельцем КОПИИ совпадает
  // с .github/CODEOWNERS копии байт в байт — расхождение источников красит.
  const copyCodeownersPath = join(copyRoot, '.github/CODEOWNERS');
  if (existsSync(copyCodeownersPath)) {
    const copyCodeowners = readFileSync(copyCodeownersPath, 'utf8');
    const copyOwner = readOwner(copyCodeowners);
    if (copyOwner === null) {
      fail('CODEOWNERS', 'в .github/CODEOWNERS копии нет строки «* @владелец»');
    } else if (renderCodeowners(jinja, copyOwner) !== copyCodeowners) {
      fail(
        'CODEOWNERS',
        '.github/CODEOWNERS копии расходится с .github/CODEOWNERS.jinja при подстановке владельца копии',
      );
    }
  }
  return failures;
}

export function checkTemplateCopy(templateRoot: string, copyRoot: string): TemplateCopyReport {
  const failures = [...checkTemplateSide(templateRoot), ...checkCopySide(templateRoot, copyRoot)];
  return { ok: failures.length === 0, failures };
}
