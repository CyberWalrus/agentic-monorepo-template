/**
 * Сводный check здоровья workflow (e26): каждый workflow, ожидаемо стартующий
 * на main (триггеры push/schedule из .github/workflows/**), обязан иметь
 * зелёный прогон на свежем head-коммите main — либо свежий schedule-прогон в
 * окне. Закрывает escaped-defect 2026-11-21 (docs/escaped-defects.md): SHA-пин
 * породил битый uses, workflow не стартовал ни разу, а в required checks он не
 * входит — main оставался зелёным. ci.yml агрегирует только собственные джобы;
 * zizmor — линтер содержимого, не проверка «воркфлоу стартует».
 *
 * Область (фильтр по ожидаемым триггерам, Решение e26):
 * - push на main без paths-фильтра — прогон обязан быть на head SHA main и
 *   завершиться успехом (каждый пуш триггерит);
 * - push с paths-фильтром — последний завершённый push-прогон на main обязан
 *   быть зелёным; отсутствие прогонов легитимно навсегда (paths могли не
 *   совпасть ни с одним пушем — находка ревью e26), наличие прогонов требуется
 *   только у push-без-paths;
 * - schedule — последний завершённый schedule-прогон в окне свежести
 *   (--schedule-freshness-days, по умолчанию 8: недельные расписания + запас)
 *   И зелёный: персистентно красный schedule вне required checks — тот же
 *   класс escaped-defect, startup_failure ловится сравнением conclusion
 *   (находка ревью e26).
 * pull_request, pull_request_target, issue_comment, merge_group и
 * workflow_dispatch-воркфлоу вне области: их здоровье видно в check-ах PR.
 * workflow в состоянии не active — вне области.
 *
 * Известная граница (находка ревью e26): чекер живёт внутри nightly.yml и не
 * может засветить собственный хост — если nightly перестал стартовать (класс
 * escaped-defect), ни один его job не исполнится и сводный check не увидит
 * пробела. Внешний контур (шаг в ci.yml или dispatch-воркфлоу вне ночи) —
 * кандидат в задачи; в строке docs/escaped-defects.md покрытие сформулировано
 * с учётом этой границы.
 *
 * Джоба nightly.yml (workflow-health) зовёт чекер с GH_TOKEN; красный прогон
 * заводит issue через job report (needs), дублировать issue-логику здесь не
 * нужно. Незавершённый прогон на head SHA — не красный, пока он молодой
 * (--pending-hours, по умолчанию 6: ночной прогон мог попасть в окно CI на
 * свежем коммите); старше окна — красный «застрял» (fail-closed, З11: висящий
 * незавершённый прогон — дефект очереди или раннера). Хвостовая краснота
 * докрашивается следующим ночным прогоном: failures на head SHA остаются в
 * данных API, пока head не ушёл вперёд.
 *
 * Коды выходов: 0 — зелёный; 1 — нарушения (список в stderr); 2 — fail-loud:
 * gh api недоступен/ошибся, каталог workflows пуст/нечитаем, неожиданная форма
 * ответа — проверка не выполнялась, а не пройдена (З11). Тест-режим:
 * --workflows-dir <dir> (синтетическое дерево) и --fixture-api <dir> читает
 * head.json, workflows.json, head-runs.json, push-runs.json, schedule-runs.json
 * вместо gh api (канарейка «workflow не стартовал» — tools/test/, e26).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Fail-loud выход окружения (З11): проверка не выполнялась, а не пройдена. */
function die(message: string): never {
  console.error(message);
  process.exit(2);
}

// --- Мини-парсер триггеров (без yaml-зависимости: блок on: в этом репозитории
// --- и у потребителей шаблона — плоский маппинг; поведение пинится тестами). --

export interface ParsedWorkflow {
  triggers: string[];
  /** Фильтр branches под push; null — фильтра нет (все ветки). */
  pushBranches: string[] | null;
  /** Фильтр branches-ignore под push; null — фильтра нет. */
  pushBranchesIgnore: string[] | null;
  /** Есть paths/paths-ignore под push. */
  pushHasPaths: boolean;
}

/** Срезает # комментарий вне кавычек (yaml-семантика, как в check-tool-class). */
function stripHashComment(line: string): string {
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
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** [a, b] flow-последовательность → элементы; иначе null. */
function parseInlineList(rest: string): string[] | null {
  const trimmed = rest.trim();
  if (!trimmed.startsWith('[')) {
    return null;
  }
  const end = trimmed.lastIndexOf(']');
  const inner = end >= 0 ? trimmed.slice(1, end) : trimmed.slice(1);
  return inner
    .split(',')
    .map(unquote)
    .filter((item) => item !== '');
}

function indentOf(line: string): number {
  const match = /^ */.exec(line);
  return match?.[0].length ?? 0;
}

const KEY_LINE = /^-?\s*['"]?([A-Za-z_][A-Za-z0-9_-]*)['"]?\s*:(.*)$/;
const LIST_ITEM = /^-\s+(.*)$/;

/**
 * Триггеры workflow из сырого текста. null — нет распознаваемого блока on:
 * (workflow выключен или не триггерится событиями).
 */
export function parseWorkflowTriggers(source: string): ParsedWorkflow | null {
  const lines = source.split('\n').map(stripHashComment);
  let onIndex = -1;
  let onIndent = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(\s*)on\s*:(.*)$/.exec(lines[i] ?? '');
    if (match !== null) {
      onIndex = i;
      onIndent = match[1]?.length ?? 0;
      break;
    }
  }
  if (onIndex < 0) {
    return null;
  }
  const rest = (lines[onIndex] ?? '').replace(/^(\s*)on\s*:/, '').trim();
  // on: [push, workflow_dispatch] — flow-список.
  const inline = parseInlineList(rest);
  if (inline !== null) {
    return { triggers: inline, pushBranches: null, pushBranchesIgnore: null, pushHasPaths: false };
  }
  // on: push — скаляр.
  if (rest !== '') {
    return {
      triggers: [unquote(rest)],
      pushBranches: null,
      pushBranchesIgnore: null,
      pushHasPaths: false,
    };
  }
  // Блок: ключи-триггеры — строки на первом уровне вложенности блока.
  const block: { indent: number; text: string }[] = [];
  for (let i = onIndex + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      continue;
    }
    const indent = indentOf(line);
    if (indent <= onIndent) {
      break;
    }
    block.push({ indent, text: line.trim() });
  }
  if (block.length === 0) {
    return null; // on: без содержимого — нет триггеров
  }
  const keyIndent = Math.min(...block.map((entry) => entry.indent));
  const triggers: string[] = [];
  let pushBranches: string[] | null = null;
  let pushBranchesIgnore: string[] | null = null;
  let pushHasPaths = false;
  for (const entry of block) {
    if (entry.indent !== keyIndent) {
      continue;
    }
    const keyMatch = KEY_LINE.exec(entry.text);
    const listItem = LIST_ITEM.exec(entry.text);
    if (keyMatch !== null) {
      triggers.push(keyMatch[1] ?? '');
      continue;
    }
    if (listItem !== null) {
      // Форма списка событий: on: затем «- push» на уровне ключей.
      triggers.push(unquote(listItem[1] ?? ''));
    }
  }
  // Дети push: branches/branches-ignore/paths на строках глубже keyIndent.
  const childIndents = block
    .filter((entry) => entry.indent > keyIndent)
    .map((entry) => entry.indent);
  if (childIndents.length > 0) {
    const childIndent = Math.min(...childIndents);
    let inPush = false;
    let collecting: 'branches' | 'ignore' | null = null;
    for (const entry of block) {
      if (entry.indent === keyIndent) {
        inPush = KEY_LINE.exec(entry.text)?.[1] === 'push';
        collecting = null;
        continue;
      }
      if (!inPush || entry.indent !== childIndent) {
        continue;
      }
      const childKey = KEY_LINE.exec(entry.text);
      if (childKey !== null) {
        const key = childKey[1] ?? '';
        const value = (childKey[2] ?? '').trim();
        collecting = null;
        if (key === 'branches' || key === 'branches-ignore') {
          const inlineBranches = parseInlineList(value);
          const target = key === 'branches' ? 'branches' : 'ignore';
          if (inlineBranches !== null) {
            if (target === 'branches') {
              pushBranches = inlineBranches;
            } else {
              pushBranchesIgnore = inlineBranches;
            }
          } else {
            if (target === 'branches') {
              pushBranches = [];
            } else {
              pushBranchesIgnore = [];
            }
            collecting = target;
          }
        } else if (key === 'paths' || key === 'paths-ignore') {
          pushHasPaths = true;
        }
        continue;
      }
      const item = LIST_ITEM.exec(entry.text);
      if (item !== null && collecting === 'branches') {
        pushBranches?.push(unquote(item[1] ?? ''));
      } else if (item !== null && collecting === 'ignore') {
        pushBranchesIgnore?.push(unquote(item[1] ?? ''));
      }
    }
  }
  return { triggers, pushBranches, pushBranchesIgnore, pushHasPaths };
}

export interface WorkflowScope {
  file: string;
  /** push на main без paths-фильтра: прогон ожидается на каждом head SHA. */
  pushHeadSha: boolean;
  /** push на main с paths-фильтром: прогон ожидается при совпадении paths. */
  pushPaths: boolean;
  /** Есть schedule-триггер. */
  schedule: boolean;
}

/** Область сводного check: push на main (с/без paths) и/или schedule. */
export function scopeOfWork(parsed: ParsedWorkflow, file: string): WorkflowScope | null {
  const push = parsed.triggers.includes('push');
  const schedule = parsed.triggers.includes('schedule');
  if (!push && !schedule) {
    return null;
  }
  let pushHeadSha = false;
  let pushPaths = false;
  if (push) {
    // Прогоны ожидаются на main: положительный фильтр обязан включать main,
    // в branches-ignore main отсутствовать; без фильтра — все ветки.
    const mainScoped =
      parsed.pushBranches === null
        ? parsed.pushBranchesIgnore === null || !parsed.pushBranchesIgnore.includes('main')
        : parsed.pushBranches.includes('main');
    if (mainScoped) {
      pushHeadSha = !parsed.pushHasPaths;
      pushPaths = parsed.pushHasPaths;
    }
  }
  if (!pushHeadSha && !pushPaths && !schedule) {
    return null;
  }
  return { file, pushHeadSha, pushPaths, schedule };
}

/** Читает область из каталога workflow-файлов; пусто/нечитаемо — fail-loud. */
export function loadScope(dir: string): { scope: WorkflowScope[] } {
  if (!existsSync(dir)) {
    die(`workflow-health: каталог workflows не найден: ${dir} (fail-loud, З11)`);
  }
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .toSorted();
  if (files.length === 0) {
    die(`workflow-health: в ${dir} нет workflow-файлов (fail-loud, З11)`);
  }
  const scope: WorkflowScope[] = [];
  for (const name of files) {
    const parsed = parseWorkflowTriggers(readFileSync(join(dir, name), 'utf8'));
    if (parsed === null) {
      continue;
    }
    const scoped = scopeOfWork(parsed, `.github/workflows/${name}`);
    if (scoped !== null) {
      scope.push(scoped);
    }
  }
  return { scope };
}

// --- Данные прогонов -------------------------------------------------------------

export interface RunInfo {
  workflowId: number;
  headBranch: string;
  headSha: string;
  event: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
  runStartedAt: string | null;
}

export interface ApiData {
  headSha: string;
  /** id → путь файла workflow (из /actions/workflows). */
  pathById: Map<number, { path: string; createdAt: string; state: string }>;
  /** Прогоны с head_sha == headSha (все события). */
  headRuns: RunInfo[];
  /** Прогоны event=push на ветке defaultBranch (любой SHA). */
  pushRuns: RunInfo[];
  /** Прогоны event=schedule (head_branch == defaultBranch). */
  scheduleRuns: RunInfo[];
}

function isoDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    die(
      `workflow-health: неожиданная форма ответа API: ${field} не ISO-дата (${String(value)}) (З11)`,
    );
  }
  return value;
}

function parseRun(raw: unknown, source: string): RunInfo {
  if (!isRecord(raw)) {
    die(`workflow-health: ${source}: элемент прогонов не объект (З11)`);
  }
  const id = raw['id'];
  const workflowId = raw['workflow_id'];
  if (typeof id !== 'number' || typeof workflowId !== 'number') {
    die(`workflow-health: ${source}: id/workflow_id не числа (З11)`);
  }
  return {
    workflowId,
    headBranch: typeof raw['head_branch'] === 'string' ? raw['head_branch'] : '',
    headSha: typeof raw['head_sha'] === 'string' ? raw['head_sha'] : '',
    event: typeof raw['event'] === 'string' ? raw['event'] : '',
    status: typeof raw['status'] === 'string' ? raw['status'] : '',
    conclusion: typeof raw['conclusion'] === 'string' ? raw['conclusion'] : null,
    createdAt: isoDate(raw['created_at'], `${source}.created_at`),
    runStartedAt: typeof raw['run_started_at'] === 'string' ? raw['run_started_at'] : null,
  };
}

/** Читает фикстуру API из каталога (тест-режим); отсутствие файла — fail-loud. */
function fixtureData(dir: string, name: string): unknown {
  const path = join(dir, name);
  const raw = existsSync(path)
    ? readFileSync(path, 'utf8')
    : die(`workflow-health: фикстура не найдена: ${path} (fail-loud, З11)`);
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed;
  } catch (error) {
    return die(`workflow-health: фикстура ${name} не разобрана: ${String(error)} (З11)`);
  }
}

function fetchApi(repo: string, resource: string): unknown {
  const run = spawnSync('gh', ['api', `repos/${repo}/${resource}`], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const stdout =
    run.status === 0 && run.stdout.trim() !== ''
      ? run.stdout
      : die(
          `workflow-health: gh api ${resource} не ответил (exit ${run.status}) — fail-loud (З11): ` +
            (run.stderr ?? '').slice(-300),
        );
  try {
    const parsed: unknown = JSON.parse(stdout);
    return parsed;
  } catch (error) {
    return die(`workflow-health: ответ ${resource} не разобран: ${String(error)} (З11)`);
  }
}

function runList(body: unknown, source: string): unknown[] {
  if (!isRecord(body) || !Array.isArray(body['workflow_runs'])) {
    die(`workflow-health: у ответа ${source} нет workflow_runs[] (fail-loud, З11)`);
  }
  const list: unknown[] = body['workflow_runs'];
  return list;
}

/** Страницы runs API (до maxPages) одним типом запроса. */
function fetchRuns(repo: string, query: string, maxPages: number): RunInfo[] {
  const runs: RunInfo[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const list = runList(fetchApi(repo, `actions/runs?${query}&per_page=100&page=${page}`), query);
    for (const raw of list) {
      runs.push(parseRun(raw, query));
    }
    if (list.length < 100) {
      break;
    }
  }
  return runs;
}

function fetchWorkflows(
  repo: string,
): Map<number, { path: string; createdAt: string; state: string }> {
  const pathById = new Map<number, { path: string; createdAt: string; state: string }>();
  for (let page = 1; page <= 5; page += 1) {
    const body = fetchApi(repo, `actions/workflows?per_page=100&page=${page}`);
    if (!isRecord(body) || !Array.isArray(body['workflows'])) {
      die('workflow-health: у ответа workflows нет workflows[] (fail-loud, З11)');
    }
    const list: unknown[] = body['workflows'];
    for (const raw of list) {
      if (!isRecord(raw)) {
        continue;
      }
      const id = raw['id'];
      const path = raw['path'];
      if (typeof id !== 'number' || typeof path !== 'string') {
        continue;
      }
      pathById.set(id, {
        path,
        createdAt: isoDate(raw['created_at'], 'workflows[].created_at'),
        state: typeof raw['state'] === 'string' ? raw['state'] : '',
      });
    }
    if (list.length < 100) {
      break;
    }
  }
  return pathById;
}

function fetchLive(defaultBranch: string, repo: string): ApiData {
  const headBody = fetchApi(repo, `commits/${defaultBranch}`);
  const headSha = isRecord(headBody) ? headBody['sha'] : undefined;
  if (typeof headSha !== 'string' || headSha === '') {
    die(`workflow-health: у commits/${defaultBranch} нет sha (fail-loud, З11)`);
  }
  return {
    headSha,
    pathById: fetchWorkflows(repo),
    headRuns: fetchRuns(repo, `head_sha=${headSha}`, 5),
    pushRuns: fetchRuns(repo, `event=push&branch=${defaultBranch}`, 5),
    scheduleRuns: fetchRuns(repo, 'event=schedule', 5),
  };
}

function loadFixture(dir: string, defaultBranch: string): ApiData {
  const headBody = fixtureData(dir, 'head.json');
  const headSha = isRecord(headBody) ? headBody['sha'] : undefined;
  if (typeof headSha !== 'string' || headSha === '') {
    die('workflow-health: фикстура head.json без sha (fail-loud, З11)');
  }
  const workflowsRaw = fixtureData(dir, 'workflows.json');
  if (!Array.isArray(workflowsRaw)) {
    die('workflow-health: фикстура workflows.json не массив (fail-loud, З11)');
  }
  const pathById = new Map<number, { path: string; createdAt: string; state: string }>();
  for (const raw of workflowsRaw) {
    if (!isRecord(raw)) {
      die('workflow-health: фикстура workflows.json: элемент не объект (З11)');
    }
    const id = raw['id'];
    const path = raw['path'];
    if (typeof id !== 'number' || typeof path !== 'string') {
      die(
        'workflow-health: фикстура workflows.json: элемент без числового id/строкового path (З11)',
      );
    }
    pathById.set(id, {
      path,
      createdAt: isoDate(raw['created_at'], 'workflows.json.created_at'),
      state: typeof raw['state'] === 'string' ? raw['state'] : 'active',
    });
  }
  const runs = (name: string): RunInfo[] => {
    const raw = fixtureData(dir, name);
    if (!Array.isArray(raw)) {
      die(`workflow-health: фикстура ${name} не массив (З11)`);
    }
    return raw.map((item) => parseRun(item, name));
  };
  return {
    headSha,
    pathById,
    headRuns: runs('head-runs.json'),
    pushRuns: runs('push-runs.json').filter((run) => run.headBranch === defaultBranch),
    scheduleRuns: runs('schedule-runs.json').filter((run) => run.headBranch === defaultBranch),
  };
}

// --- Оценка ----------------------------------------------------------------------

export interface Violation {
  workflow: string;
  reason: string;
}

export interface HealthReport {
  violations: Violation[];
  /** Проверенные workflow с краткой сводкой. */
  checked: { workflow: string; summary: string }[];
}

export interface EvaluateOptions {
  now: Date;
  freshnessMs: number;
  /** Незавершённые прогоны старше этого окна — «застрял» (красный). */
  pendingMs: number;
}

const RUN_SORT = (a: RunInfo, b: RunInfo): number =>
  Date.parse(b.runStartedAt ?? b.createdAt) - Date.parse(a.runStartedAt ?? a.createdAt);

/** Чистая оценка состояния по данным API (тесты передают фиксированное now). */
export function evaluateHealth(
  scope: WorkflowScope[],
  data: ApiData,
  options: EvaluateOptions,
): HealthReport {
  const violations: Violation[] = [];
  const checked: { workflow: string; summary: string }[] = [];
  const runsByPath = (runs: RunInfo[]): Map<string, RunInfo[]> => {
    const map = new Map<string, RunInfo[]>();
    for (const run of runs) {
      const meta = data.pathById.get(run.workflowId);
      if (meta === undefined) {
        continue; // прогон workflow, которого нет в списке API (создан мгновением назад)
      }
      const bucket = map.get(meta.path) ?? [];
      bucket.push(run);
      map.set(meta.path, bucket);
    }
    return map;
  };
  const headByPath = runsByPath(data.headRuns);
  const pushByPath = runsByPath(data.pushRuns);
  const scheduleByPath = runsByPath(data.scheduleRuns);
  const stalePending = (run: RunInfo): boolean =>
    options.now.getTime() - Date.parse(run.runStartedAt ?? run.createdAt) > options.pendingMs;

  for (const entry of scope) {
    const workflowMeta = [...data.pathById.values()].find((meta) => meta.path === entry.file);
    const createdAt = workflowMeta?.createdAt;
    const young =
      createdAt !== undefined &&
      options.now.getTime() - Date.parse(createdAt) < options.freshnessMs;
    if (workflowMeta !== undefined && workflowMeta.state !== 'active') {
      checked.push({ workflow: entry.file, summary: 'workflow не active — вне области' });
      continue;
    }
    let ok = true;

    if (entry.pushHeadSha) {
      // Только push-прогоны: dispatch-запуски на том же SHA здоровье
      // push-контура не доказывают (удачный ручной запуск мог замаскировать
      // красный push-прогон). Решает последний завершённый прогон: rerun
      // green→fail остаётся красным до зелёного перезапуска.
      const onHead = (headByPath.get(entry.file) ?? []).filter((run) => run.event === 'push');
      const completed = onHead.filter((run) => run.status === 'completed').toSorted(RUN_SORT);
      if (onHead.length === 0) {
        violations.push({
          workflow: entry.file,
          reason: `не стартовал на head SHA ${data.headSha.slice(0, 7)} — push-прогонов нет (escaped-defect 2026-11-21: workflow существует, но не запускается)`,
        });
        continue;
      }
      const latestCompleted = completed[0];
      if (latestCompleted === undefined) {
        // Незавершённые: молодой — ночной прогон попал в окно CI на свежем
        // коммите (не «пройдено»); старый — застрял (fail-closed, З11).
        const running = onHead.toSorted(RUN_SORT)[0];
        if (running !== undefined && stalePending(running)) {
          violations.push({
            workflow: entry.file,
            reason: `прогон на head SHA ${data.headSha.slice(0, 7)} не завершился и старше окна незавершённых — застрял (fail-closed, З11)`,
          });
          continue;
        }
        ok = false;
      } else if (latestCompleted.conclusion === 'success') {
        ok = true;
      } else {
        violations.push({
          workflow: entry.file,
          reason: `красный на head SHA ${data.headSha.slice(0, 7)}: conclusion=${String(latestCompleted.conclusion)}`,
        });
        continue;
      }
    }

    if (entry.pushPaths) {
      // Отсутствие push-прогонов — легитимное состояние навсегда, а не только
      // у молодых workflow: paths-фильтр мог не совпасть ни с одним пушем
      // (находка ревью e26 — окно created_at тут не аргумент). Наличие
      // прогонов требуем только у pushHeadSha-workflow; здесь красим лишь
      // фактическую красноту или застревание.
      const all = pushByPath.get(entry.file) ?? [];
      const completed = all.filter((run) => run.status === 'completed').toSorted(RUN_SORT);
      const latestOverall = all.toSorted(RUN_SORT)[0];
      if (latestOverall !== undefined && completed.length === 0) {
        if (stalePending(latestOverall)) {
          violations.push({
            workflow: entry.file,
            reason: `push-прогон (${latestOverall.headSha.slice(0, 7)}) не завершился и старше окна незавершённых — застрял (fail-closed, З11)`,
          });
          continue;
        }
        ok = false;
      } else if (completed.length > 0 && completed[0]?.conclusion !== 'success') {
        violations.push({
          workflow: entry.file,
          reason: `последний завершённый push-прогон красный: conclusion=${String(completed[0]?.conclusion)} (${completed[0]?.headSha.slice(0, 7)})`,
        });
        continue;
      }
    }

    if (entry.schedule) {
      // Schedule-прогон обязан быть свежим И зелёным: персистентно красный
      // schedule вне required checks — тот же класс escaped-defect, что и
      // «не стартовал» (находка ревью e26); startup_failure невалидного YAML
      // ловится тем же сравнением conclusion.
      const all = scheduleByPath.get(entry.file) ?? [];
      const completed = all.filter((run) => run.status === 'completed').toSorted(RUN_SORT);
      const latestOverall = all.toSorted(RUN_SORT)[0];
      const latestCompleted = completed[0];
      if (latestOverall === undefined) {
        if (!young) {
          violations.push({
            workflow: entry.file,
            reason:
              'schedule не стартовал ни разу при created_at вне окна свежести — расписание не срабатывает',
          });
          continue;
        }
      } else if (latestCompleted === undefined) {
        // Незавершённый schedule-прогон: молодой — ещё гонится; старый — застрял.
        if (stalePending(latestOverall)) {
          violations.push({
            workflow: entry.file,
            reason: `schedule-прогон не завершился и старше окна незавершённых — застрял (fail-closed, З11)`,
          });
          continue;
        }
        ok = false;
      } else if (
        options.now.getTime() - Date.parse(latestCompleted.createdAt) >
        options.freshnessMs
      ) {
        violations.push({
          workflow: entry.file,
          reason: `schedule-прогон старше окна свежести: последний ${latestCompleted.createdAt}`,
        });
        continue;
      } else if (latestCompleted.conclusion !== 'success') {
        violations.push({
          workflow: entry.file,
          reason: `красный schedule-прогон: conclusion=${String(latestCompleted.conclusion)} (${latestCompleted.createdAt.slice(0, 10)})`,
        });
        continue;
      }
    }

    checked.push({
      workflow: entry.file,
      summary: ok ? 'в области, стартовал и зелёный' : 'в области, прогон в процессе',
    });
  }
  return { violations, checked };
}

// --- CLI -------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2);
  const flag = (name: string): string => {
    const idx = args.indexOf(name);
    return idx >= 0 ? (args[idx + 1] ?? '') : '';
  };
  const has = (name: string): boolean => args.includes(name);
  const workflowsDir = flag('--workflows-dir') || '.github/workflows';
  const fixtureDir = flag('--fixture-api');
  const defaultBranch = flag('--default-branch') || 'main';
  const repo = flag('--repo') || process.env['GITHUB_REPOSITORY'] || '';
  const freshnessRaw = flag('--schedule-freshness-days') || '8';
  const freshnessDays = Number(freshnessRaw);
  const pendingRaw = flag('--pending-hours') || '6';
  const pendingHours = Number(pendingRaw);
  if (!has('--fixture-api') && repo === '') {
    die('workflow-health: не задан репозиторий (--repo или GITHUB_REPOSITORY) — fail-loud (З11)');
  }
  if (
    !Number.isFinite(freshnessDays) ||
    freshnessDays <= 0 ||
    !Number.isFinite(pendingHours) ||
    pendingHours <= 0
  ) {
    die(
      `workflow-health: некорректные опции (--schedule-freshness-days ${freshnessRaw}, --pending-hours ${pendingRaw}) — fail-loud (З11)`,
    );
  }

  const { scope } = loadScope(workflowsDir);
  if (scope.length === 0) {
    die(
      `workflow-health: в ${workflowsDir} нет workflow в области (push main / schedule) — fail-loud (З11)`,
    );
  }

  const data = has('--fixture-api')
    ? loadFixture(fixtureDir, defaultBranch)
    : fetchLive(defaultBranch, repo);
  const report = evaluateHealth(scope, data, {
    now: new Date(),
    freshnessMs: freshnessDays * 24 * 60 * 60_000,
    pendingMs: pendingHours * 60 * 60_000,
  });
  for (const entry of report.checked) {
    console.log(`workflow-health: ${entry.workflow} — ${entry.summary}`);
  }
  if (report.violations.length > 0) {
    console.error(
      `workflow-health: нарушения (${report.violations.length} из ${scope.length} в области):\n` +
        report.violations.map((v) => `- ${v.workflow}: ${v.reason}`).join('\n'),
    );
    process.exit(1);
  }
  console.log(
    `workflow-health: ${scope.length} workflow в области — все стартовали и зелёные (head ${data.headSha.slice(0, 7)}, окно schedule ${freshnessDays} д, окно незавершённых ${pendingHours} ч)`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].endsWith('check-workflow-health.ts');
if (invokedDirectly) {
  main();
}
