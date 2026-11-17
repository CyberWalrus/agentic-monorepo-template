/**
 * Доверенное решение дельта-гейта бандла (A6 PR-2, ADR 0013) для job'а
 * bundle-approval в gate-integrity.yml. Замер делает untrusted ci-job
 * bundle-delta (ci.yml из merge-ref, исполняет код PR); решение — здесь:
 * определение из base, код PR не исполняется, только GitHub API и файлы,
 * полученные из него (образец ADR 0002). Fail-closed (З4): check-run не
 * найден, не завершён, отменён или одобрение невалидно — блокирует.
 *
 *   node tools/check-bundle-gate.ts <check-runs.json> <pr.json> <events.json> <head-commit.json> <CODEOWNERS...>
 *
 * check-runs.json  — `gh api commits/<headRefOid>/check-runs`
 * pr.json          — `gh pr view <n> --json labels,headRefOid`
 * events.json      — `gh api issues/<n>/events`
 * head-commit.json — `gh api commits/<headRefOid>`
 * CODEOWNERS...    — кандидаты в порядке приоритета GitHub: `.github/`, корень, `docs/`.
 * Вывод: человекочитаемая причина; в $GITHUB_OUTPUT дописывается approved=true|false.
 */
import { appendFileSync, readFileSync } from 'node:fs';

import { evaluateApproval, maintainersOf } from './gate-approval-core.ts';

const CHECK_NAME = 'bundle-delta';
const LABEL = 'bundle-growth-approved';

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
    return [
      {
        name,
        status,
        conclusion: stringOf(run['conclusion']) ?? null,
        completedAt: stringOf(run['completed_at']) ?? null,
      },
    ];
  });
}

const args = process.argv.slice(2);
const checkRunsPath = args[0];
const prPath = args[1];
const eventsPath = args[2];
const headCommitPath = args[3];
const codeownersCandidates = args.slice(4);
if (
  !checkRunsPath ||
  !prPath ||
  !eventsPath ||
  !headCommitPath ||
  codeownersCandidates.length === 0 ||
  args.some((arg) => arg.startsWith('--'))
) {
  console.error(
    'Использование: node tools/check-bundle-gate.ts <check-runs.json> <pr.json> <events.json> <head-commit.json> <CODEOWNERS...>',
  );
  process.exit(2);
}

const payload: unknown = JSON.parse(readFileSync(checkRunsPath, 'utf8'));
const pr: unknown = JSON.parse(readFileSync(prPath, 'utf8'));
const events: unknown = JSON.parse(readFileSync(eventsPath, 'utf8'));
const headCommit: unknown = JSON.parse(readFileSync(headCommitPath, 'utf8'));

const named = parseCheckRuns(payload).filter((run) => run.name === CHECK_NAME);

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
  // retarget/edited рождает несколько check-run на один head SHA: берём
  // последний завершённый по времени (ADR 0013).
  const latest = named
    .flatMap((run) => (run.completedAt ? [{ run, completedAt: run.completedAt }] : []))
    .toSorted((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt))
    .at(-1)?.run;
  if (!latest) {
    verdict = `у check-run ${CHECK_NAME} нет completed_at — битые данные API, блокирует (fail-closed, З4)`;
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
    const commitData = isRecord(headCommit) ? headCommit['commit'] : undefined;
    const committer = isRecord(commitData) ? commitData['committer'] : undefined;
    const pushedAt =
      isRecord(committer) && typeof committer['date'] === 'string' ? committer['date'] : undefined;
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
