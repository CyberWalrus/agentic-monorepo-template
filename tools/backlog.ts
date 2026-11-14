/**
 * Доска задач для параллельных агентов (ADR 0007).
 *
 *   pnpm backlog list            доска со статусами
 *   pnpm backlog next            следующая свободная задача (или состояние текущей)
 *   pnpm backlog start <id>      захват веткой task/<id> + рабочее место (worktree)
 *   pnpm backlog close <id>      закрыть: git mv backlog/<id>.md backlog/done/ (ADR 0007, «Замыкание задачи»)
 *   pnpm backlog resume <id>     продолжить брошенную по поручению человека
 *   pnpm backlog release <id>    освободить задачу (только человек, интерактивный терминал)
 *   pnpm backlog doctor          расхождения «смержена — доска не знает» (локально и nightly)
 *
 * Доска читается из ссылки main (а не из рабочего дерева): у каждого worktree
 * своё дерево, а ветка не должна снимать с себя блокировку (З2). Если ссылки
 * main нет (свежий worktree без fetch), команда печатает возраст данных и
 * читает рабочее дерево, а не молчит (З11). Захват — создание локальной ветки:
 * ссылки git общие для всех worktree клона, создание атомарно.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import {
  dependencyCycles,
  doctorFindings,
  parseTask,
  PRIORITIES,
  statusOf,
  touchesOverlap,
  type BoardFacts,
  type TaskFile,
  type TaskStatus,
} from './backlog-board.ts';

const LABEL: Record<TaskStatus, string> = {
  done: 'закрыта',
  'in-progress': 'в работе',
  blocked: 'заблокирована',
  maintenance: 'режим обслуживания',
  free: 'свободна',
};

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tryGit(...args: string[]): string | null {
  try {
    return git(...args);
  } catch {
    return null;
  }
}

/** Запуск внешней команды (gh): null при любой неудаче — вызывающий печатает причину (З11). */
function tryRun(file: string, args: string[]): string | null {
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

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

// --- Доска из ссылки main ------------------------------------------------------

/** Возраст данных main в секундах; null, если определить не удалось. */
function mainAge(ref: string): number | null {
  const timestamp = tryGit('log', '-1', '--format=%ct', ref);
  if (timestamp === null) {
    return null;
  }
  return Math.max(0, Math.floor(Date.now() / 1000) - Number(timestamp));
}

function humanAge(seconds: number | null): string {
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

interface BoardSource {
  tasks: TaskFile[];
  ref: string | null;
  age: number | null;
}

function loadBoard(): BoardSource {
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

function claimedIds(): Set<string> {
  const branches = git('for-each-ref', '--format=%(refname:short)', 'refs/heads/');
  return new Set(
    branches
      .split('\n')
      .filter((branch) => branch.startsWith('task/'))
      .map((branch) => branch.slice('task/'.length)),
  );
}

function worktreeOfBranch(branch: string): string | null {
  const porcelain = tryGit('worktree', 'list', '--porcelain');
  if (porcelain === null) {
    return null;
  }
  let currentPath: string | null = null;
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      currentPath = line.slice('worktree '.length);
    } else if (line === `branch refs/heads/${branch}` && currentPath) {
      return currentPath;
    }
  }
  return null;
}

function facts(source: BoardSource): BoardFacts {
  return { tasks: source.tasks, claimedIds: claimedIds() };
}

function reportBoard(source: BoardSource, tasks: TaskFile[]): void {
  const all = facts(source);
  const cycles = dependencyCycles(all.tasks);
  if (cycles.length > 0) {
    die(`Доска содержит цикл зависимостей: ${cycles.join(' → ')}. Чинить в PR, не в ветке задачи.`);
  }
  const byId = new Map(all.tasks.map((task) => [task.id, task]));
  const rows = tasks.map((task) => {
    const status = statusOf(task, all);
    const extras: string[] = [];
    if (status === 'in-progress') {
      const branchAge = tryGit('log', '-1', '--format=%ct', `task/${task.id}`);
      extras.push(
        `ветка task/${task.id}, ${humanAge(branchAge === null ? null : Math.max(0, Math.floor(Date.now() / 1000) - Number(branchAge)))}`,
      );
      const worktree = worktreeOfBranch(`task/${task.id}`);
      if (worktree && worktree !== git('rev-parse', '--show-toplevel')) {
        extras.push('есть worktree');
      }
    }
    if (status === 'blocked') {
      const open = task.dependsOn.filter((id) => byId.get(id)?.done !== true);
      if (open.length > 0) {
        extras.push(`ждёт: ${open.join(', ')}`);
      }
      if (task.needsHuman !== '') {
        extras.push(`нужно решение человека: ${task.needsHuman}`);
      }
    }
    return `${task.id.padEnd(8)} ${LABEL[status].padEnd(20)} [${task.priority}] ${task.title}${extras.length > 0 ? `\n          — ${extras.join('; ')}` : ''}`;
  });
  console.log(`Доска из ${source.ref ?? 'рабочего дерева'} (${humanAge(source.age)}):\n`);
  console.log(rows.join('\n'));
}

// --- next ---------------------------------------------------------------------

function currentTaskBranch(): string | null {
  const branch = git('branch', '--show-current');
  return branch.startsWith('task/') ? branch.slice('task/'.length) : null;
}

function showTaskState(id: string, source: BoardSource): void {
  const branch = `task/${id}`;
  const base = source.ref ?? 'main';
  const commits = tryGit('log', '--oneline', `${base}..${branch}`);
  console.log(`Задача ${id} — ветка ${branch} (база ${base}):`);
  if (!commits) {
    console.log('  коммитов над базой нет.');
  } else {
    console.log(
      `Коммиты:\n${commits
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n')}`,
    );
    const stat = tryGit('diff', '--stat', `${base}...${branch}`);
    if (stat) {
      console.log(
        `\nДифф:\n${stat
          .split('\n')
          .map((line) => `  ${line}`)
          .join('\n')}`,
      );
    }
  }
  const boardTask = source.tasks.find((task) => task.id === id);
  if (boardTask) {
    console.log(`\nЖурнал (раздел «Журнал» файла задачи):\n  ${journalOf(boardTask) || 'пусто'}`);
  }
}

/** Текст после заголовка «## Журнал» файла задачи — то, чего нет в диффе (ADR 0007). */
function journalOf(task: TaskFile): string {
  const raw = tryGit('show', `main:backlog/${task.done ? 'done/' : ''}${task.id}.md`) ?? '';
  const index = raw.indexOf('## Журнал');
  if (index < 0) {
    return '';
  }
  return raw
    .slice(index + '## Журнал'.length)
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .join('\n')
    .trim();
}

function commandNext(source: BoardSource): void {
  const current = currentTaskBranch();
  if (current !== null) {
    console.log(`Ты в worktree задачи ${current}: продолжай её по коммитам и журналу.\n`);
    showTaskState(current, source);
    return;
  }
  const all = facts(source);
  const open = all.tasks.filter((task) => !task.done);
  if (open.length === 0) {
    die('Доска пуста: свободных задач нет. Пополни доску PR-ом (декомпозиция), не в ветке задачи.');
  }
  const free = open.filter((task) => statusOf(task, all) === 'free');
  const maintenance = open.filter((task) => statusOf(task, all) === 'maintenance');
  if (free.length === 0) {
    const blocked = open.filter((task) => statusOf(task, all) === 'blocked');
    const lines = [
      'Свободных задач нет.',
      blocked.length > 0
        ? `Заблокированы (ждут зависимости или человека): ${blocked.map((task) => task.id).join(', ')}.`
        : 'Все открытые задачи заняты агентами этого клона.',
      'Возьми задачу по прямому поручению человека или пополни доску.',
    ];
    die(lines.join('\n'));
  }
  const inProgress = open.filter((task) => all.claimedIds.has(task.id));
  const sorted = free.toSorted(
    (a, b) =>
      PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority) ||
      Number(touchesOverlap(b, inProgress)) - Number(touchesOverlap(a, inProgress)) ||
      a.id.localeCompare(b.id),
  );
  const chosen = sorted[0];
  if (chosen === undefined) {
    die('Свободных задач нет.');
  }
  const overlapping = sorted.filter((task) => touchesOverlap(task, inProgress));
  if (overlapping.length > 0) {
    console.error(
      `Пути пересекаются с задачами в работе (${overlapping.map((task) => task.id).join(', ')}) — они в конце списка. Возможны конфликты слияния (ADR 0007).`,
    );
  }
  if (maintenance.length > 0) {
    console.error(
      `Задачи режима обслуживания агенту не выдаются, перечислены человеку: ${maintenance.map((task) => task.id).join(', ')}. Начинает их человек: включает режим обслуживания и называет id.`,
    );
  }
  console.log(
    `Следующая свободная задача: ${chosen.id} — ${chosen.title} [${chosen.priority}]\nЗахвати её: pnpm backlog start ${chosen.id}`,
  );
}

// --- start / resume / release ---------------------------------------------------

function repoRoot(): string {
  return git('rev-parse', '--show-toplevel');
}

function mainCheckout(): boolean {
  return (
    git('rev-parse', '--path-format=absolute', '--git-common-dir') === path.join(repoRoot(), '.git')
  );
}

/** Путь для нового worktree: рядом с репозиторием (ADR 0007, «Рабочее место»). */
function worktreePath(id: string): string {
  const root = repoRoot();
  return path.join(path.dirname(root), `${path.basename(root)}-task-${id}`);
}

function createWorktree(id: string, branch: string): boolean {
  if (worktreeOfBranch(branch) !== null) {
    const existing = worktreeOfBranch(branch);
    console.log(
      `У ветки ${branch} уже есть worktree: ${existing}\nОткрой его средствами клиента и работай там.`,
    );
    return true;
  }
  if (!mainCheckout()) {
    console.log(
      `Ветка ${branch} захвачена. Ты в worktree другой ветки — открой worktree задачи средствами клиента:\n  git worktree add '${worktreePath(id)}' ${branch}`,
    );
    return true;
  }
  const target = worktreePath(id);
  const created = tryGit('worktree', 'add', target, branch);
  if (created === null) {
    console.log(
      `Ветка ${branch} захвачена, но worktree создать не удалось (песочница может запрещать запись вне каталога проекта).\nСоздай его средствами клиента:\n  git worktree add '${target}' ${branch}\nи открой как workspace.`,
    );
    return true;
  }
  console.log(
    `Захвачено: ${branch}\nРабочее место: ${target}\nОткрой этот каталог как workspace и работай там.`,
  );
  return true;
}

function commandStart(id: string, source: BoardSource): void {
  const task = source.tasks.find((item) => item.id === id);
  if (!task || task.done) {
    die(`Задачи ${id} нет на доске (из ${source.ref ?? 'рабочего дерева'}) или она закрыта.`);
  }
  const all = facts(source);
  const status = statusOf(task, all);
  if (all.claimedIds.has(id)) {
    die(
      `Задача ${id} занята (ветка task/${id} уже существует).\nВозьми другую: pnpm backlog next. Освободить задачу может только человек: pnpm backlog release ${id}.`,
    );
  }
  if (status === 'maintenance') {
    die(
      `Задача ${id} требует режима обслуживания (touches попадает под защищённые пути). Агент её не начинает: это делает человек, включая режим обслуживания.`,
    );
  }
  if (status === 'blocked') {
    const byId = new Map(all.tasks.map((item) => [item.id, item]));
    const open = task.dependsOn.filter((dep) => byId.get(dep)?.done !== true);
    die(
      `Задача ${id} заблокирована: ${open.length > 0 ? `ждёт ${open.join(', ')}` : `нужно решение человека: ${task.needsHuman}`}.`,
    );
  }
  // Захват — атомарное создание ветки от main: два одновременных start одной
  // задачи дают отказ второму (свойство общего хранилища ссылок, ADR 0007).
  const created = tryGit('branch', `task/${id}`, source.ref ?? 'main');
  if (created === null) {
    die(`Задача ${id} занята: ветка task/${id} уже существует. Возьми другую: pnpm backlog next.`);
  }
  createWorktree(id, `task/${id}`);
}

function commandResume(id: string, source: BoardSource): void {
  if (tryGit('rev-parse', '--verify', `task/${id}`) === null) {
    die(`Ветки task/${id} нет: нечего продолжать. Свободные задачи: pnpm backlog next.`);
  }
  console.log(`Продолжение задачи ${id} по поручению человека (ADR 0007).`);
  showTaskState(id, source);
  createWorktree(id, `task/${id}`);
}

function commandRelease(id: string): void {
  if (!process.stdin.isTTY) {
    die(
      `release требует интерактивного терминала: освобождает задачу только человек (ADR 0007). Агент чужую задачу не перехватывает.`,
    );
  }
  const branch = `task/${id}`;
  if (tryGit('rev-parse', '--verify', branch) === null) {
    die(`Ветки ${branch} нет: освобождать нечего.`);
  }
  let target = `abandoned/${id}`;
  for (let suffix = 2; tryGit('rev-parse', '--verify', target) !== null; suffix += 1) {
    target = `abandoned/${id}-${suffix}`;
  }
  // Переименование, а не удаление: обратимо, журнал коммитов сохраняется.
  git('branch', '-m', branch, target);
  const worktree = worktreeOfBranch(target);
  console.log(
    `Задача ${id} освобождена: ветка переименована в ${target}${worktree ? ` (worktree: ${worktree})` : ''}.\nЕсли worktree больше не нужен: git worktree remove '${worktree ?? ''}'`,
  );
}

// --- close / doctor -------------------------------------------------------------

function commandClose(id: string, source: BoardSource): void {
  const task = source.tasks.find((item) => item.id === id);
  if (!task) {
    die(`Задачи ${id} нет на доске (из ${source.ref ?? 'рабочего дерева'}).`);
  }
  if (task.done) {
    die(`Задача ${id} уже закрыта (backlog/done/${id}.md в ${source.ref ?? 'рабочем дереве'}).`);
  }
  const current = git('branch', '--show-current');
  if (current.startsWith('task/') && current !== `task/${id}`) {
    die(
      `На ветке ${current} закрывается только своя задача (${current.slice('task/'.length)}). Задачу ${id} закрывает её PR или отдельный PR гигиены.`,
    );
  }
  const openPath = path.join(repoRoot(), 'backlog', `${id}.md`);
  if (!existsSync(openPath)) {
    die(
      `backlog/${id}.md нет в рабочем дереве: перенос уже сделан или файл задачи ещё не в этой ветке. Ветка задачи обязана нести перенос (ADR 0007, «Замыкание задачи»).`,
    );
  }
  mkdirSync(path.join(repoRoot(), 'backlog', 'done'), { recursive: true });
  git('mv', `backlog/${id}.md`, `backlog/done/${id}.md`);
  console.log(
    `Задача ${id}: файл перенесён в backlog/done/${id}.md.\nДополни «Журнал» итогом (что смержено, что дальше) и включи перенос в свой PR — доска обновится после merge.`,
  );
}

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

function commandDoctor(source: BoardSource): void {
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

// --- Вход ------------------------------------------------------------------------

const [command, id] = process.argv.slice(2);
const source = loadBoard();
const cycles = dependencyCycles(source.tasks);
if (cycles.length > 0) {
  die(`Доска содержит цикл зависимостей: ${cycles.join(' → ')}. Чинить в PR, не в ветке задачи.`);
}

if (
  command === undefined ||
  !['list', 'next', 'start', 'close', 'resume', 'release', 'doctor'].includes(command)
) {
  die(
    'Команды доски (ADR 0007):\n  pnpm backlog list\n  pnpm backlog next\n  pnpm backlog start <id>\n  pnpm backlog close <id>    — закрыть: перенос файла в done/ тем же PR\n  pnpm backlog resume <id>\n  pnpm backlog release <id>  — только человек\n  pnpm backlog doctor        — расхождения «смержена — доска не знает»',
  );
}

switch (command) {
  case 'list': {
    reportBoard(
      source,
      source.tasks.filter((task) => !task.done),
    );
    const leftover = claimedIds();
    const openIds = new Set(source.tasks.filter((task) => !task.done).map((task) => task.id));
    const stale = [...leftover].filter((claim) => !openIds.has(claim));
    if (stale.length > 0) {
      console.log(
        `\nВетки задач без открытой задачи (закрыты или переименованы): ${stale.map((claim) => `task/${claim}`).join(', ')}. Можно удалить: git branch -d.`,
      );
    }
    break;
  }
  case 'next':
    commandNext(source);
    break;
  case 'start':
    if (!id) {
      die('Укажи id: pnpm backlog start <id>');
    }
    commandStart(id, source);
    break;
  case 'close':
    if (!id) {
      die('Укажи id: pnpm backlog close <id>');
    }
    commandClose(id, source);
    break;
  case 'doctor':
    commandDoctor(source);
    break;
  case 'resume':
    if (!id) {
      die('Укажи id: pnpm backlog resume <id>');
    }
    commandResume(id, source);
    break;
  case 'release':
    if (!id) {
      die('Укажи id: pnpm backlog release <id>');
    }
    commandRelease(id);
    break;
}
