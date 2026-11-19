/**
 * Гейт целостности доски задач: doctor — расхождения «смержена — доска не
 * знает» и забытые файлы режима обслуживания (ADR 0007, ADR 0009). Исполняется
 * nightly (`node tools/backlog-doctor.ts`) и делегируется CLI
 * (`pnpm backlog doctor`); логика doctor живёт только здесь (ADR 0014:
 * «делим гейт и инструмент»), CLI tools/backlog.ts — review и импортирует этот
 * модуль (review→deny безопасно, deny→review запрещено).
 *
 * Здесь же обвязка чтения доски из ссылки main (loadBoard) и git/gh-хелперы:
 * doctor — их основной потребитель, CLI переиспользует через импорт. Модель
 * (парсер и статусы) — tools/backlog-board.ts, без побочных эффектов.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  dependencyCycles,
  doctorFindings,
  parseTask,
  type MaintenanceFile,
  type TaskFile,
} from './backlog-board.ts';

export function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function tryGit(...args: string[]): string | null {
  try {
    return git(...args);
  } catch {
    return null;
  }
}

/** Запуск внешней команды (gh): null при любой неудаче — вызывающий печатает причину (З11). */
export function tryRun(file: string, args: string[]): string | null {
  try {
    return execFileSync(file, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    }).trim();
  } catch {
    return null;
  }
}

export function die(message: string): never {
  console.error(message);
  process.exit(1);
}

// --- Доска из ссылки main ------------------------------------------------------

export interface BoardSource {
  tasks: TaskFile[];
  ref: string | null;
  age: number | null;
}

export function humanAge(seconds: number | null): string {
  if (seconds === null) {
    return 'возраст неизвестен';
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} мин назад`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} ч назад`;
  }
  return `${Math.floor(hours / 24)} дн назад`;
}

function mainAge(ref: string): number | null {
  const timestamp = tryGit('log', '-1', '--format=%ct', ref);
  if (timestamp === null) {
    return null;
  }
  return Math.max(0, Math.floor(Date.now() / 1000) - Number(timestamp));
}

function readTaskDir(dir: string, done: boolean): TaskFile[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .map((name) =>
      parseTask(path.basename(name, '.md'), readFileSync(path.join(dir, name), 'utf8'), done),
    );
}

function boardFromFiles(): TaskFile[] {
  return [
    ...readTaskDir('backlog', false),
    ...(existsSync('backlog/done') ? readTaskDir('backlog/done', true) : []),
  ].toSorted((a, b) => a.id.localeCompare(b.id));
}

/** Доска из ссылки main; без ссылки — рабочее дерево с громким предупреждением (З11). */
export function loadBoard(): BoardSource {
  const ref =
    tryGit('rev-parse', '--verify', 'main') ?? tryGit('rev-parse', '--verify', 'origin/main');
  if (ref === null) {
    if (!existsSync('backlog')) {
      die(
        'Нет ссылки main и нет каталога backlog/: доска пуста. Обнови main (git fetch) или создай задачи.',
      );
    }
    console.error(
      'Ссылка main не найдена: читаю рабочее дерево (данные могут быть непроверенными).',
    );
    return { tasks: boardFromFiles(), ref: null, age: null };
  }
  const files = git('ls-tree', '-r', '--name-only', ref, '--', 'backlog/')
    .split('\n')
    .filter(Boolean);
  const tasks = files
    .filter((file) => file.endsWith('.md'))
    .map((file) => {
      const raw = git('show', `${ref}:${file}`);
      return parseTask(path.basename(file, '.md'), raw, file.startsWith('backlog/done/'));
    });
  return { tasks, ref, age: mainAge(ref) };
}

/** id задач, захваченных ветками task/* (ссылки git общие для всех worktree). */
export function claimedIds(): Set<string> {
  const branches = git('for-each-ref', '--format=%(refname:short)', 'refs/heads/');
  return new Set(
    branches
      .split('\n')
      .filter((branch) => branch.startsWith('task/'))
      .map((branch) => branch.slice('task/'.length)),
  );
}

/** Головки открытых PR (gh): null — gh недоступен (З11: вызывающий печатает причину). */
export function openPrHeads(): Set<string> | null {
  const raw = tryRun('gh', [
    'pr',
    'list',
    '--state',
    'open',
    '--limit',
    '200',
    '--json',
    'headRefName',
    '--jq',
    '.[].headRefName',
  ]);
  if (raw === null) {
    return null;
  }
  return new Set(raw.split('\n').filter(Boolean));
}

// --- Doctor ----------------------------------------------------------------------

/** id веток task/*, попавших в main по GitHub API; null, если gh недоступен. */
function mergedViaGh(): Set<string> | null {
  const raw = tryRun('gh', [
    'pr',
    'list',
    '--state',
    'merged',
    '--limit',
    '300',
    '--json',
    'headRefName',
    '--jq',
    '.[].headRefName',
  ]);
  if (raw === null) {
    return null;
  }
  return new Set(
    raw
      .split('\n')
      .filter((branch) => branch.startsWith('task/'))
      .map((branch) => branch.slice('task/'.length)),
  );
}

/** Fallback без gh: git-предок. Сквош-merge такие ветки не видит — печатается причина (З11). */
function mergedViaGit(ref: string, claims: string[]): Set<string> {
  const merged = new Set<string>();
  for (const id of claims) {
    if (tryGit('merge-base', '--is-ancestor', `task/${id}`, ref) !== null) {
      merged.add(id);
    }
  }
  return merged;
}

/**
 * Файлы режима обслуживания .claude/settings.local.json (ADR 0009): основной
 * checkout и worktree без ветки task/* — расхождение безусловно; worktree
 * задачи — по открытому PR или простою ветки. gh вызывается лениво и только
 * когда нашёлся файл в worktree задачи; недоступен → PR-состояние неизвестно,
 * об этом печатается причина (З11), файл не перестаёт быть находкой.
 */
function maintenanceFiles(branchAgeHours: Map<string, number>): MaintenanceFile[] {
  const files: MaintenanceFile[] = [];
  const commonDir = git('rev-parse', '--path-format=absolute', '--git-common-dir');
  const mainRoot = path.dirname(commonDir);
  let prHeads: Set<string> | null | undefined = undefined;
  const openPrFor = (taskId: string): { hasOpenPr: boolean; prUnknown: boolean } => {
    if (prHeads === undefined) {
      prHeads = openPrHeads();
      if (prHeads === null) {
        console.error(
          'gh недоступен: открытые PR не проверены — файл режима обслуживания в worktree задачи остаётся находкой (З11).',
        );
      }
    }
    return { hasOpenPr: prHeads?.has(`task/${taskId}`) ?? false, prUnknown: prHeads === null };
  };
  if (existsSync(path.join(mainRoot, '.claude', 'settings.local.json'))) {
    files.push({
      where: mainRoot,
      main: true,
      taskId: null,
      hasOpenPr: false,
      prUnknown: false,
      idleHours: null,
    });
  }
  const porcelain = tryGit('worktree', 'list', '--porcelain');
  if (porcelain === null) {
    console.error(
      'git worktree list недоступен: файлы режима обслуживания в чужих worktree не проверены (З11).',
    );
    return files;
  }
  let currentPath: string | null = null;
  let currentTask: string | null = null;
  const flush = (): void => {
    if (
      currentPath === null ||
      currentPath === mainRoot ||
      !existsSync(path.join(currentPath, '.claude', 'settings.local.json'))
    ) {
      return;
    }
    if (currentTask === null) {
      // Worktree не на ветке task/* (released/abandoned, detached): протокол
      // оператора такое место не покрывает — расхождение безусловно.
      files.push({
        where: currentPath,
        main: false,
        taskId: null,
        hasOpenPr: false,
        prUnknown: false,
        idleHours: null,
      });
      return;
    }
    const pr = openPrFor(currentTask);
    files.push({
      where: currentPath,
      main: false,
      taskId: currentTask,
      hasOpenPr: pr.hasOpenPr,
      prUnknown: pr.prUnknown,
      idleHours: branchAgeHours.get(currentTask) ?? null,
    });
  };
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush();
      currentPath = line.slice('worktree '.length);
      currentTask = null;
    } else if (line.startsWith('branch refs/heads/task/')) {
      currentTask = line.slice('branch refs/heads/task/'.length);
    }
  }
  flush();
  return files;
}

/** Доктор доски: findings печатаются, блокирующие роняют прогон (exit 1). */
export function runDoctor(source: BoardSource): void {
  const claims = [...claimedIds()].toSorted();
  const openIds = new Set(source.tasks.filter((task) => !task.done).map((task) => task.id));
  const doneIds = new Set(source.tasks.filter((task) => task.done).map((task) => task.id));
  let mergedIds = mergedViaGh();
  if (mergedIds === null) {
    console.error(
      'gh недоступен: слияние определяю по предку в git — ветки после сквош-merge не увидены, сверка неполная.',
    );
    mergedIds = mergedViaGit(source.ref ?? 'main', claims);
  }
  const branchAgeHours = new Map<string, number>();
  for (const id of claims) {
    const timestamp = tryGit('log', '-1', '--format=%ct', `task/${id}`);
    if (timestamp !== null && Number.isFinite(Number(timestamp))) {
      branchAgeHours.set(id, Math.max(0, (Date.now() / 1000 - Number(timestamp)) / 3600));
    }
  }
  const findings = doctorFindings({
    openIds,
    doneIds,
    claimedIds: new Set(claims),
    mergedIds,
    branchAgeHours,
    maintenanceFiles: maintenanceFiles(branchAgeHours),
  });
  const blocking = findings.filter((finding) => finding.blocking);
  const warnings = findings.filter((finding) => !finding.blocking);
  if (blocking.length === 0 && warnings.length === 0) {
    console.log('backlog doctor: расхождений нет.');
    return;
  }
  for (const finding of blocking) {
    console.error(finding.message);
  }
  for (const finding of warnings) {
    console.error(`предупреждение: ${finding.message}`);
  }
  if (blocking.length > 0) {
    die(
      `${blocking.length} расхождений доски и веток. Чинить в PR гигиены: перенос файла или удаление ветки; doctor не ослаблять.`,
    );
  }
}

// --- Вход nightly -------------------------------------------------------------------

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  const source = loadBoard();
  const cycles = dependencyCycles(source.tasks);
  if (cycles.length > 0) {
    die(`Доска содержит цикл зависимостей: ${cycles.join(' → ')}. Чинить в PR, не в ветке задачи.`);
  }
  runDoctor(source);
}
