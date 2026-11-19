/**
 * Гейт класса защиты `tools/` (ADR 0014, задача e9): замыкание гейт-контурa
 * вычисляется структурным выводом входных точек и обязано равняться `deny`
 * записям `tools/protected-paths.json` — в обе стороны.
 *
 * Входные точки (ADR 0014, «Факты»): три волны шагов tools/verify-steps.ts,
 * скрипты package.json, вызываемые контуром (verify-steps, .github/workflows,
 * lefthook.yml, хуки), прямые ссылки tools/… из workflows, каталог tools/hooks/,
 * защищённые конфиги (vitest.config.ts, e2e/playwright.config.ts) и все
 * ts-файлы e2e/. Рёбра: импорты (static), литеральные ссылки tools/…, include-
 * глобы vitest-конфигов. Комментарии срезаны: упоминание файла в комментарии —
 * не ребро.
 *
 * Гейт красит, если: (а) файл замыкания не покрыт `deny`; (б) `deny`-запись
 * внутри tools/ вне замыкания (список не гниёт ни в одну сторону); (в) шаг
 * verify ссылается на несуществующий скрипт или ссылка скрипта не резолвится.
 * Плюс инвариант fail-closed (З4): известные гейт-файлы (KNOWN_GATES ниже)
 * обязаны оказаться в замыкании — если структурный вывод сломался, расчёт
 * красный, а не пустой. KNOWN_GATES — независимый от deny список (иначе он не
 * поймал бы поломку вывода); он не второй источник правды класса, а датчик
 * целостности самого расчёта. Список `deny` читается только из
 * tools/protected-paths.json — копии класса у гейта нет (З10); новый гейт
 * обязан попасть и в замыкание (автоматически), и в KNOWN_GATES (тем же PR).
 *
 *   pnpm tool-class:check      шаг verify (fast) и job static CI
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { matchesGlob } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseProtectedPaths } from './protected-paths.ts';

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.output',
  'reports',
  'coverage',
  '.turbo',
  'test-results',
  'playwright-report',
  '.stryker-tmp',
  '.vitest',
]);

/**
 * Известные гейты (fail-closed, З4): если структурный вывод потерял хотя бы
 * один из них, замыкание неполно — расчёт красный, а не молча узкий. Для
 * синтетических деревьев тестов список передаётся опцией.
 */
const KNOWN_GATES: readonly string[] = [
  'tools/analyze-command.ts',
  'tools/backlog-board.ts',
  'tools/backlog-doctor.ts',
  'tools/check-bundle-delta.ts',
  'tools/check-bundle-gate.ts',
  'tools/check-bundle.ts',
  'tools/check-docs.ts',
  'tools/check-gate-approval.ts',
  'tools/check-protected-paths.ts',
  'tools/check-sandbox-paths.ts',
  'tools/check-template-copy.ts',
  'tools/check-test-count.ts',
  'tools/check-test-integrity.ts',
  'tools/check-test-report.ts',
  'tools/check-tool-class.ts',
  'tools/check-visual-image.ts',
  'tools/copier-version.txt',
  'tools/e2e-select.ts',
  'tools/gate-approval-core.ts',
  'tools/gate-canaries.ts',
  'tools/hooks/guard-bash.ts',
  'tools/hooks/lib.ts',
  'tools/hooks/lint-changed-file.ts',
  'tools/hooks/protect-paths.ts',
  'tools/hooks/protect-result.ts',
  'tools/hooks/session-start.ts',
  'tools/hooks/stop-verify.ts',
  'tools/instance.ts',
  'tools/measure-bundle.ts',
  'tools/perf-budgets.ts',
  'tools/perf-lock.ts',
  'tools/perf-metrics.ts',
  'tools/ports.ts',
  'tools/protected-paths.json',
  'tools/protected-paths.ts',
  'tools/run-gate-canaries.ts',
  'tools/run-template-copy-canary.ts',
  'tools/snapshot.ts',
  'tools/verify-budgets-loader.ts',
  'tools/verify-steps.ts',
  'tools/verify.ts',
  'tools/visual-guard.ts',
  'tools/visual-inner.sh',
];

/** Встроенные команды pnpm: не имена скриптов (разбор строки прерывается). */
const PNPM_BUILTINS = new Set([
  'install',
  'i',
  'add',
  'remove',
  'uninstall',
  'exec',
  'dlx',
  'test',
  'start',
  'stop',
  'why',
  'outdated',
  'update',
  'up',
  'store',
  'config',
  'rebuild',
  'link',
  'unlink',
  'pack',
  'publish',
  'list',
  'root',
  'env',
  'workspace',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const SCRIPT_NAME = /^[a-zA-Z0-9:@/._-]+$/;
const TOOL_LITERAL = /\btools\/[A-Za-z0-9_.\-/*]+/g;

export interface ToolClassInput {
  /** Корень репозитория (или синтетического дерева). */
  root: string;
  /** Fail-closed список известных гейтов; по умолчанию — настоящий. */
  knownGates?: readonly string[];
}

export interface ToolClassReport {
  problems: string[];
  /** Замыкание: относительные пути под tools/, отсортированные. */
  closure: string[];
}

// --- Комментарии ----------------------------------------------------------------

/** Срезает комментарии TS-подобного кода; содержимое строк сохраняется. */
function stripCodeComments(text: string): string {
  const out: string[] = [];
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';
  let i = 0;
  while (i < text.length) {
    const ch = text[i] ?? '';
    const next = text[i + 1] ?? '';
    if (state === 'code') {
      if (ch === '/' && next === '/') {
        state = 'line';
        i += 2;
        continue;
      }
      if (ch === '/' && next === '*') {
        state = 'block';
        i += 2;
        continue;
      }
      if (ch === "'") {
        state = 'single';
      } else if (ch === '"') {
        state = 'double';
      } else if (ch === '`') {
        state = 'template';
      }
      out.push(ch);
      i += 1;
      continue;
    }
    if (state === 'line') {
      if (ch === '\n') {
        state = 'code';
        out.push(ch);
      } else {
        out.push(' ');
      }
      i += 1;
      continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') {
        state = 'code';
        i += 2;
        continue;
      }
      out.push(ch === '\n' ? '\n' : ' ');
      i += 1;
      continue;
    }
    // Строки (single/double/template): сохраняем посимвольно, помня о \-экранах.
    if (ch === '\\' && next !== '') {
      out.push(ch, next);
      i += 2;
      continue;
    }
    if ((state === 'single' && (ch === "'" || ch === '\n')) || (state === 'double' && ch === '"')) {
      state = 'code';
    } else if (state === 'template' && ch === '`') {
      state = 'code';
    }
    out.push(ch);
    i += 1;
  }
  return out.join('');
}

/**
 * Срезает комментарии # в yml/sh по yaml-семантике: # начинает комментарий
 * только вне кавычек значения (# внутри кавычек срезал бы реальное ребро,
 * minor security-ревью e9).
 */
/**
 * Маска «код / не код» (строка или комментарий) — длина равна длине текста.
 * Импорты ищутся только на код-позициях: import-текст внутри строки (пробник
 * канарейки, ассерт теста) — не ребро, а реальный импорт с юникод-экранами
 * живёт в коде и попадает в фильтр нераспознанных (security-ревью e9,
 * major-2).
 */
function buildCodeMask(text: string): boolean[] {
  const mask: boolean[] = [];
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';
  let i = 0;
  const push = (code: boolean, count: number): void => {
    for (let k = 0; k < count; k += 1) {
      mask.push(code);
    }
  };
  while (i < text.length) {
    const ch = text[i] ?? '';
    const next = text[i + 1] ?? '';
    if (state === 'code') {
      if (ch === '/' && next === '/') {
        state = 'line';
        push(false, 2);
        i += 2;
        continue;
      }
      if (ch === '/' && next === '*') {
        state = 'block';
        push(false, 2);
        i += 2;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        state = ch === "'" ? 'single' : ch === '"' ? 'double' : 'template';
        push(true, 1);
        i += 1;
        continue;
      }
      push(true, 1);
      i += 1;
      continue;
    }
    if (state === 'line') {
      const code = ch === '\n';
      push(code, 1);
      if (code) {
        state = 'code';
      }
      i += 1;
      continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') {
        state = 'code';
        push(false, 2);
        i += 2;
        continue;
      }
      push(false, 1);
      i += 1;
      continue;
    }
    if (ch === '\\') {
      push(false, 2);
      i += 2;
      continue;
    }
    const closing =
      (state === 'single' && (ch === "'" || ch === '\n')) ||
      (state === 'double' && ch === '"') ||
      (state === 'template' && ch === '`');
    if (closing) {
      state = 'code';
      push(true, 1);
    } else {
      // Содержимое строки — не код: import-текст внутри строки не ребро.
      push(false, 1);
    }
    i += 1;
  }
  return mask;
}

function stripHashComments(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      let quote: string | null = null;
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i] ?? '';
        if (quote !== null) {
          if (ch === quote) {
            quote = null;
          }
          continue;
        }
        if (ch === "'" || ch === '"') {
          quote = ch;
          continue;
        }
        if (ch === '#' && (i === 0 || /\s/.test(line[i - 1] ?? ''))) {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join('\n');
}

function stripComments(text: string, file: string): string {
  if (/\.ya?ml$/.test(file) || file.endsWith('.sh')) {
    return stripHashComments(text);
  }
  return stripCodeComments(text);
}

// --- Дерево репозитория ----------------------------------------------------------

function walkFiles(root: string): string[] {
  const files: string[] = [];
  const stack: string[] = [''];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) {
      break;
    }
    const entries = readdirSync(dir === '' ? root : `${root}/${dir}`, { withFileTypes: true });
    for (const entry of entries) {
      const relative = dir === '' ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        // node_modules/.git игнорируются везде, остальные — только в корне:
        // tools/dist/ и tools/reports/ — реальные файлы контура, а не мусор
        // (minor security-ревью e9).
        const ignoredAnywhere = entry.name === 'node_modules' || entry.name === '.git';
        const ignoredAtRoot = dir === '' && IGNORED_DIRS.has(entry.name);
        if (!ignoredAnywhere && !ignoredAtRoot) {
          stack.push(relative);
        }
        continue;
      }
      if (entry.isFile()) {
        files.push(relative);
      }
    }
  }
  return files;
}

function isFile(root: string, relative: string): boolean {
  try {
    return statSync(`${root}/${relative}`).isFile();
  } catch {
    return false;
  }
}

// --- Разбор источников -----------------------------------------------------------

export interface ScriptCall {
  /** Имя скрипта package.json. */
  name: string;
  /** Пакет для --filter (имя из package.json), undefined — корневой. */
  pkg?: string;
  /** Нераспознанный вызов (npx/npm/неизвестный токен после pnpm) — красный. */
  unknown?: string;
}

/**
 * Токены `pnpm <script>` из текста. Флаги пропускаются, --filter задаёт пакет,
 * `pnpm turbo …` и встроенные команды прерывают разбор строки.
 */
function extractScriptCalls(text: string): ScriptCall[] {
  const calls: ScriptCall[] = [];
  for (const line of text.split('\n')) {
    // npm/npx в контурном файле — нераспознанный вызов внешнего раннера:
    // красный (fail-closed, З4), а не молчаливый пропуск ребра (security-ревью
    // e9, major-3). Легитимных npm/npx-вызовов в контуре нет.
    for (const match of line.matchAll(/\b(?:npm|npx)\s+run\s+([a-zA-Z0-9:@/._-]+)/g)) {
      calls.push({ name: match[1] ?? '', unknown: `npm run ${match[1] ?? ''}` });
    }
    if (/\bnpx\s+\S/.test(line)) {
      calls.push({ name: '', unknown: line.trim().slice(0, 80) });
    }
    if (/\bnpm\s+(?!run\b)\S/.test(line)) {
      calls.push({ name: '', unknown: line.trim().slice(0, 80) });
    }
    for (const match of line.matchAll(/\bpnpm\s+([^\n'"`;|]+)/g)) {
      const words = (match[1] ?? '').split(/\s+/).filter(Boolean);
      let pkg: string | undefined;
      let found: string | undefined;
      let unknown: string | undefined;
      for (let index = 0; index < words.length; index += 1) {
        const word = words[index] ?? '';
        if (word === '--filter' || word === '-F') {
          const value = words[index + 1];
          if (value !== undefined && SCRIPT_NAME.test(value)) {
            pkg = value;
            index += 1;
          }
          continue;
        }
        if (word.startsWith('-')) {
          continue;
        }
        if (word === 'run') {
          continue; // прозрачный токен: pnpm run X — скрипт X (major-3)
        }
        if (word === 'turbo') {
          break; // задачи turbo — не скрипты package.json
        }
        if (PNPM_BUILTINS.has(word)) {
          break;
        }
        if (SCRIPT_NAME.test(word)) {
          found = word;
          break;
        }
        unknown = `pnpm ${words.join(' ')}`;
        break;
      }
      if (found !== undefined) {
        calls.push(pkg === undefined ? { name: found } : { name: found, pkg });
      } else if (unknown !== undefined) {
        calls.push({ name: '', unknown });
      }
    }
  }
  return calls;
}

/** Шаги verify-steps: скрипты package.json (с --filter) и задачи turbo. */
function parseVerifySteps(text: string): { scripts: ScriptCall[]; tasks: string[] } | null {
  const scripts: ScriptCall[] = [];
  for (const match of text.matchAll(/args:\s*\[([^\]]*)\]/g)) {
    const tokens = [...(match[1] ?? '').matchAll(/'([^']*)'|"([^"]*)"/g)].map(
      (token) => token[1] ?? token[2] ?? '',
    );
    let pkg: string | undefined;
    let found: string | undefined;
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index] ?? '';
      if (token === '--filter' || token === '-F') {
        const value = tokens[index + 1];
        if (value !== undefined) {
          pkg = value;
          index += 1;
        }
        continue;
      }
      if (token.startsWith('-')) {
        continue;
      }
      if (token === 'turbo') {
        break;
      }
      found = token;
      break;
    }
    if (found !== undefined) {
      scripts.push(pkg === undefined ? { name: found } : { name: found, pkg });
    }
  }
  const tasks = [...text.matchAll(/\bturbo\(\s*'([^']+)'/g)].map((match) => match[1] ?? '');
  // Паритет: каждая запись таблицы шагов должна распознаться — иначе дрейф
  // формата молча сужает инференс и (в)-валидацию (minor security-ревью e9).
  const nameEntries = [...text.matchAll(/\bname:\s*'/g)].length;
  if (scripts.length + tasks.length === 0 || nameEntries !== scripts.length) {
    return null; // не распарсилось — fail-closed (З4)
  }
  return { scripts, tasks };
}

/**
 * Относительные импорты из кода: совпадение засчитывается, только если его
 * ключевое слово стоит на код-позиции (не внутри строки/комментария).
 */
function extractImports(text: string): string[] {
  const mask = buildCodeMask(text);
  const specifiers: string[] = [];
  const patterns = [
    String.raw`\bfrom\s*['"]([^'"]+)['"]`,
    String.raw`\bimport\s*\(\s*['"]([^'"]+)['"]`,
    String.raw`\bimport\s+['"]([^'"]+)['"]`,
  ];
  for (const source of patterns) {
    for (const match of text.matchAll(new RegExp(source, 'g'))) {
      const keywordIndex = match.index ?? -1;
      if (keywordIndex < 0 || !(mask[keywordIndex] ?? false)) {
        continue;
      }
      const specifier = match[1] ?? '';
      if (specifier.startsWith('.')) {
        specifiers.push(specifier);
      }
    }
  }
  return specifiers;
}

function extractToolLiterals(text: string): string[] {
  return [...text.matchAll(TOOL_LITERAL)].map((match) => match[0].replace(/\/+$/, ''));
}

/** Include-глобы vitest-конфигов, ссылающие под tools/ (файлы тестов — вход). */
function extractVitestIncludes(text: string): string[] {
  const globs: string[] = [];
  for (const match of text.matchAll(/['"]([^'"]*\*\*[^'"]*)['"]/g)) {
    const pattern = match[1] ?? '';
    if (pattern.startsWith('tools/')) {
      globs.push(pattern);
    }
  }
  return globs;
}

// --- Индекс скриптов workspace ----------------------------------------------------

interface ScriptsIndex {
  /** Скрипты корневого package.json. */
  root: Map<string, string>;
  /** Имя пакета → каталог и скрипты. */
  packages: Map<string, { dir: string; scripts: Map<string, string> }>;
  /** Имена задач turbo.json. */
  turboTasks: Set<string>;
}

function readScriptsBlock(root: string, relative: string): Map<string, string> {
  const scripts = new Map<string, string>();
  try {
    const parsed: unknown = JSON.parse(readFileSync(`${root}/${relative}`, 'utf8'));
    if (isRecord(parsed)) {
      const block: unknown = parsed['scripts'];
      if (isRecord(block)) {
        for (const [name, value] of Object.entries(block)) {
          if (typeof value === 'string') {
            scripts.set(name, value);
          }
        }
      }
    }
  } catch {
    // Битый package.json красят свои гейты (install/sherif); здесь — пропуск.
  }
  return scripts;
}

function loadScriptsIndex(root: string, files: string[]): ScriptsIndex {
  const index: ScriptsIndex = { root: new Map(), packages: new Map(), turboTasks: new Set() };
  index.root = readScriptsBlock(root, 'package.json');
  for (const relative of files) {
    if (!relative.endsWith('/package.json')) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(`${root}/${relative}`, 'utf8'));
      const name =
        isRecord(parsed) && typeof parsed['name'] === 'string' ? parsed['name'] : undefined;
      if (name !== undefined) {
        index.packages.set(name, {
          dir: relative.replace(/\/package\.json$/, ''),
          scripts: readScriptsBlock(root, relative),
        });
      }
    } catch {
      // см. readScriptsBlock
    }
  }
  const turboPath = `${root}/turbo.json`;
  if (existsSync(turboPath)) {
    try {
      // turbo.json — JSONC: комментарии срезает стриппер кода, а не хеш-стриппер.
      const parsed: unknown = JSON.parse(stripCodeComments(readFileSync(turboPath, 'utf8')));
      const tasksBlock = isRecord(parsed) ? parsed['tasks'] : undefined;
      if (isRecord(tasksBlock)) {
        index.turboTasks = new Set(Object.keys(tasksBlock));
      }
    } catch {
      // turbo.json защищён и валиден в репозитории; в синтетических деревьях его нет.
    }
  }
  return index;
}

function scriptHolder(index: ScriptsIndex, call: ScriptCall): Map<string, string> | null {
  if (call.pkg === undefined) {
    return index.root;
  }
  return index.packages.get(call.pkg)?.scripts ?? null;
}

// --- Основной расчёт ---------------------------------------------------------------

export function checkToolClass(input: ToolClassInput): ToolClassReport {
  const { root } = input;
  const knownGates = input.knownGates ?? KNOWN_GATES;
  const problems: string[] = [];

  // Список классов — единственный источник: tools/protected-paths.json (З10).
  let deny: string[] = [];
  const protectedFile = 'tools/protected-paths.json';
  if (!isFile(root, protectedFile)) {
    problems.push(`${protectedFile}: файл не найден — список классов не прочитан (fail-closed)`);
  } else {
    try {
      deny = parseProtectedPaths(JSON.parse(readFileSync(`${root}/${protectedFile}`, 'utf8'))).deny;
    } catch (error) {
      problems.push(
        `${protectedFile}: не прочитан (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  const files = walkFiles(root);
  const index = loadScriptsIndex(root, files);

  // --- Входные точки -----------------------------------------------------------

  const sourceTexts = new Map<string, string>();
  const inlineSources: string[] = [];
  const entryFiles: string[] = [];

  const addSourceFile = (relative: string): void => {
    if (sourceTexts.has(relative) || !isFile(root, relative)) {
      return;
    }
    entryFiles.push(relative);
    sourceTexts.set(relative, stripComments(readFileSync(`${root}/${relative}`, 'utf8'), relative));
  };

  // 1. Шаги verify (три волны) — не распарсились => расчёт сломан (fail-closed).
  const stepsFile = 'tools/verify-steps.ts';
  if (!isFile(root, stepsFile)) {
    problems.push(`${stepsFile}: не найден — входные точки verify не выведены (fail-closed)`);
  } else {
    const parsed = parseVerifySteps(readFileSync(`${root}/${stepsFile}`, 'utf8'));
    addSourceFile(stepsFile);
    if (parsed === null) {
      problems.push(
        `${stepsFile}: шаги не распознаны — формат таблицы шагов изменился (fail-closed, З4)`,
      );
    }
    // (в): каждый шаг ссылается на существующий скрипт / turbo-задачу.
    for (const call of parsed?.scripts ?? []) {
      const holder = scriptHolder(index, call);
      if (holder === null) {
        problems.push(`(в) шаг verify: --filter ${call.pkg ?? ''}: пакет не найден в workspace`);
        continue;
      }
      const value = holder.get(call.name);
      if (value === undefined) {
        problems.push(`(в) шаг verify ссылается на несуществующий скрипт: ${call.name}`);
        continue;
      }
      inlineSources.push(value);
    }
    for (const task of parsed?.tasks ?? []) {
      if (!index.turboTasks.has(task)) {
        problems.push(`(в) шаг verify ссылается на несуществующую turbo-задачу: ${task}`);
      }
    }
  }

  // 2. Workflows и lefthook: источники (ссылки tools/… и вызываемые скрипты).
  const workflowsDir = `${root}/.github/workflows`;
  if (existsSync(workflowsDir)) {
    for (const name of readdirSync(workflowsDir)) {
      if (name.endsWith('.yml') || name.endsWith('.yaml')) {
        addSourceFile(`.github/workflows/${name}`);
      }
    }
  }
  if (isFile(root, 'lefthook.yml')) {
    addSourceFile('lefthook.yml');
  }

  // 3. Каталог hooks — входные точки целиком.
  const hooksDir = 'tools/hooks';
  if (existsSync(`${root}/${hooksDir}`)) {
    for (const name of readdirSync(`${root}/${hooksDir}`)) {
      if (statSync(`${root}/${hooksDir}/${name}`).isFile()) {
        addSourceFile(`${hooksDir}/${name}`);
      }
    }
  }

  // 4. Защищённые конфиги (vitest.config.ts) и все ts-файлы e2e/.
  for (const relative of files) {
    if (/(^|\/)vitest\.config\.tsx?$/.test(relative)) {
      addSourceFile(relative);
    }
  }
  if (existsSync(`${root}/e2e`)) {
    for (const relative of files) {
      if (relative.startsWith('e2e/') && relative.endsWith('.ts')) {
        addSourceFile(relative);
      }
    }
  }

  // 5. Скрипты, вызванные контуром (ADR 0014: verify-steps, workflows,
  // lefthook, хуки — других источников вызовов нет): значения — inline-
  // источники (З11: вызов без резолва — красный, не пропуск). Тексты прочих
  // scanned-файлов не разбираются: строка-подсказка «pnpm visual» — не вызов.
  for (const [relative, text] of sourceTexts) {
    const contourCaller =
      relative.startsWith('.github/workflows/') ||
      relative === 'lefthook.yml' ||
      relative.startsWith('tools/hooks/');
    if (!contourCaller) {
      continue;
    }
    for (const call of extractScriptCalls(text)) {
      if (call.unknown !== undefined) {
        problems.push(`(в) ${relative}: нераспознанный вызов в контурном файле: ${call.unknown}`);
        continue;
      }
      const holder = scriptHolder(index, call);
      if (holder === null) {
        problems.push(`(в) ${relative}: --filter ${call.pkg ?? ''}: пакет не найден в workspace`);
        continue;
      }
      const value = holder.get(call.name);
      if (value === undefined) {
        problems.push(`(в) ${relative}: ссылка на несуществующий скрипт: pnpm ${call.name}`);
        continue;
      }
      inlineSources.push(value);
    }
  }

  // 6. Include-глобы vitest-конфигов: файлы тестов — тоже входные точки (их
  // импорты считаются). Глобы из прочих текстов (paths:-фильтры workflow) —
  // не входные точки.
  for (const [relative, text] of sourceTexts) {
    if (!/(^|\/)vitest\.config\.tsx?$/.test(relative)) {
      continue;
    }
    for (const pattern of extractVitestIncludes(text)) {
      for (const file of files.filter((candidate) => matchesGlob(candidate, pattern))) {
        addSourceFile(file);
      }
    }
  }

  // Значения скриптов — транзитивно (shell→shell и pnpm→pnpm: значение скрипта
  // может звать другой скрипт, его значение сканируется так же); литеральные
  // ссылки tools/… обязаны резолвиться (в).
  const inlineQueue = [...inlineSources];
  const seenInline = new Set<string>();
  while (inlineQueue.length > 0) {
    const text = inlineQueue.pop() ?? '';
    if (seenInline.has(text)) {
      continue;
    }
    seenInline.add(text);
    for (const call of extractScriptCalls(text)) {
      if (call.unknown !== undefined) {
        problems.push(`(в) цепочка скриптов: нераспознанный вызов: ${call.unknown}`);
        continue;
      }
      const holder = scriptHolder(index, call);
      if (holder === null) {
        problems.push(`(в) цепочка скриптов: --filter ${call.pkg ?? ''}: пакет не найден`);
        continue;
      }
      const value = holder.get(call.name);
      if (value === undefined) {
        problems.push(`(в) цепочка скриптов ведёт к несуществующему скрипту: ${call.name}`);
        continue;
      }
      inlineQueue.push(value);
    }
    for (const literal of extractToolLiterals(text)) {
      if (literal.includes('*') || isFile(root, literal)) {
        entryFiles.push(literal);
        continue;
      }
      problems.push(`(в) ссылка скрипта не резолвится: ${literal}`);
    }
  }

  // --- Замыкание -----------------------------------------------------------------

  const visited = new Set<string>();
  const queue = [...entryFiles];
  while (queue.length > 0) {
    const relative = queue.pop();
    if (relative === undefined) {
      break;
    }
    if (visited.has(relative)) {
      continue;
    }
    visited.add(relative);
    const cached = sourceTexts.get(relative);
    const text =
      cached ??
      (isFile(root, relative)
        ? stripComments(readFileSync(`${root}/${relative}`, 'utf8'), relative)
        : '');
    // Литералы в тестах tools/test/ — фикстуры (строки-примеры путей), не
    // рёбра графа; импорты тестов остаются рёбрами: они определяют класс
    // импортируемого. В e2e литералы — рёбра: сценарии исполняются контуром
    // (perf-гейт), ссылка на tools/… там — реальная цель запуска (minor
    // security-ревью e9).
    const literalsMatter = !relative.startsWith('tools/test/');
    // protected-paths.json — член замыкания (его читает контур), но данных-
    // источник, не код: его deny-записи не могут сеять сами себя в замыкание,
    // иначе проверка (б) «лишняя deny-запись» ослепнет (цикличность).
    const importsMatter = relative !== 'tools/protected-paths.json';
    for (const specifier of importsMatter ? extractImports(text) : []) {
      const resolved = resolveImport(root, relative, specifier);
      if (resolved === null) {
        // Нераспознанный относительный импорт — красный, не молчаливый
        // пропуск: юникод-экранирование или опечатка не должны прятать ребро
        // (security-ревью e9, major-2; runtime резолвит экраны, чекер видит
        // сырую строку — расхождение громкое в обе стороны).
        problems.push(`нераспознанный относительный импорт в ${relative}: ${specifier}`);
        continue;
      }
      if (!visited.has(resolved)) {
        queue.push(resolved);
      }
    }
    const literals = literalsMatter && importsMatter ? extractToolLiterals(text) : [];
    for (const literal of literals) {
      if (literal.includes('*')) {
        // Глоб в тексте (tools/** в paths:-фильтре workflow) — не ссылка на
        // файл: расширения нет. Include-глобы vitest-конфигов раскрываются
        // отдельно, на этапе входных точек.
        continue;
      }
      // Пробники канареек (tools/evil-probe.ts) не существуют — не узлы графа.
      // Литерал извлекается из любой строки файла замыкания, не только из
      // позиций spawn: упоминание tools/… в сообщении втягивает файл в
      // замыкание — пере-аппроксимация в консервативную сторону (deny, не
      // review), осознанная (находка architecture-ревью e9).
      if (isFile(root, literal) && !visited.has(literal)) {
        queue.push(literal);
      }
    }
  }
  const closure = [...visited].filter((file) => file.startsWith('tools/')).toSorted();

  // --- Проверки ------------------------------------------------------------------

  // (а) каждый файл замыкания покрыт deny (точная запись или каталог/**).
  const coveredByDeny = (file: string): boolean =>
    deny.some((entry) => matchesGlob(file, entry) || matchesGlob(`${file}/__child__`, entry));
  for (const file of closure.filter((candidate) => !coveredByDeny(candidate))) {
    problems.push(`(а) файл замыкания вне deny: ${file} — гейт остался без защиты`);
  }

  // (б) каждая deny-запись внутри tools/ покрыта замыканием (список не гниёт).
  for (const entry of deny.filter((item) => item.startsWith('tools/'))) {
    if (entry.includes('*')) {
      const covered = files.filter((file) => matchesGlob(file, entry));
      if (covered.length === 0) {
        problems.push(`(б) deny-запись не покрывает ни одного файла: ${entry}`);
        continue;
      }
      const outside = covered.filter((file) => !visited.has(file));
      if (outside.length > 0) {
        problems.push(
          `(б) deny-запись ${entry} покрывает файлы вне замыкания: ${outside.slice(0, 10).join(', ')}`,
        );
      }
      continue;
    }
    if (!isFile(root, entry)) {
      problems.push(`(б) deny-запись указывает на несуществующий файл: ${entry}`);
      continue;
    }
    if (!visited.has(entry)) {
      problems.push(`(б) deny-запись вне замыкания: ${entry} — файл не исполняется контуром`);
    }
  }

  // Инвариант fail-closed: известные гейты обязаны оказаться в замыкании.
  for (const gate of knownGates) {
    if (!visited.has(gate)) {
      problems.push(
        `fail-closed: известный гейт ${gate} не найден в замыкании — структурный вывод сломан (З4)`,
      );
    }
  }
  // Симметричный якорь: каждая точная deny-запись внутри tools/ обязана быть
  // известным гейтом — иначе новый гейт, внесённый в deny без KNOWN_GATES,
  // молча сужает защиту от поломки вывода. Только в режиме репозитория: в
  // синтетических деревьях список известных гейтов передаётся опцией.
  if (input.knownGates === undefined) {
    for (const entry of deny) {
      if (entry.startsWith('tools/') && !entry.includes('*') && !knownGates.includes(entry)) {
        problems.push(`fail-closed: deny-запись ${entry} вне KNOWN_GATES — добавь её туда же (З4)`);
      }
    }
  }

  return { problems, closure };
}

/** Резолв относительного импорта к файлу репозитория; null — не резолвится. */
function resolveImport(root: string, fromFile: string, specifier: string): string | null {
  const dir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : '';
  const joined = dir === '' ? specifier.replace(/^\.\//, '') : `${dir}/${specifier}`;
  const normalized: string[] = [];
  for (const part of joined.split('/')) {
    if (part === '..') {
      normalized.pop();
    } else if (part !== '.') {
      normalized.push(part);
    }
  }
  const candidate = normalized.join('/');
  if (isFile(root, candidate)) {
    return candidate;
  }
  if (isFile(root, `${candidate}.ts`)) {
    return `${candidate}.ts`;
  }
  return null;
}

// --- CLI ---------------------------------------------------------------------------

const repoRootFromHere = fileURLToPath(new URL('..', import.meta.url));
const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  const report = checkToolClass({ root: repoRootFromHere });
  if (report.problems.length > 0) {
    console.error(report.problems.join('\n'));
    console.error(
      `\ntool-class: замыкание гейтов (${report.closure.length} файлов) не равно deny — исправь классы, не гейт (ADR 0014).`,
    );
    process.exit(1);
  }
  console.log(`tool-class: замыкание ${report.closure.length} файлов покрыто deny (ADR 0014)`);
}
