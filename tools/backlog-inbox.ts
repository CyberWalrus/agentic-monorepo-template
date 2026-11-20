/**
 * Логика инбокса человека (`pnpm backlog inbox`, задача e8): одно место,
 * где видно, что ждёт приёмки человека и в каком порядке это разблокирует
 * работу агентов (ADR 0007, ADR 0009). Чистые функции без побочных эффектов:
 * разбор вывода gh (fail-closed), сборка элементов из фактов доски,
 * сортировка по числу разблокированных задач. Класс защиты: review
 * (ADR 0014) — импортирует deny-модули (backlog-board), не наоборот;
 * в замыкание гейтов не входит.
 */
import {
  DOCTOR_IDLE_HOURS,
  needsHumanKind,
  openDependentsCount,
  type TaskFile,
} from './backlog-board.ts';

/** Label, которым человек одобряет изменение защищённых путей (ADR 0002). */
export const GATE_LABEL = 'gate-change-approved';

/** Порог брошенности захвата — тот же, что у doctor (idle-claim, ADR 0007). */
export const INBOX_IDLE_HOURS = DOCTOR_IDLE_HOURS;

// --- Разбор вывода gh -----------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberString(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
}

function stringListOf(records: unknown, key: string): string[] {
  if (!Array.isArray(records)) {
    return [];
  }
  return records.flatMap((entry) => {
    const field = isRecord(entry) ? stringOf(entry[key]) : undefined;
    return field === undefined ? [] : [field];
  });
}

/** Итог проверок PR: зелёный, красный или неизвестно (fail-closed, З4). */
export type ChecksState = 'green' | 'red' | 'unknown';

/**
 * statusCheckRollup из gh: CheckRun (status/conclusion) и StatusContext (state)
 * считаются, незнакомая форма — unknown, а не зелёная. Пустой rollup — unknown:
 * чеки ещё не стартовали, зелёность не заявлена.
 */
export function parseChecks(rollup: unknown): ChecksState {
  if (!Array.isArray(rollup)) {
    return 'unknown';
  }
  if (rollup.length === 0) {
    return 'unknown';
  }
  let unknown = false;
  for (const entry of rollup) {
    if (!isRecord(entry)) {
      unknown = true;
      continue;
    }
    const typename = stringOf(entry['__typename']);
    if (typename === 'CheckRun') {
      if (stringOf(entry['status']) !== 'COMPLETED') {
        unknown = true;
        continue;
      }
      const conclusion = stringOf(entry['conclusion']);
      if (conclusion === 'SUCCESS' || conclusion === 'SKIPPED' || conclusion === 'NEUTRAL') {
        continue;
      }
      return 'red';
    }
    if (typename === 'StatusContext') {
      const state = stringOf(entry['state']);
      if (state === 'SUCCESS') {
        continue;
      }
      if (state === 'EXPECTED' || state === 'PENDING') {
        unknown = true;
        continue;
      }
      return 'red';
    }
    unknown = true;
  }
  return unknown ? 'unknown' : 'green';
}

/** Факт об открытом PR ветки task/*, разобранный из `gh pr view --json …`. */
export interface PrFact {
  number: number;
  branch: string;
  title: string;
  /** id из ветки task/<id>; null — ветка не задачная (в инбокс не попадает). */
  taskId: string | null;
  /** reviewDecision из gh: APPROVED, REVIEW_REQUIRED, … */
  reviewDecision: string;
  labels: string[];
  files: string[];
  /** committedDate последнего коммита — прокси времени push (gate-approval-core). */
  headCommittedAt: string | null;
  checks: ChecksState;
  mergeable: string | null;
  isDraft: boolean;
}

/**
 * Разбор одного `gh pr view <branch> --json …`. Любая нехватка обязательных
 * полей — null (вызывающий записывает строку в неполные), неизвестная форма
 * внутри — запасное состояние, а не зелёность (З4).
 */
export function parsePrView(raw: string): PrFact | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const number = numberString(parsed['number']);
  const branch = stringOf(parsed['headRefName']);
  if (number === undefined || branch === undefined) {
    return null;
  }
  const commits = Array.isArray(parsed['commits']) ? parsed['commits'] : [];
  const lastCommit = commits.at(-1);
  return {
    number: Number(number),
    branch,
    title: stringOf(parsed['title']) ?? '(без названия)',
    taskId: branch.startsWith('task/') ? branch.slice('task/'.length) : null,
    reviewDecision: stringOf(parsed['reviewDecision']) ?? 'UNKNOWN',
    labels: stringListOf(parsed['labels'], 'name'),
    files: stringListOf(parsed['files'], 'path'),
    headCommittedAt: isRecord(lastCommit) ? (stringOf(lastCommit['committedDate']) ?? null) : null,
    checks: parseChecks(parsed['statusCheckRollup']),
    mergeable: stringOf(parsed['mergeable']) ?? null,
    isDraft: parsed['isDraft'] === true,
  };
}

// --- Сборка инбокса -------------------------------------------------------------

export type InboxKind =
  | 'maintenance-file'
  | 'pr'
  | 'human-task'
  | 'release-candidate'
  | 'deferred-task';

export interface InboxItem {
  kind: InboxKind;
  /** Короткое действие человека или «без действия». */
  action: string;
  /** Цель действия: id задачи или PR. */
  target: string;
  /** Сколько открытых задач действие разблокирует — порядок инбокса. */
  unblocks: number;
  /** Человекочитаемое пояснение состояния. */
  note: string;
  /** true — призыв к действию; false — только перечислить (отложено, ждёт агента). */
  actionable: boolean;
}

/** Состояние label-гейта для одного PR; считает CLI из evaluateApproval (ADR 0002). */
export interface LabelState {
  /** PR правит файлы под deny — label обязателен до merge. */
  needed: boolean;
  /** Вердикт evaluateApproval; при needed=false всегда true. */
  approved: boolean;
  /** Причина вердикта для строки инбокса. */
  reason: string;
  /** Label стоит, но просрочен новым push — отдельная строка на повторный label. */
  staleByPush: boolean;
}

export interface InboxFacts {
  /** Открытые и закрытые задачи доски (из ссылки main). */
  tasks: TaskFile[];
  /** Открытые PR веток task/*; null — gh недоступен, PR-строки не собраны. */
  prs: PrFact[] | null;
  /** PR номер → состояние label-гейта (считает CLI; пусто, если gh недоступен). */
  labelStates: Map<number, LabelState>;
  /** Ветка task/<id> → часов с последнего коммита; отсутствует — возраст неизвестен. */
  branchAgeHours: Map<string, number>;
  /** Локальные ветки task/* (захваты). */
  claimedIds: Set<string>;
  /** Оставленный файл режима обслуживания в основном checkout (ADR 0009). */
  maintenanceFileFound: boolean;
}

export interface Inbox {
  items: InboxItem[];
  /** Строки о том, что проверить не удалось: инбокс неполный, а не пустой (З11). */
  incomplete: string[];
}

const afterPrefix = (needsHuman: string, prefix: string): string =>
  needsHuman.slice(prefix.length).trim();

/**
 * Сборка инбокса из фактов. Источники (задача e8): открытые PR веток task/*
 * (approve, label, зелёный-готов-к-merge), задачи с needs_human «человек: …»
 * при закрытых зависимостях, задачи «отложено: …» без призыва к действию,
 * брошенные захваты (кандидат на release), оставленный файл режима обслуживания.
 */
export function buildInboxItems(facts: InboxFacts): Inbox {
  const incomplete: string[] = [];
  const items: InboxItem[] = [];

  if (facts.maintenanceFileFound) {
    items.push({
      kind: 'maintenance-file',
      action: 'удали .claude/settings.local.json из основного checkout',
      target: '.claude/settings.local.json',
      unblocks: 0,
      note: 'режим обслуживания включён и не выключен: хуки и песочница выключены во всех сессиях этого checkout (ADR 0009). Строка всегда первая — не по счёту задач, а потому что ставит под угрозу гейты всех параллельных работ',
      actionable: true,
    });
  }

  if (facts.prs === null) {
    incomplete.push(
      'gh недоступен: открытые PR веток task/* не проверены — строки про approve/label/merge отсутствуют. Список неполный: не принимай его за «человеку делать нечего» (З11)',
    );
  }
  for (const pr of facts.prs ?? []) {
    if (pr.taskId === null) {
      continue;
    }
    const unblocks = openDependentsCount(pr.taskId, facts.tasks);
    const target = `PR #${pr.number} (${pr.branch})`;
    const title = `«${pr.title}»`;
    const state = facts.labelStates.get(pr.number);
    const needsLabel = state?.needed ?? false;
    if (needsLabel && state !== undefined && !state.approved) {
      items.push({
        kind: 'pr',
        action: state.staleByPush
          ? `поставь label ${GATE_LABEL} заново на ${target}`
          : `поставь label ${GATE_LABEL} на ${target}`,
        target,
        unblocks,
        note: state.staleByPush
          ? `label снят новым push (отдельная строка): ${state.reason} ${title}`
          : `${state.reason} ${title}`,
        actionable: true,
      });
    } else if (needsLabel && state === undefined) {
      incomplete.push(
        `${target}: PR правит защищённые пути, но состояние label ${GATE_LABEL} не проверено (события или CODEOWNERS не прочитаны) — строка неполная`,
      );
    }
    if (pr.reviewDecision !== 'APPROVED') {
      const reviewState =
        pr.reviewDecision === '' ? 'ревью не запрошено' : `reviewDecision ${pr.reviewDecision}`;
      items.push({
        kind: 'pr',
        action: `approve ${target}`,
        target,
        unblocks,
        note: `${reviewState} ${title}`,
        actionable: true,
      });
    }
    const mergeBlocked =
      pr.isDraft ||
      pr.checks !== 'green' ||
      (pr.mergeable !== null && pr.mergeable !== 'MERGEABLE');
    if (!mergeBlocked) {
      items.push({
        kind: 'pr',
        action: `merge ${target}`,
        target,
        unblocks,
        note: `зелёный и готов к merge ${title}`,
        actionable: true,
      });
      continue;
    }
    if (pr.isDraft) {
      items.push({
        kind: 'pr',
        action: 'без действия',
        target,
        unblocks,
        note: `черновик — ждёт агента ${title}`,
        actionable: false,
      });
      continue;
    }
    if (pr.checks !== 'green') {
      items.push({
        kind: 'pr',
        action: 'без действия',
        target,
        unblocks,
        note:
          pr.checks === 'red'
            ? `CI красный — ждёт агента, не готов к merge ${title}`
            : `проверки CI не завершены или не распознаны — зелёность не заявлена ${title}`,
        actionable: false,
      });
      continue;
    }
    items.push({
      kind: 'pr',
      action: 'без действия',
      target,
      unblocks,
      note: `конфликт с main — ждёт агента (rebase) ${title}`,
      actionable: false,
    });
  }

  const byId = new Map(facts.tasks.map((task) => [task.id, task]));
  for (const task of facts.tasks) {
    if (task.done) {
      continue;
    }
    const depsOpen = task.dependsOn.filter((dep) => byId.get(dep)?.done !== true);
    const kind = needsHumanKind(task.needsHuman);
    if (kind === 'human') {
      // «человек: …» с незакрытой зависимостью в список не попадает (задача e8):
      // сначала разблокируются зависимости, потом действие человека.
      if (depsOpen.length > 0) {
        continue;
      }
      items.push({
        kind: 'human-task',
        action: afterPrefix(task.needsHuman, 'человек:') || task.needsHuman,
        target: task.id,
        unblocks: openDependentsCount(task.id, facts.tasks),
        note: `задача ${task.id} ${task.title} ждёт человека`,
        actionable: true,
      });
      continue;
    }
    if (kind === 'deferred') {
      items.push({
        kind: 'deferred-task',
        action: 'без действия',
        target: task.id,
        unblocks: openDependentsCount(task.id, facts.tasks),
        note: `задача ${task.id} ${task.title} отложена: ${afterPrefix(task.needsHuman, 'отложено:') || task.needsHuman}`,
        actionable: false,
      });
    }
  }

  for (const id of facts.claimedIds) {
    const task = byId.get(id);
    if (task === undefined || task.done) {
      continue;
    }
    const age = facts.branchAgeHours.get(id);
    if (age === undefined) {
      incomplete.push(
        `возраст ветки task/${id} определить не удалось — брошенность захвата не проверена`,
      );
      continue;
    }
    if (age >= INBOX_IDLE_HOURS) {
      items.push({
        kind: 'release-candidate',
        action: `pnpm backlog release ${id}`,
        target: id,
        unblocks: openDependentsCount(id, facts.tasks) + 1,
        note: `брошенный захват: последний коммит ${Math.floor(age)} ч назад (порог ${INBOX_IDLE_HOURS} ч) — освобождает задачу ${id} ${task.title} для нового захвата`,
        actionable: true,
      });
    }
  }

  return { items, incomplete };
}

/**
 * Порядок инбокса (задача e8): файл режима обслуживания всегда первый (угроза
 * гейтам, не счёт задач); затем действия — по числу разблокированных задач
 * (больше — выше); пассивные строки (отложено, ждёт агента) в конце.
 */
export function sortInboxItems(items: InboxItem[]): InboxItem[] {
  return items.toSorted(
    (a, b) =>
      Number(b.kind === 'maintenance-file') - Number(a.kind === 'maintenance-file') ||
      Number(b.actionable) - Number(a.actionable) ||
      b.unblocks - a.unblocks ||
      a.target.localeCompare(b.target) ||
      a.action.localeCompare(b.action),
  );
}
