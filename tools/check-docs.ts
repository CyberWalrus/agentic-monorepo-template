/**
 * Гейт целостности документации: инструкции не расходятся с репозиторием.
 *
 * 1. Команды `pnpm …` из README.md, AGENTS.md, CLAUDE.md и скилов существуют:
 *    это скрипт в package.json (с учётом `--filter <пакет>`), встроенная команда
 *    pnpm или бинарь из node_modules/.bin. Плейсхолдеры вроде `<pkg>` не проверяются.
 * 2. Относительные markdown-ссылки ведут на существующие файлы, а якоря —
 *    на существующие заголовки или id (правила слагов как у GitHub, включая кириллицу).
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { glob, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { dependencyCycles, invalidTouch, parseTask, type TaskFile } from './backlog-board.ts';

const IGNORE =
  /(^|\/)(node_modules|dist|\.output|reports|test-results|playwright-report|coverage|\.turbo|\.git)(\/|$)/;

/** Инструкции, из которых проверяются команды pnpm: агент выполняет их вслепую. */
const COMMAND_DOCS = ['README.md', 'AGENTS.md', 'CLAUDE.md', '.claude/skills/**/SKILL.md'];

/** Встроенные команды pnpm: их нет в package.json, и это не ошибка. */
const PNPM_BUILTINS = new Set([
  'install',
  'i',
  'add',
  'remove',
  'uninstall',
  'run',
  'exec',
  'dlx',
  'why',
  'outdated',
  'update',
  'up',
  'store',
  'config',
  'rebuild',
  'approve-builds',
  'fetch',
  'link',
  'unlink',
  'pack',
  'publish',
  'list',
  'ls',
  'root',
  'setup',
  'env',
  'workspace',
  'self-update',
]);

const SCRIPT_NAME = /^[a-zA-Z0-9:@/_-]+$/;
const LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
// Хвост команды: до обратной кавычки (конец инлайн-кода), границы ячейки таблицы или конца строки.
const PNPM_RE = /(?:^|[^\w.-])pnpm\s+([^`|]+)/g;

const findings: string[] = [];

// --- Скрипты workspace и локальные бинари -------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const scriptsByPkg = new Map<string, Set<string>>();
const allScripts = new Set<string>();
let rootScripts = new Set<string>();

for await (const entry of glob('**/package.json', { withFileTypes: true })) {
  const file = path.relative(process.cwd(), `${entry.parentPath}/${entry.name}`);
  if (!entry.isFile() || IGNORE.test(file)) {
    continue;
  }
  const pkg: unknown = JSON.parse(await readFile(file, 'utf8'));
  const scripts = new Set(
    isRecord(pkg) && isRecord(pkg['scripts']) ? Object.keys(pkg['scripts']) : [],
  );
  if (isRecord(pkg) && typeof pkg['name'] === 'string') {
    scriptsByPkg.set(pkg['name'], scripts);
  }
  for (const script of scripts) {
    allScripts.add(script);
  }
  if (file === 'package.json') {
    rootScripts = scripts;
  }
}

const bins = new Set(await readdir('node_modules/.bin').catch(() => [] as string[]));

// --- Часть 1: команды pnpm ----------------------------------------------------

function checkScript(
  doc: string,
  line: number,
  script: string,
  pkg: string,
  anyPkg: boolean,
): void {
  if (pkg) {
    const scripts = scriptsByPkg.get(pkg);
    if (!scripts) {
      findings.push(
        `${doc}:${line}: фильтр «--filter ${pkg}» указывает на пакет, которого нет в workspace`,
      );
    } else if (!scripts.has(script)) {
      findings.push(`${doc}:${line}: у пакета «${pkg}» нет скрипта «${script}»`);
    }
    return;
  }
  const pool = anyPkg ? allScripts : rootScripts;
  if (!pool.has(script) && !bins.has(script)) {
    findings.push(
      `${doc}:${line}: неизвестная команда «pnpm ${script}» — скрипта нет в ${anyPkg ? 'пакетах workspace' : 'корневом package.json'}, и это не встроенная команда pnpm. Исправь команду (или скрипт), не удаляй проверку.`,
    );
  }
}

function checkPnpmTail(doc: string, line: number, tail: string): void {
  // Хвостовая пунктуация prose («pnpm visual).») — часть текста, не команды.
  const tokens = tail
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/[),.;:!?'"\u2026]+$/u, ''))
    .filter(Boolean);
  let mode: 'root' | 'filter-value' | 'script' = 'root';
  let pkg = '';
  let anyPkg = false;
  for (const token of tokens) {
    if (mode === 'filter-value') {
      mode = 'root';
      anyPkg = true;
      if (SCRIPT_NAME.test(token)) {
        pkg = token; // плейсхолдеры (<pkg>) и шаблоны (*) означают «любой пакет»
      }
      continue;
    }
    if (token === '--filter' || token === '-F') {
      mode = 'filter-value';
      continue;
    }
    if (token.startsWith('-')) {
      continue; // флаги
    }
    if (!SCRIPT_NAME.test(token) || /^\d/.test(token)) {
      return; // не похоже на имя команды (или это версия) — обычный текст, а не инструкция
    }
    if (PNPM_BUILTINS.has(token)) {
      if (token !== 'run') {
        return; // exec, install и прочие: аргументы дальше — не имена скриптов
      }
      mode = 'script';
      continue;
    }
    checkScript(doc, line, token, pkg, anyPkg);
    return; // имя скрипта найдено, дальше идут аргументы
  }
}

for (const pattern of COMMAND_DOCS) {
  for await (const entry of glob(pattern, { withFileTypes: true })) {
    const file = path.relative(process.cwd(), `${entry.parentPath}/${entry.name}`);
    if (!entry.isFile()) {
      continue;
    }
    const lines = (await readFile(file, 'utf8')).split('\n');
    for (const [index, line] of lines.entries()) {
      for (const match of line.matchAll(PNPM_RE)) {
        const tail = match[1];
        if (tail) {
          checkPnpmTail(file, index + 1, tail);
        }
      }
    }
  }
}

// --- Часть 2: относительные ссылки и якоря ------------------------------------

function slugify(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text; // незакодированный процент — оставляем как есть
  }
}

const anchorsCache = new Map<string, Promise<Set<string>>>();

function anchorsOf(file: string): Promise<Set<string>> {
  let anchors = anchorsCache.get(file);
  if (!anchors) {
    anchors = readFile(file, 'utf8').then((text) => {
      const set = new Set<string>();
      for (const match of text.matchAll(/^#{1,6}\s+(.+)$/gm)) {
        const heading = match[1];
        if (heading) {
          set.add(slugify(heading));
        }
      }
      for (const match of text.matchAll(/\b(?:id|name)="([^"]+)"/g)) {
        const id = match[1];
        if (id) {
          set.add(id);
        }
      }
      return set;
    });
    anchorsCache.set(file, anchors);
  }
  return anchors;
}

for await (const entry of glob('**/*.md', { withFileTypes: true })) {
  const file = path.relative(process.cwd(), `${entry.parentPath}/${entry.name}`);
  if (!entry.isFile() || IGNORE.test(file)) {
    continue;
  }
  const lines = (await readFile(file, 'utf8')).split('\n');
  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(LINK_RE)) {
      const target = match[1];
      if (!target) {
        continue;
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
        continue; // http:, mailto: и другие абсолютные схемы
      }
      let route = target;
      let anchor = '';
      const hash = target.indexOf('#');
      if (hash >= 0) {
        route = target.slice(0, hash);
        anchor = decode(target.slice(hash + 1));
      }
      if (!route) {
        if (anchor && !(await anchorsOf(file)).has(anchor)) {
          findings.push(`${file}:${index + 1}: в этом файле нет заголовка или id «#${anchor}»`);
        }
        continue;
      }
      route = decode(route.split('?')[0] ?? route);
      const dest = path.resolve(path.dirname(file), route);
      const exists = await stat(dest).catch(() => null);
      if (!exists) {
        findings.push(
          `${file}:${index + 1}: ссылка «${target}» ведёт на несуществующий путь «${route}»`,
        );
        continue;
      }
      if (anchor && route.endsWith('.md') && !(await anchorsOf(dest)).has(anchor)) {
        findings.push(`${file}:${index + 1}: в «${route}» нет заголовка или id «#${anchor}»`);
      }
    }
  }
}

// --- Часть 3: доска задач (ADR 0007, D3) ---------------------------------------

// Доска — инструкция, которой агент доверяет вслепую, поэтому проверяется тем
// же гейтом, что и остальная документация. Рабочее дерево совпадает с проверкой:
// доску из main здесь не читаем — гейт гоняется в ветке задачи и обязан видеть
// сам файл задачи.

/**
 * На ветке `task/<id>` среди существующих файлов доски меняется только свой:
 * чужая задача или её блокирующие поля (depends_on, needs_human, touches)
 * меняются только в PR (ADR 0007, «Проверка доски»). Правило проверяем только
 * когда есть база для сравнения и каталог доски существует.
 */
function boardBranchRule(): void {
  if (!existsSync('backlog')) {
    return;
  }
  let branch = '';
  let base = '';
  try {
    branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim();
    execFileSync('git', ['rev-parse', '--verify', '--quiet', 'main'], { encoding: 'utf8' });
    base = 'main';
  } catch {
    return;
  }
  if (!branch.startsWith('task/')) {
    return;
  }
  const changed = execFileSync(
    'git',
    ['diff', '--name-only', '--no-renames', `${base}...HEAD`, '--', 'backlog/'],
    { encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean);
  const id = branch.slice('task/'.length);
  const allowed = new Set([`backlog/${id}.md`, `backlog/done/${id}.md`]);
  for (const file of changed) {
    if (!allowed.has(file)) {
      findings.push(
        `${file}: на ветке task/${id} среди файлов доски меняется только свой файл; правки чужих задач идут отдельным PR`,
      );
    }
  }
}

async function checkBoard(): Promise<void> {
  if (!existsSync('backlog')) {
    return;
  }
  const tasks: TaskFile[] = [];
  const read = async (dir: string, done: boolean): Promise<void> => {
    const entries = await readdir(dir).catch(() => []);
    for (const name of entries.filter((entry) => entry.endsWith('.md'))) {
      const id = path.basename(name, '.md');
      const raw = await readFile(path.join(dir, name), 'utf8');
      tasks.push(parseTask(id, raw, done));
    }
  };
  await read('backlog', false);
  await read('backlog/done', true);

  const byId = new Map<string, TaskFile[]>();
  for (const task of tasks) {
    byId.set(task.id, [...(byId.get(task.id) ?? []), task]);
  }
  for (const [id, same] of byId) {
    if (same.length > 1) {
      findings.push(`backlog/: id «${id}» используется и в backlog/, и в backlog/done/ — дубль`);
    }
  }
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!byId.has(dep)) {
        findings.push(
          `backlog/${task.done ? 'done/' : ''}${task.id}.md: depends_on ссылается на несуществующую задачу «${dep}»`,
        );
      }
    }
    for (const touch of task.touches) {
      const problem = invalidTouch(touch);
      if (problem) {
        findings.push(`backlog/${task.done ? 'done/' : ''}${task.id}.md: touches: ${problem}`);
      }
    }
  }
  const cycles = dependencyCycles(tasks);
  if (cycles.length > 0) {
    findings.push(`backlog/: цикл зависимостей depends_on: ${cycles.join(' → ')}`);
  }
  boardBranchRule();
}

await checkBoard();

if (findings.length > 0) {
  console.error(findings.join('\n'));
  console.error(
    '\nДокументация разошлась с репозиторием. Исправь команду или ссылку в документе; если гейт ошибся на встроенной команде pnpm или ссылке-примере, дополни исключение в tools/check-docs.ts.',
  );
  process.exit(1);
}
console.log('docs: ok');
