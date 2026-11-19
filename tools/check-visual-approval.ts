/**
 * Проверка одобрения визуальных базлайнов для доверенного workflow
 * visual-approve.yml (b3.1, ADR 0015): комментарий `/approve-visual <sha>` в
 * PR валиден, только если он ровно этой формы, SHA совпадает с head PR,
 * комментарий новее последнего push и автор — глобальный владелец CODEOWNERS.
 * Проверка автора — из tools/gate-approval-core.ts (та же линия доверия, что у
 * label-одобрений, ADR 0002/0013). Любая неопределённость — не одобрено
 * (fail-closed, З4).
 *
 *   node tools/check-visual-approval.ts <comment.json> <pr.json> <pushed-check-runs.json> <CODEOWNERS...>
 *
 * comment.json            — `gh api repos/<r>/issues/comments/<id>` (author.login, created_at, body)
 * pr.json                 — `gh pr view <n> --json headRefOid,headRefName`
 * pushed-check-runs.json  — `gh api commits/<headRefOid>/check-runs` (время push — min started_at,
 *                           как в gate-integrity: ставит GitHub, автор подделать не может)
 * CODEOWNERS...           — кандидаты в порядке приоритета GitHub
 * Вывод: причина; в $GITHUB_OUTPUT — approved=true|false и reply=<текст для ответа в PR>.
 */
import { appendFileSync, readFileSync } from 'node:fs';

import {
  evaluateVisualApproval,
  maintainersOf,
  type CommentEvent,
} from './visual-approval-core.ts';

const args = process.argv.slice(2);
const positionals = args.filter((arg) => !arg.startsWith('--'));
if (positionals.length < 4) {
  console.error(
    'Использование: node tools/check-visual-approval.ts <comment.json> <pr.json> <pushed-check-runs.json> <CODEOWNERS...>',
  );
  process.exit(2);
}
const [commentPath, prPath, checkRunsPath] = positionals;
const codeownersCandidates = positionals.slice(3);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

let comment: CommentEvent | undefined;
try {
  const raw: unknown = JSON.parse(readFileSync(commentPath, 'utf8'));
  const user = isRecord(raw) ? raw['user'] : undefined;
  const author = isRecord(user) ? stringOf(user['login']) : undefined;
  const createdAt = isRecord(raw) ? stringOf(raw['created_at']) : undefined;
  const body = isRecord(raw) ? stringOf(raw['body']) : undefined;
  if (author && createdAt && body !== undefined) {
    comment = { author, createdAt, body };
  }
} catch (error) {
  console.error(
    `check-visual-approval: comment.json не прочитан (${error instanceof Error ? error.message : String(error)})`,
  );
  process.exit(2);
}

const pr: unknown = JSON.parse(readFileSync(prPath, 'utf8'));
const headSha = isRecord(pr) ? stringOf(pr['headRefOid']) : undefined;
if (!headSha) {
  console.error('check-visual-approval: в pr.json нет headRefOid');
  process.exit(2);
}

// Время последнего push — тот же прокси, что в gate-integrity: самое раннее
// started_at check-run'а на head-коммите; нет ни одного — fail-closed.
const checkRuns: unknown = JSON.parse(readFileSync(checkRunsPath, 'utf8'));
const runs =
  isRecord(checkRuns) && Array.isArray(checkRuns['check_runs']) ? checkRuns['check_runs'] : [];
const startedAts = runs
  .map((run) => (isRecord(run) ? stringOf(run['started_at']) : undefined))
  .filter((value): value is string => value !== undefined && !Number.isNaN(Date.parse(value)));
const pushedAt = startedAts.length > 0 ? startedAts.toSorted()[0] : undefined;

const maintainers = maintainersOf(codeownersCandidates);
const verdict = evaluateVisualApproval({ comment, pull: { headSha, pushedAt }, maintainers });

console.log(
  `visual-approval: ${verdict.approved ? 'APPROVED' : 'NOT approved'} — ${verdict.reason}`,
);
if (process.env['GITHUB_OUTPUT']) {
  appendFileSync(process.env['GITHUB_OUTPUT'], `approved=${verdict.approved}\n`);
  appendFileSync(process.env['GITHUB_OUTPUT'], `reply=${verdict.reason}\n`);
}
