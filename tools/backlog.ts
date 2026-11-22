/**
 * Доска задач для параллельных агентов (ADR 0007).
 *
 *   pnpm backlog list            доска со статусами
 *   pnpm backlog next            следующая свободная задача (или состояние текущей)
 *   pnpm backlog start <id>      захват веткой task/<id> + рабочее место (worktree)
 *   pnpm backlog close <id>      закрыть: git mv backlog/<id>.md backlog/done/ (ADR 0007, «Замыкание задачи»)
 *   pnpm backlog resume <id>     продолжить брошенную по поручению человека
 *   pnpm backlog release <id>    освободить задачу (только человек, интерактивный терминал)
 *   pnpm backlog doctor          расхождения «смержена — доска не знает» (делегирование
 *                                tools/backlog-doctor.ts: логика doctor живёт там —
 *                                гейт review-класса не ослабляет, ADR 0014)
 *   pnpm backlog inbox [--json]  что ждёт человека: PR веток task/* на approve/label/merge,
 *                                needs_human «человек: …», «отложено: …», брошенные захваты,
 *                                забытый файл режима обслуживания (e8; логика —
 *                                tools/backlog-inbox.ts, вердикт label — gate-approval-core)
 *
 * Флаг оператора (ADR 0009): `next --operator` выдаёт следующую задачу режима
 * обслуживания или needs_human «оператор: …», `start <id> --operator` захватывает
 * её тем же атомарным созданием ветки. doctor красит забытый файл режима
 * обслуживания (.claude/settings.local.json) в основном checkout безусловно,
 * в worktree задачи — при открытом PR или простое ветки дольше порога.
 *
 * Доска читается из ссылки main (а не из рабочего дерева): у каждого worktree
 * своё дерево, а ветка не должна снимать с себя блокировку (З2). Если ссылки
 * main нет (свежий worktree без fetch), команда печатает возраст данных и
 * читает рабочее дерево, а не молчит (З11). Захват — создание локальной ветки:
 * ссылки git общие для всех worktree клона, создание атомарно.
 *
 * Класс защиты: review (ADR 0014) — интерфейс агента, не гейт; импортирует
 * deny-модули (backlog-board, backlog-doctor), не наоборот.
 */
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import {
  claimedIds,
  die,
  git,
  humanAge,
  loadBoard,
  openPrHeads,
  runDoctor,
  tryGit,
  tryRun,
  type BoardSource,
} from './backlog-doctor.ts';
import {
  dependencyCycles,
  invalidNeedsHuman,
  isOperatorTask,
  needsHumanKind,
  openDependentsCount,
  PRIORITIES,
  statusOf,
  touchesOverlap,
  type BoardFacts,
  type NeedsHumanKind,
  type TaskFile,
  type TaskStatus,
} from './backlog-board.ts';
import {
  buildInboxItems,
  GATE_LABEL,
  parsePrView,
  sortInboxItems,
  type Inbox,
  type LabelState,
  type PrFact,
} from './backlog-inbox.ts';
import { evaluateApproval, lastLabeledEvent, maintainersOf } from './gate-approval-core.ts';
import { protectionOf } from './protected-paths.ts';

const LABEL: Record<TaskStatus, string> = {
  done: 'закрыта',
  'in-progress': 'в работе',
  blocked: 'заблокирована',
  maintenance: 'режим обслуживания',
  free: 'свободна',
};

/** Статус вместо общего «заблокирована» — по виду needs_human (ADR 0009). */
const NEEDS_HUMAN_LABEL: Record<NeedsHumanKind, string> = {
  operator: 'нужен оператор',
  deferred: 'отложено',
  human: 'нужен человек',
};

// --- Доска из ссылки main ------------------------------------------------------
// Чтение доски (loadBoard) и git/gh-хелперы живут в tools/backlog-doctor.ts
// (deny, ADR 0014): doctor — их основной потребитель, CLI импортирует их.

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
    const kind = needsHumanKind(task.needsHuman);
    const label = status === 'blocked' && kind !== null ? NEEDS_HUMAN_LABEL[kind] : LABEL[status];
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
        extras.push(task.needsHuman);
      }
    }
    return `${task.id.padEnd(8)} ${label.padEnd(20)} [${task.priority}] ${task.title}${extras.length > 0 ? `\n          — ${extras.join('; ')}` : ''}`;
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

function commandNext(source: BoardSource, operator: boolean): void {
  const current = currentTaskBranch();
  if (current !== null) {
    console.log(`Ты в worktree задачи ${current}: продолжай её по коммитам и журналу.\n`);
    showTaskState(current, source);
    return;
  }
  const all = facts(source);
  const open = all.tasks.filter((task) => !task.done);
  if (operator) {
    commandNextOperator(source, all, open);
    return;
  }
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
      PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority) || a.id.localeCompare(b.id),
  );
  // D7 (запрет при пересечении): задача, чьи touches пересекаются с задачами
  // в работе, не выдаётся. Захват всё равно встречает отказ в start под замком
  // (commandStart): выдача — подсказка, граница — отказ захвата.
  const overlapping = sorted.filter((task) => touchesOverlap(task, inProgress));
  const issued = sorted.filter((task) => !touchesOverlap(task, inProgress));
  if (issued.length === 0) {
    die(
      `Свободные задачи есть, но их touches пересекаются с задачами в работе (D7): ${overlapping.map((task) => task.id).join(', ')}.\nДождись мержа пересекающихся задач (их диффы сузят конфликты) или возьми работу по прямому поручению человека (ADR 0007, «Работа вне доски»).`,
    );
  }
  const chosen = issued[0];
  if (chosen === undefined) {
    die('Свободных задач нет.');
  }
  if (overlapping.length > 0) {
    console.error(
      `Пути пересекаются с задачами в работе — не выдаются (D7): ${overlapping.map((task) => task.id).join(', ')}. Возврат в выдачу — после мержа пересекающихся задач.`,
    );
  }
  if (maintenance.length > 0) {
    console.error(
      `Задачи режима обслуживания агенту не выдаются, их ведёт оператор: ${maintenance.map((task) => task.id).join(', ')}. Операторская сессия берёт их через pnpm backlog next --operator (ADR 0009).`,
    );
  }
  console.log(
    `Следующая свободная задача: ${chosen.id} — ${chosen.title} [${chosen.priority}]\nЗахвати её: pnpm backlog start ${chosen.id}`,
  );
}

/**
 * Ветки задач оператора этого клона без открытого PR — они занимают слот
 * «одна операторская задача за раз» (ADR 0009, «Очерёдность»). gh недоступен →
 * PR-состояние неизвестно, ветка считается ведущейся (fail-closed), причина
 * печатается здесь (З11).
 */
function busyOperatorClaims(all: BoardFacts): string[] {
  const byId = new Map(all.tasks.map((task) => [task.id, task]));
  const claims = [...all.claimedIds].filter((id) => {
    const task = byId.get(id);
    return task !== undefined && !task.done && isOperatorTask(task);
  });
  if (claims.length === 0) {
    return [];
  }
  const prHeads = openPrHeads();
  if (prHeads === null) {
    console.error(
      'gh недоступен: открытые PR веток не проверены — считаю операторскую задачу ведущейся (ADR 0009).',
    );
  }
  return claims.filter((id) => prHeads === null || !prHeads.has(`task/${id}`));
}

function commandNextOperator(source: BoardSource, all: BoardFacts, open: TaskFile[]): void {
  const byId = new Map(all.tasks.map((task) => [task.id, task]));
  const active = busyOperatorClaims(all);
  if (active.length > 0) {
    die(
      `В клоне уже ведётся задача оператора без открытого PR: ${active.map((id) => `task/${id}`).join(', ')}.\nОдна операторская задача за раз (ADR 0009): открой PR по ней, либо человек освобождает: pnpm backlog release <id>.\nЕсли PR по ней уже открыт, а gh недоступен — захвати следующую напрямую: pnpm backlog start <id> --operator.`,
    );
  }
  const candidates = open
    .filter((task) => !all.claimedIds.has(task.id))
    .filter((task) => !task.dependsOn.some((dep) => byId.get(dep)?.done !== true))
    .filter(isOperatorTask)
    .toSorted(
      (a, b) =>
        PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority) ||
        openDependentsCount(b.id, all.tasks) - openDependentsCount(a.id, all.tasks) ||
        a.id.localeCompare(b.id),
    );
  const chosen = candidates[0];
  if (chosen === undefined) {
    die(
      'Задач оператора нет: ни режима обслуживания, ни needs_human «оператор: …» со снятыми зависимостями.',
    );
  }
  const dependents = openDependentsCount(chosen.id, all.tasks);
  console.log(
    `Следующая задача оператора: ${chosen.id} — ${chosen.title} [${chosen.priority}], открывает задач: ${dependents}\nЗахвати её: pnpm backlog start ${chosen.id} --operator\nРежим обслуживания включается в worktree задачи и выключается до открытия PR (ADR 0009).`,
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

function commandStart(id: string, source: BoardSource, operator: boolean): void {
  const task = source.tasks.find((item) => item.id === id);
  if (!task || task.done) {
    die(`Задачи ${id} нет на доске (из ${source.ref ?? 'рабочего дерева'}) или она закрыта.`);
  }
  const all = facts(source);
  const status = statusOf(task, all);
  const kind = needsHumanKind(task.needsHuman);
  if (all.claimedIds.has(id)) {
    die(
      `Задача ${id} занята (ветка task/${id} уже существует).\nВозьми другую: pnpm backlog next. Освободить задачу может только человек: pnpm backlog release ${id}.`,
    );
  }
  const byId = new Map(all.tasks.map((item) => [item.id, item]));
  const open = task.dependsOn.filter((dep) => byId.get(dep)?.done !== true);
  if (open.length > 0) {
    die(`Задача ${id} заблокирована: ждёт ${open.join(', ')}.`);
  }
  if (status === 'maintenance' || kind === 'operator') {
    if (!operator) {
      die(
        `Задача ${id} — задача оператора (${status === 'maintenance' ? 'режим обслуживания: touches под защищёнными путями' : 'needs_human «оператор: …»'}). Обычная сессия её не начинает: захватывает оператор — pnpm backlog start ${id} --operator (ADR 0009).`,
      );
    }
    // Слот «одна операторская задача за раз» проверяет next --operator; start
    // с явным id его сознательно не проверяет: эскейп-хатч next при
    // недоступном gh — «захвати следующую напрямую» (подсказка, не граница, З3).
  } else if (kind === 'deferred' || kind === 'human') {
    die(
      `Задача ${id} заблокирована: ${kind === 'deferred' ? 'отложено' : 'нужно решение человека'}: ${task.needsHuman}.`,
    );
  } else if (task.needsHuman !== '') {
    // Fail-closed: невалидный needs_human не захватывается ни с флагом, ни без —
    // даже если гейт docs ещё не добежал (доска из fallback на рабочее дерево).
    const problem = invalidNeedsHuman(task.needsHuman);
    die(`Задача ${id} заблокирована: needs_human: ${problem ?? 'невалидное значение'}`);
  }
  // Захват — атомарное создание ветки от main: два одновременных start одной
  // задачи дают отказ второму (свойство общего хранилища ссылок, ADR 0007).
  const created = tryGit('branch', `task/${id}`, source.ref ?? 'main');
  if (created === null) {
    die(`Задача ${id} занята: ветка task/${id} уже существует. Возьми другую: pnpm backlog next.`);
  }
  // D7 (запрет при пересечении): проверка под замком — единственный атомарный
  // примитив клона это создание ветки, поэтому пересечение проверяется ПОСЛЕ
  // захвата. Три условия: (а) claimedIds перечитаны заново (свежий
  // for-each-ref, tools/backlog-doctor.ts) — снапшот из начала команды устарел
  // бы между проверкой и захватом, и два параллельных start пересекающихся
  // задач прошли бы оба; (б) собственный id исключён: сразу после создания
  // ветки задача сама в claimedIds, а touchesOverlap(task, [task]) всегда
  // true — без исключения каждый start самооткажется; (в) откат — git branch
  // -D (не -d: HEAD-зависимая «not fully merged» из worktree другой задачи),
  // у ветки секунды жизни и ноль своих коммитов; неудача отката — громкий
  // отказ: фантомный клейм блокирует задачу всему клону, снимает release.
  const freshClaimed = claimedIds();
  freshClaimed.delete(id);
  const freshOverlaps = source.tasks.filter(
    (item) => !item.done && freshClaimed.has(item.id) && touchesOverlap(task, [item]),
  );
  if (freshOverlaps.length > 0) {
    const rolledBack = tryGit('branch', '-D', `task/${id}`);
    if (rolledBack === null) {
      die(
        `Проверка под замком отказала (${freshOverlaps.map((other) => other.id).join(', ')}), но откат ветки task/${id} не удался — фантомный клейм. Освобождает человек: pnpm backlog release ${id}.`,
      );
    }
    die(
      `Задача ${id} пересекается по touches с задачами в работе (D7): ${freshOverlaps.map((other) => other.id).join(', ')}.\nВетка task/${id} откачена. Дождись их мержа или возьми другую: pnpm backlog next.`,
    );
  }
  createWorktree(id, `task/${id}`);
}

function commandResume(id: string, source: BoardSource, operator: boolean): void {
  if (tryGit('rev-parse', '--verify', `task/${id}`) === null) {
    die(`Ветки task/${id} нет: нечего продолжать. Свободные задачи: pnpm backlog next.`);
  }
  // Worktree задачи оператора содержит включённый режим обслуживания:
  // обычная сессия туда не заходит, продолжает оператор (ADR 0009).
  const task = source.tasks.find((item) => item.id === id);
  if (task !== undefined && !task.done && isOperatorTask(task) && !operator) {
    die(
      `Задача ${id} — задача оператора: в её worktree включён режим обслуживания. Продолжает оператор: pnpm backlog resume ${id} --operator (ADR 0009).`,
    );
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

// --- inbox -----------------------------------------------------------------------

/** Путь основного checkout: общий .git лежит в нём даже из worktree. */
function mainCheckoutRoot(): string {
  return path.dirname(git('rev-parse', '--path-format=absolute', '--git-common-dir'));
}

/** Возраст веток task/* в часах — тот же расчёт, что у doctor (idle-claim). */
function branchAgeHoursOf(ids: Set<string>): Map<string, number> {
  const ages = new Map<string, number>();
  for (const id of ids) {
    const timestamp = tryGit('log', '-1', '--format=%ct', `task/${id}`);
    if (timestamp !== null && Number.isFinite(Number(timestamp))) {
      ages.set(id, Math.max(0, (Date.now() / 1000 - Number(timestamp)) / 3600));
    }
  }
  return ages;
}

/**
 * Открытые PR веток task/* с разбором вывода gh. gh недоступен — null: инбокс
 * печатает неполноту, а не пустой список (З11); нечитаемый view одного PR —
 * строка в неполные, остальные PR собираются.
 */
function collectPrFacts(): { prs: PrFact[]; incomplete: string[] } | null {
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
  const prs: PrFact[] = [];
  const incomplete: string[] = [];
  for (const branch of raw.split('\n').filter((name) => name.startsWith('task/'))) {
    const view = tryRun('gh', [
      'pr',
      'view',
      branch,
      '--json',
      'number,headRefName,title,reviewDecision,labels,files,commits,statusCheckRollup,mergeable,isDraft',
    ]);
    if (view === null) {
      incomplete.push(`PR ветки ${branch}: вывод gh не прочитан — строка неполная (З11)`);
      continue;
    }
    const fact = parsePrView(view);
    if (fact === null) {
      incomplete.push(
        `PR ветки ${branch}: вывод gh не разобран (неожиданная форма JSON) — строка неполная (З11)`,
      );
      continue;
    }
    prs.push(fact);
  }
  return { prs, incomplete };
}

/**
 * Состояние label-гейта для PR, правящего защищённые пути (ADR 0002): вердикт
 * считает evaluateApproval из gate-approval-core — та же семантика, что у CI
 * (label действителен, только если поставлен владельцем CODEOWNERS после
 * последнего push). Отдельно вычисляется «снят новым push» — та же пара
 * сравнений дат, что в ядре: на этот случай инбокс заводит свою строку
 * с призывом поставить label заново.
 */
function labelStateFor(pr: PrFact, repo: string | null, maintainers: Set<string>): LabelState {
  const needed = pr.files.some((file) => protectionOf(file) === 'deny');
  if (!needed) {
    return { needed: false, approved: true, reason: '', staleByPush: false };
  }
  const eventsRaw =
    repo === null ? null : tryRun('gh', ['api', `repos/${repo}/issues/${pr.number}/events`]);
  let events: unknown[] = [];
  if (eventsRaw !== null) {
    try {
      const parsed: unknown = JSON.parse(eventsRaw);
      if (Array.isArray(parsed)) {
        events = parsed;
      }
    } catch {
      events = [];
    }
  }
  const verdict = evaluateApproval({
    label: GATE_LABEL,
    prLabels: pr.labels,
    events,
    pushedAt: pr.headCommittedAt ?? undefined,
    maintainers,
  });
  const event = lastLabeledEvent(events, GATE_LABEL);
  const staleByPush =
    pr.labels.includes(GATE_LABEL) &&
    event !== undefined &&
    pr.headCommittedAt !== null &&
    !Number.isNaN(Date.parse(pr.headCommittedAt)) &&
    Date.parse(event.createdAt) <= Date.parse(pr.headCommittedAt);
  return { needed: true, approved: verdict.approved, reason: verdict.reason, staleByPush };
}

function reportInbox(source: BoardSource, inbox: Inbox): void {
  console.log(
    `Инбокс человека — доска из ${source.ref ?? 'рабочего дерева'} (${humanAge(source.age)}):\n`,
  );
  const actionable = inbox.items.filter((item) => item.actionable);
  const passive = inbox.items.filter((item) => !item.actionable);
  if (actionable.length === 0) {
    console.log('Действий человека нет.');
  } else {
    console.log(
      actionable
        .map((item, index) => {
          const weight = item.unblocks > 0 ? ` [разблокирует: ${item.unblocks}]` : '';
          return `${index + 1}. ${item.action}${weight}\n     — ${item.note}`;
        })
        .join('\n'),
    );
  }
  if (passive.length > 0) {
    console.log(
      `\nБез действий (перечислено состояние, не призыв):\n${passive
        .map((item) => `  - ${item.target}: ${item.note}`)
        .join('\n')}`,
    );
  }
  if (inbox.incomplete.length > 0) {
    console.error(
      `\nИнбокс неполный (${inbox.incomplete.length}) — не принимай его за «человеку делать нечего»:\n${inbox.incomplete
        .map((line) => `  - ${line}`)
        .join('\n')}`,
    );
  }
}

function commandInbox(source: BoardSource, json: boolean): void {
  const collected = collectPrFacts();
  const prs = collected === null ? null : collected.prs;
  const claims = claimedIds();
  // Repo и владельцы CODEOWNERS читаются лениво: нужны только PR, правящим
  // защищённые пути (у остальных label-гейт не применяется, ADR 0002).
  let labelContext: { repo: string | null; maintainers: Set<string> } | null = null;
  const labelStates = new Map<number, LabelState>();
  for (const pr of prs ?? []) {
    if (!pr.files.some((file) => protectionOf(file) === 'deny')) {
      continue;
    }
    if (labelContext === null) {
      labelContext = {
        repo: tryRun('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']),
        maintainers: maintainersOf([
          path.join(repoRoot(), '.github', 'CODEOWNERS'),
          path.join(repoRoot(), 'CODEOWNERS'),
          path.join(repoRoot(), 'docs', 'CODEOWNERS'),
        ]),
      };
    }
    labelStates.set(pr.number, labelStateFor(pr, labelContext.repo, labelContext.maintainers));
  }
  const inbox = buildInboxItems({
    tasks: source.tasks,
    prs,
    labelStates,
    branchAgeHours: branchAgeHoursOf(claims),
    claimedIds: claims,
    maintenanceFileFound: existsSync(
      path.join(mainCheckoutRoot(), '.claude', 'settings.local.json'),
    ),
  });
  if (collected !== null) {
    inbox.incomplete.push(...collected.incomplete);
  }
  const items = sortInboxItems(inbox.items);
  if (json) {
    console.log(
      JSON.stringify(
        {
          source: source.ref ?? 'рабочее дерево',
          complete: inbox.incomplete.length === 0,
          incomplete: inbox.incomplete,
          items: items.map((item) => ({
            kind: item.kind,
            action: item.action,
            target: item.target,
            unblocks: item.unblocks,
            note: item.note,
            actionable: item.actionable,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }
  reportInbox(source, { items, incomplete: inbox.incomplete });
}

// --- Вход ------------------------------------------------------------------------

const argv = process.argv.slice(2);
const operator = argv.includes('--operator');
const json = argv.includes('--json');
const unknownFlags = argv.filter(
  (arg) => arg.startsWith('--') && arg !== '--operator' && arg !== '--json',
);
if (unknownFlags.length > 0) {
  die(
    `Неизвестный флаг: ${unknownFlags.join(', ')}. Флаги доски — --operator (ADR 0009) и --json у inbox.`,
  );
}
const positional = argv.filter((arg) => arg !== '--operator' && arg !== '--json');
const [command, id] = positional;
const source = loadBoard();
const cycles = dependencyCycles(source.tasks);
if (cycles.length > 0) {
  die(`Доска содержит цикл зависимостей: ${cycles.join(' → ')}. Чинить в PR, не в ветке задачи.`);
}
if (json && command !== 'inbox') {
  die('Флаг --json поддерживает только pnpm backlog inbox.');
}

if (
  command === undefined ||
  !['list', 'next', 'start', 'close', 'resume', 'release', 'doctor', 'inbox'].includes(command)
) {
  die(
    'Команды доски (ADR 0007):\n  pnpm backlog list\n  pnpm backlog next\n  pnpm backlog start <id>\n  pnpm backlog close <id>    — закрыть: перенос файла в done/ тем же PR\n  pnpm backlog resume <id>\n  pnpm backlog release <id>  — только человек\n  pnpm backlog doctor        — расхождения «смержена — доска не знает»\n  pnpm backlog inbox         — что ждёт человека (e8); --json — машиночитаемо\nФлаг оператора (ADR 0009):\n  pnpm backlog next --operator        — следующая задача оператора\n  pnpm backlog start <id> --operator  — захват задачи режима обслуживания или needs_human «оператор: …»',
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
    commandNext(source, operator);
    break;
  case 'start':
    if (!id) {
      die('Укажи id: pnpm backlog start <id>');
    }
    commandStart(id, source, operator);
    break;
  case 'close':
    if (!id) {
      die('Укажи id: pnpm backlog close <id>');
    }
    commandClose(id, source);
    break;
  case 'doctor':
    // Логика doctor — в tools/backlog-doctor.ts (deny); CLI только делегирует (ADR 0014).
    runDoctor(source);
    break;
  case 'inbox':
    commandInbox(source, json);
    break;
  case 'resume':
    if (!id) {
      die('Укажи id: pnpm backlog resume <id>');
    }
    commandResume(id, source, operator);
    break;
  case 'release':
    if (!id) {
      die('Укажи id: pnpm backlog release <id>');
    }
    commandRelease(id);
    break;
}
