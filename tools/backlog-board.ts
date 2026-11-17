/**
 * Модель доски задач (ADR 0007): разбор файла `backlog/<id>.md`, валидация
 * и вычисление статуса. Общий модуль для гейта docs (tools/check-docs.ts),
 * CLI (tools/backlog.ts) и его тестов. Без зависимостей из node_modules:
 * `protectionOf` импортирует tools/protected-paths.ts, который тоже свободен
 * от них — статус «нужен режим обслуживания» считает CLI, а хуки агента
 * этот модуль не импортируют.
 */
import { matchesGlob } from 'node:path';

import { protectionOf } from './protected-paths.ts';

export const TASK_TYPES = ['research', 'decompose', 'change'] as const;
export const PRIORITIES = ['high', 'medium', 'low'] as const;
export type TaskType = (typeof TASK_TYPES)[number];
export type Priority = (typeof PRIORITIES)[number];

/** Поля front matter: «ключ: значение» или «ключ: значение, значение» (список в строку). */
export interface TaskFile {
  id: string;
  title: string;
  type: TaskType;
  priority: Priority;
  dependsOn: string[];
  touches: string[];
  needsHuman: string;
  /** true, если файл лежит в backlog/done/. */
  done: boolean;
}

export class BoardError extends Error {
  readonly file: string | undefined;

  constructor(message: string, file?: string) {
    super(file ? `${file}: ${message}` : message);
    this.file = file;
  }
}

export const ID_RE = /^[a-z0-9][a-z0-9.-]*$/;

// --- Разбор ------------------------------------------------------------------

/**
 * Разбирает front matter «ключ: значение или список в строку». Новой зависимости
 * ради него не нужно (ADR 0007, D3): только текстовые значения и списки через запятую.
 */
export function parseTask(id: string, raw: string, done = false): TaskFile {
  if (!ID_RE.test(id)) {
    throw new BoardError(`id «${id}» не подходит под ${ID_RE.source}`, `backlog/${id}.md`);
  }
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (!match) {
    throw new BoardError('нет front matter «--- … ---»', `backlog/${id}.md`);
  }
  const fields = new Map<string, string>();
  const block = match[1];
  if (block === undefined) {
    throw new BoardError('пустой front matter', `backlog/${id}.md`);
  }
  for (const [index, line] of block.split('\n').entries()) {
    if (line.trim() === '') {
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) {
      throw new BoardError(
        `строка ${index + 1} front matter не вида «ключ: значение»`,
        `backlog/${id}.md`,
      );
    }
    const key = line.slice(0, colon).trim();
    if (fields.has(key)) {
      throw new BoardError(`поле «${key}» указано дважды`, `backlog/${id}.md`);
    }
    fields.set(key, line.slice(colon + 1).trim());
  }

  const list = (key: string): string[] =>
    (fields.get(key) ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);

  const type = fields.get('type');
  const typeNarrow = TASK_TYPES.find((candidate) => candidate === type);
  if (typeNarrow === undefined) {
    throw new BoardError(`type должен быть одним из: ${TASK_TYPES.join(', ')}`, `backlog/${id}.md`);
  }
  const priority = fields.get('priority');
  const priorityNarrow = PRIORITIES.find((candidate) => candidate === priority);
  if (priorityNarrow === undefined) {
    throw new BoardError(
      `priority должен быть одним из: ${PRIORITIES.join(', ')}`,
      `backlog/${id}.md`,
    );
  }
  const title = fields.get('title');
  if (!title) {
    throw new BoardError('нет поля title', `backlog/${id}.md`);
  }
  return {
    id,
    title,
    type: typeNarrow,
    priority: priorityNarrow,
    dependsOn: list('depends_on'),
    touches: list('touches'),
    needsHuman: fields.get('needs_human') ?? '',
    done,
  };
}

/**
 * Вид непустого needs_human (ADR 0009): «оператор: …» берёт операторская
 * сессия, «отложено: …» ждёт проверяемого условия, «человек: …» — действие
 * из строки «Что остаётся человеку» (приёмка PR, секреты, аккаунты).
 */
export type NeedsHumanKind = 'operator' | 'deferred' | 'human';

export function needsHumanKind(needsHuman: string): NeedsHumanKind | null {
  if (needsHuman.startsWith('оператор:')) {
    return 'operator';
  }
  if (needsHuman.startsWith('отложено:')) {
    return 'deferred';
  }
  if (needsHuman.startsWith('человек:')) {
    return 'human';
  }
  return null;
}

/**
 * «оператор:» не может называть действие приёмки PR или ввод секрета:
 * у изменения гейта не останется независимой проверки (ADR 0009,
 * «Что остаётся человеку»). Латиница — по границе слова, кириллица — по корню.
 * Список корней — best-effort подсказка, не граница (З3): синтаксические
 * синонимы он не покрывает; детерминированная часть правила — префиксы,
 * настоящая граница — ревью и приёмка человека.
 */
const OPERATOR_UNDELEGATABLE =
  /(?:\b(?:label|approve|merge)\b|парол|токен|аккаунт|мерж|смерж|аппрув|апрув|лейбл|метку|метка|секре|подтверждени|платн)/i;

/** null — значение корректно; строка — что именно не так (гейт docs). */
export function invalidNeedsHuman(needsHuman: string): string | null {
  if (needsHuman === '') {
    return null;
  }
  const kind = needsHumanKind(needsHuman);
  if (kind === null) {
    return 'непустой needs_human начинается с «оператор:», «отложено:» или «человек:» — действие, которое остаётся человеку, помечай «человек: …» (ADR 0009)';
  }
  if (kind === 'operator' && OPERATOR_UNDELEGATABLE.test(needsHuman)) {
    return '«оператор:» называет действие приёмки (label/approve/merge и однокоренные, пароли, токены, секреты, коды подтверждения, платные ресурсы, аккаунты) — оператору оно не делегируется, помечай «человек: …» (ADR 0009, «Что остаётся человеку»)';
  }
  return null;
}

/** touches целиком под deny защищённых путей — нужен режим обслуживания (ADR 0007/0009). */
export function isMaintenanceTask(task: TaskFile): boolean {
  return task.touches.some((path) => protectionOf(path) === 'deny');
}

/**
 * Задача оператора: режим обслуживания (touches под deny защищённых путей)
 * или needs_human вида «оператор: …» (ADR 0009). Правило валидации needs_human
 * (invalidNeedsHuman) применяется гейтом к открытым задачам: файлы в done/ —
 * архив, их needs_human никого больше не блокирует и правится только своим PR.
 */
export function isOperatorTask(task: TaskFile): boolean {
  return task.needsHuman.startsWith('оператор:') || isMaintenanceTask(task);
}

/** Сколько открытых задач зависят от данной напрямую — порядок для next --operator (ADR 0009). */
export function openDependentsCount(id: string, tasks: TaskFile[]): number {
  return tasks.filter((task) => !task.done && task.dependsOn.includes(id)).length;
}

/**
 * Грамматика touches: литеральный путь или `каталог/**`. Произвольные glob-ы
 * (`*`, `?`, `[`) запрещены: их пересечение нельзя посчитать точно (ADR 0007).
 */
export function invalidTouch(path: string): string | null {
  if (path.startsWith('/') || path.includes('..')) {
    return `${path}: путь должен быть относительным без «..»`;
  }
  if (/[*?[\\]/.test(path.replace(/\*\*$/, ''))) {
    return `${path}: разрешены только литеральный путь или «каталог/**»`;
  }
  if (path.endsWith('/**')) {
    const dir = path.slice(0, -3);
    if (dir === '' || dir.endsWith('/')) {
      return `${path}: перед «/**» должен быть непустой каталог`;
    }
  }
  return null;
}

// --- Циклы -------------------------------------------------------------------

/** Возвращает id задач, участвующих в цикле depends_on, или пустой список. */
export function dependencyCycles(tasks: TaskFile[]): string[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const state = new Map<string, 'visiting' | 'done'>();
  const cycles: string[] = [];
  const visit = (id: string, stack: string[]): void => {
    const mark = state.get(id);
    if (mark === 'done' || !byId.has(id)) {
      return;
    }
    if (mark === 'visiting') {
      cycles.push(...stack.slice(stack.indexOf(id)));
      return;
    }
    state.set(id, 'visiting');
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      visit(dep, [...stack, id]);
    }
    state.set(id, 'done');
  };
  for (const task of tasks) {
    visit(task.id, []);
  }
  return [...new Set(cycles)];
}

// --- Статус ------------------------------------------------------------------

export type TaskStatus = 'done' | 'in-progress' | 'blocked' | 'maintenance' | 'free';

export interface BoardFacts {
  /** Открытые и закрытые задачи доски (из ссылки main). */
  tasks: TaskFile[];
  /** Локальные ветки `task/<id>` — захваты этого клона. */
  claimedIds: Set<string>;
}

export function statusOf(task: TaskFile, facts: BoardFacts): TaskStatus {
  if (task.done) {
    return 'done';
  }
  if (facts.claimedIds.has(task.id)) {
    return 'in-progress';
  }
  const byId = new Map(facts.tasks.map((item) => [item.id, item]));
  const openDeps = task.dependsOn.filter((id) => byId.get(id)?.done !== true);
  if (openDeps.length > 0 || task.needsHuman !== '') {
    return 'blocked';
  }
  if (isMaintenanceTask(task)) {
    return 'maintenance';
  }
  return 'free';
}

/** Литеральный путь превращается в узкий glob, каталог/** остаётся широким. */
function expandTouches(paths: string[]): string[] {
  return paths.map((path) => (path.endsWith('/**') ? path : `${path}/__literal__`));
}

/** Задачи, в работе на этом клоне, пересекающиеся по touches с данной (ADR 0007, D7 — предупреждение). */
export function touchesOverlap(task: TaskFile, inProgress: TaskFile[]): boolean {
  return inProgress.some((other) =>
    expandTouches(task.touches).some((mine) =>
      expandTouches(other.touches).some(
        (theirs) =>
          matchesGlob(mine, theirs.replace(/\/\*\*$/, '/**')) ||
          matchesGlob(theirs, mine.replace(/__literal__$/, '/__child__')),
      ),
    ),
  );
}

// --- Замыкание задачи (ADR 0007, «Замыкание задачи») --------------------------

/** Сколько часов задача может висеть в работе без коммитов, прежде чем doctor предупредит. */
export const DOCTOR_IDLE_HOURS = 48;

export interface DoctorFacts {
  /** id задач с открытым файлом (backlog/<id>.md). */
  openIds: Set<string>;
  /** id закрытых задач (backlog/done/<id>.md). */
  doneIds: Set<string>;
  /** Локальные ветки task/<id>. */
  claimedIds: Set<string>;
  /** Ветки task/<id>, попавшие в main (GitHub API или git-предок). */
  mergedIds: Set<string>;
  /** Часов с последнего коммита ветки task/<id>. */
  branchAgeHours: Map<string, number>;
  /**
   * Обнаруженные файлы режима обслуживания .claude/settings.local.json
   * (ADR 0009): в основном checkout — всегда расхождение; в worktree задачи —
   * расхождение, когда у ветки есть открытый PR или она молчит дольше порога,
   * иначе активное окно оператора (предупреждение).
   */
  maintenanceFiles: MaintenanceFile[];
}

export interface MaintenanceFile {
  /** Расположение: путь основного checkout или worktree (человекочитаемо). */
  where: string;
  /** true — основной checkout; false — worktree (в том числе без ветки task/*). */
  main: boolean;
  /** id задачи ветки worktree; null — основной checkout или ветка не task/*. */
  taskId: string | null;
  /** У ветки task/<id> есть открытый PR (gh); значимо только при taskId !== null. */
  hasOpenPr: boolean;
  /** true — PR-состояние проверить не удалось (gh недоступен), hasOpenPr не отличает «нет PR». */
  prUnknown: boolean;
  /** Часов с последнего коммита ветки; null — определить не удалось. */
  idleHours: number | null;
}

export interface DoctorFinding {
  id: string;
  kind: 'unclosed' | 'leftover-branch' | 'idle-claim' | 'maintenance-mode';
  /** true — расхождение, doctor завершается с ошибкой; false — предупреждение. */
  blocking: boolean;
  message: string;
}

/**
 * Расхождения «работа смержена — доска не знает»: статус вычисляется из
 * нескольких фактов (файл, ветка, merge), и каждый меняется своим путём.
 * Работа вне доски (прямое поручение) — главный источник: PR закрывает работу,
 * а файл задачи никто не переносит (случаи C5/C8, 2026-11-14).
 */
export function doctorFindings(facts: DoctorFacts): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const id of facts.mergedIds) {
    if (facts.openIds.has(id)) {
      findings.push({
        id,
        kind: 'unclosed',
        blocking: true,
        message: `ветка task/${id} смержена в main, файл задачи ещё открыт — перенеси backlog/${id}.md в backlog/done/ (свой PR или отдельный PR гигиены) и дополни «Журнал» итогом`,
      });
    }
    // Ветка, которой нет локально, — не расхождение: GitHub помнит head ветки
    // смерженного PR вечно, а удаление ветки после merge — нормальная уборка.
    if (facts.doneIds.has(id) && facts.claimedIds.has(id)) {
      findings.push({
        id,
        kind: 'leftover-branch',
        blocking: true,
        message: `задача ${id} закрыта, но ветка task/${id} осталась — удали локально (git branch -d task/${id}) и в origin, если есть (git push origin --delete task/${id})`,
      });
    }
  }
  for (const id of facts.claimedIds) {
    if (facts.openIds.has(id) && !facts.mergedIds.has(id)) {
      const age = facts.branchAgeHours.get(id);
      if (age !== undefined && age >= DOCTOR_IDLE_HOURS) {
        findings.push({
          id,
          kind: 'idle-claim',
          blocking: false,
          message: `задача ${id} в работе, но последний коммит ${Math.floor(age)} ч назад — если сессия умерла, человек освобождает задачу: pnpm backlog release ${id}`,
        });
      }
    }
  }
  // Тихое окно ADR 0004: забытый файл режима обслуживания выключает хуки и
  // песочницу, и напомнить об этом нечем — doctor делает окно видимым (ADR 0009).
  for (const file of facts.maintenanceFiles) {
    if (file.taskId === null) {
      findings.push({
        id: 'main',
        kind: 'maintenance-mode',
        blocking: true,
        message: `файл режима обслуживания .claude/settings.local.json в ${file.main ? 'основном checkout' : 'worktree без ветки задачи'} (${file.where}) — хуки и песочница там выключены, протокол оператора это место не покрывает. Удали файл (ADR 0004, ADR 0009)`,
      });
      continue;
    }
    const idle = file.idleHours !== null && file.idleHours >= DOCTOR_IDLE_HOURS;
    const prNote = file.prUnknown ? '; PR-состояние не проверено (gh недоступен)' : '';
    if (file.hasOpenPr || idle) {
      findings.push({
        id: file.taskId,
        kind: 'maintenance-mode',
        blocking: true,
        message: `файл режима обслуживания в worktree задачи ${file.taskId} (${file.where}) при ${file.hasOpenPr ? 'открытом PR' : `последнем коммите ${Math.floor(file.idleHours ?? 0)} ч назад`}${prNote} — режим выключается до открытия PR. Удали .claude/settings.local.json из worktree и запиши время выключения в «Журнал» (ADR 0009)`,
      });
    } else {
      findings.push({
        id: file.taskId,
        kind: 'maintenance-mode',
        blocking: false,
        message: `файл режима обслуживания в worktree задачи ${file.taskId} (${file.where}) — активное окно оператора${prNote}: время включения должно быть записано в «Журнале» задачи, файл удаляется до открытия PR (ADR 0009)`,
      });
    }
  }
  return findings.toSorted(
    (a, b) => Number(b.blocking) - Number(a.blocking) || a.id.localeCompare(b.id),
  );
}
