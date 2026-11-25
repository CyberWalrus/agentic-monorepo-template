/**
 * Доверенное решение дельта-гейта бандла (A6 PR-2, ADR 0013) для job'а
 * bundle-approval в gate-integrity.yml. Замер делает untrusted ci-job
 * bundle-delta (ci.yml из merge-ref, исполняет код PR); решение — здесь:
 * определение из base, код PR не исполняется, только GitHub API и файлы,
 * полученные из него (образец ADR 0002). Fail-closed (З4): check-run не
 * найден, не завершён, отменён или одобрение невалидно — блокирует. Замер,
 * сделанный до последней смены base-ветки PR, тоже блокирует (e78): см.
 * staleBaseChange.
 *
 *   node tools/check-bundle-gate.ts <check-runs.json> <pr.json> <events.json> <head-commit.json> <base-change.json> <suites.json> <CODEOWNERS...>
 *
 * check-runs.json   — `gh api commits/<headRefOid>/check-runs`
 * pr.json           — `gh pr view <n> --json labels,headRefOid`
 * events.json       — `gh api issues/<n>/events`
 * head-commit.json  — `gh api commits/<headRefOid>`
 * base-change.json  — `gh api graphql`: узлы timelineItems(itemTypes: [BASE_REF_CHANGED_EVENT], last: 1) PR — последнее событие смены base или «[]»
 * suites.json       — `gh api check-suites/<id>` каждого check-run bundle-delta: массив {id, created_at}
 * CODEOWNERS...     — кандидаты в порядке приоритета GitHub: `.github/`, корень, `docs/`.
 * Вывод: человекочитаемая причина; в $GITHUB_OUTPUT дописывается approved=true|false.
 */
import { appendFileSync, readFileSync } from 'node:fs';

import { evaluateApproval, maintainersOf } from './gate-approval-core.ts';

const CHECK_NAME = 'bundle-delta';
const LABEL = 'bundle-growth-approved';
const REPAIR =
  'Смена base не порождает synchronize, а bundle-delta делает только ci-job на pull_request ' +
  '(merge-ref): прогон ci-base-change.yml, merge queue и push его не повторяют (e78). ' +
  'Замер на новой базе — Update branch или пустой коммит в ветку PR.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  completedAt: string | null;
  /** id check suite run'а, породившего check-run; у чужого check-run может не быть. */
  checkSuiteId: number | null;
}

interface Suite {
  id: number;
  createdAt: string | null;
}

interface BaseChange {
  createdAt: unknown;
  previousRefName: unknown;
  currentRefName: unknown;
}

function parseCheckRuns(payload: unknown): CheckRun[] {
  const runs =
    isRecord(payload) && Array.isArray(payload['check_runs']) ? payload['check_runs'] : [];
  return runs.flatMap((run) => {
    if (!isRecord(run)) {
      return [];
    }
    const name = stringOf(run['name']);
    const status = stringOf(run['status']);
    if (!name || !status) {
      return [];
    }
    const suite = isRecord(run['check_suite']) ? run['check_suite']['id'] : undefined;
    return [
      {
        name,
        status,
        conclusion: stringOf(run['conclusion']) ?? null,
        completedAt: stringOf(run['completed_at']) ?? null,
        checkSuiteId: typeof suite === 'number' ? suite : null,
      },
    ];
  });
}

function parseSuites(payload: unknown): Suite[] {
  if (!Array.isArray(payload)) {
    return [];
  }
  return payload.flatMap((entry) =>
    isRecord(entry) && typeof entry['id'] === 'number'
      ? [{ id: entry['id'], createdAt: stringOf(entry['created_at']) ?? null }]
      : [],
  );
}

/**
 * Последнее (last: 1) событие смены base-ветки PR; пустой массив — смен не
 * было. Форма ответа не та (не массив) или узел не читается — смена не
 * исключена: возвращаем событие без времени, его блокирует staleBaseChange.
 */
function parseBaseChange(payload: unknown): BaseChange | undefined {
  if (!Array.isArray(payload)) {
    return { createdAt: undefined, previousRefName: undefined, currentRefName: undefined };
  }
  if (payload.length === 0) {
    return undefined;
  }
  const latest: unknown = payload.at(-1);
  const field = (name: string): unknown => (isRecord(latest) ? latest[name] : undefined);
  return {
    createdAt: field('createdAt'),
    previousRefName: field('previousRefName'),
    currentRefName: field('currentRefName'),
  };
}

function refOf(value: unknown): string {
  return typeof value === 'string' ? value : '?';
}

/**
 * Замер свежий, когда run, его породивший, создан позже последней смены
 * base-ветки PR (e78). Время замера — created_at check suite run'а (равно
 * created_at run'а): started_at check-run не годится — job, вставший в очередь
 * до смены base, стартует позже неё с прежней базой в payload. Смены base не
 * было — время замера не нужно: обычные PR не зависят от этой сверки. Иначе
 * любая неизвестность (не читается время смены, нет suite) — блок.
 */
function staleBaseChange(
  run: CheckRun,
  baseChange: BaseChange | undefined,
  suites: readonly Suite[],
): string | undefined {
  if (!baseChange) {
    return undefined;
  }
  const moved = `${refOf(baseChange.previousRefName)} → ${refOf(baseChange.currentRefName)}`;
  const changedAtText = stringOf(baseChange.createdAt);
  const changedAt = Date.parse(changedAtText ?? '');
  if (changedAtText === undefined || Number.isNaN(changedAt)) {
    return (
      `base-ветка PR менялась (${moved}), но время смены не читается из таймлайна — ` +
      `блокирует (fail-closed, З4). ${REPAIR}`
    );
  }
  const suite = suites.find((entry) => entry.id === run.checkSuiteId);
  const measuredAtText = suite?.createdAt;
  const measuredAt = Date.parse(measuredAtText ?? '');
  if (measuredAtText === undefined || Number.isNaN(measuredAt)) {
    return (
      `base-ветка PR сменена ${changedAtText} (${moved}), а время создания замера ` +
      `${CHECK_NAME} неизвестно (check suite не найден или без created_at) — ` +
      `блокирует (fail-closed, З4). ${REPAIR}`
    );
  }
  if (measuredAt <= changedAt) {
    return (
      `${CHECK_NAME} замерен на прежней базе: run замера создан ${measuredAtText}, ` +
      `base-ветка PR сменена позже — ${moved} (${changedAtText}). ${REPAIR}`
    );
  }
  return undefined;
}

const args = process.argv.slice(2);
const checkRunsPath = args[0];
const prPath = args[1];
const eventsPath = args[2];
const headCommitPath = args[3];
const baseChangePath = args[4];
const suitesPath = args[5];
const codeownersCandidates = args.slice(6);
if (
  !checkRunsPath ||
  !prPath ||
  !eventsPath ||
  !headCommitPath ||
  !baseChangePath ||
  !suitesPath ||
  codeownersCandidates.length === 0 ||
  args.some((arg) => arg.startsWith('--'))
) {
  console.error(
    'Использование: node tools/check-bundle-gate.ts <check-runs.json> <pr.json> <events.json> <head-commit.json> <base-change.json> <suites.json> <CODEOWNERS...>',
  );
  process.exit(2);
}

const payload: unknown = JSON.parse(readFileSync(checkRunsPath, 'utf8'));
const pr: unknown = JSON.parse(readFileSync(prPath, 'utf8'));
const events: unknown = JSON.parse(readFileSync(eventsPath, 'utf8'));
const headCommit: unknown = JSON.parse(readFileSync(headCommitPath, 'utf8'));
const baseChangePayload: unknown = JSON.parse(readFileSync(baseChangePath, 'utf8'));
const suitesPayload: unknown = JSON.parse(readFileSync(suitesPath, 'utf8'));

const named = parseCheckRuns(payload).filter((run) => run.name === CHECK_NAME);
const suites = parseSuites(suitesPayload);
const baseChange = parseBaseChange(baseChangePayload);

let verdict: string;
let approved = false;

if (named.length === 0) {
  verdict =
    `check-run ${CHECK_NAME} не найден на head SHA — job не запустился или удалён из ci.yml. ` +
    'Удаление — правка защищённого пути .github/** (нужно gate-change-approved); ' +
    'если job просто ещё не создался — перезапустите bundle-approval.';
} else if (named.some((run) => run.status !== 'completed')) {
  verdict =
    `check-run ${CHECK_NAME} не завершён (poll в job'е должен был дождаться) — ` +
    'перезапустите bundle-approval; красный по таймауту ≠ рост бандла (ADR 0013).';
} else {
  // Перезапуск run'а на том же head SHA рождает несколько check-run: берём
  // последний завершённый по времени (ADR 0013). Смена base новый check-run не
  // рождает — замер старше неё блокируется ниже (e78).
  const latest = named
    .flatMap((run) => (run.completedAt ? [{ run, completedAt: run.completedAt }] : []))
    .toSorted((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt))
    .at(-1)?.run;
  const stale = latest ? staleBaseChange(latest, baseChange, suites) : undefined;
  if (!latest) {
    verdict = `у check-run ${CHECK_NAME} нет completed_at — битые данные API, блокирует (fail-closed, З4)`;
  } else if (stale) {
    verdict = stale;
  } else if (latest.conclusion === 'success') {
    verdict = `${CHECK_NAME} зелёный на head SHA (${latest.completedAt})`;
    approved = true;
  } else if (latest.conclusion === 'failure') {
    const labels =
      isRecord(pr) && Array.isArray(pr['labels'])
        ? pr['labels'].flatMap((labelEntry) =>
            isRecord(labelEntry) && typeof labelEntry['name'] === 'string'
              ? [labelEntry['name']]
              : [],
          )
        : [];
    // pushedAt из pr.json автор подделать не может; committer.date — фолбэк
    // (GIT_COMMITTER_DATE подконтролен автору; см. check-gate-approval.ts).
    const commitData = isRecord(headCommit) ? headCommit['commit'] : undefined;
    const committer = isRecord(commitData) ? commitData['committer'] : undefined;
    const prPushedAt =
      isRecord(pr) && typeof pr['pushedAt'] === 'string' ? pr['pushedAt'] : undefined;
    const commitDate =
      isRecord(committer) && typeof committer['date'] === 'string' ? committer['date'] : undefined;
    const pushedAt = prPushedAt ?? commitDate;
    const approval = evaluateApproval({
      label: LABEL,
      prLabels: labels,
      events: Array.isArray(events) ? events : [],
      pushedAt,
      maintainers: maintainersOf(codeownersCandidates),
    });
    verdict = approval.approved
      ? `рост бандла одобрен: ${approval.reason}`
      : `рост бандла не одобрен: ${approval.reason}`;
    approved = approval.approved;
  } else {
    verdict = `${CHECK_NAME} завершился с conclusion «${latest.conclusion}» — блокирует (fail-closed, З4)`;
  }
}

console.log(`bundle-gate: ${approved ? 'PASS' : 'FAIL'} — ${verdict}`);
if (process.env['GITHUB_OUTPUT']) {
  appendFileSync(process.env['GITHUB_OUTPUT'], `approved=${approved}\n`);
}
if (!approved) {
  process.exitCode = 1;
}
