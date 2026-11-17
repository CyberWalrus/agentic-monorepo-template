/**
 * Проверка одобрения изменения гейтов для gate-integrity (ADR 0002).
 * Одобрение действительно, только если одновременно:
 *   1) label стоит на PR сейчас;
 *   2) последнее событие labeled новее даты head-коммита PR (прокси времени push);
 *   3) событие сделал человек из глобальных владельцев CODEOWNERS (строка `*`).
 * Свежесть строки 2 — вторая линия: основной механизм — job, снимающий label на
 * synchronize (любой реальный push меняет head-коммит и запускает synchronize).
 * Любая неопределённость (нет события, нет владельцев, битые данные) — не одобрено.
 * Это fail-closed (З4): упавшая или обойдённая проверка блокирует, а не пропускает.
 *
 *   node tools/check-gate-approval.ts [--label <имя>] <pr.json> <events.json> <CODEOWNERS...> <head-commit.json>
 *
 * --label          — какой label считать одобрением (дефолт gate-change-approved;
 *                    A6 PR-2: bundle-growth-approved для роста бандла, ADR 0013).
 * pr.json          — `gh pr view <n> --json labels,headRefOid`
 * events.json      — `gh api issues/<n>/events`
 * CODEOWNERS...    — кандидаты в порядке приоритета GitHub: `.github/`, корень, `docs/`;
 *                    берётся первый существующий файл (шаблон держит живой файл в `docs/`,
 *                    копия — рендер в `.github/`, d8.2)
 * head-commit.json — `gh api commits/<headRefOid>`
 * Вывод: человекочитаемая причина; в $GITHUB_OUTPUT дописывается approved=true|false.
 */
import { appendFileSync, readFileSync } from 'node:fs';

import { evaluateApproval, maintainersOf } from './gate-approval-core.ts';

const DEFAULT_LABEL = 'gate-change-approved';

const args = process.argv.slice(2);

// Флаги вынимаем до позиционных: неизвестный флаг — exit 2 (fail-closed на
// мусорном вызове), а не тихое игнорирование.
let label = DEFAULT_LABEL;
const positionals: string[] = [];
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === undefined) {
    continue;
  }
  if (arg === '--label') {
    const value = args[index + 1];
    if (!value) {
      console.error('check-gate-approval: --label требует значение <имя>');
      process.exit(2);
    }
    label = value;
    index += 1;
    continue;
  }
  if (arg.startsWith('--')) {
    console.error(`check-gate-approval: неизвестный флаг «${arg}» (известен только --label <имя>)`);
    process.exit(2);
  }
  positionals.push(arg);
}

const prPath = positionals[0];
const eventsPath = positionals[1];
const headCommitPath = positionals.at(-1);
const codeownersCandidates = positionals.slice(2, -1);
if (!prPath || !eventsPath || codeownersCandidates.length === 0 || !headCommitPath) {
  console.error(
    'Использование: node tools/check-gate-approval.ts [--label <имя>] <pr.json> <events.json> <CODEOWNERS...> <head-commit.json>',
  );
  process.exit(2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const pr: unknown = JSON.parse(readFileSync(prPath, 'utf8'));
const events: unknown = JSON.parse(readFileSync(eventsPath, 'utf8'));
const headCommit: unknown = JSON.parse(readFileSync(headCommitPath, 'utf8'));
const maintainers = maintainersOf(codeownersCandidates);

const prLabels =
  isRecord(pr) && Array.isArray(pr['labels'])
    ? pr['labels'].flatMap((labelEntry) =>
        isRecord(labelEntry) && typeof labelEntry['name'] === 'string' ? [labelEntry['name']] : [],
      )
    : [];
const commitData = isRecord(headCommit) ? headCommit['commit'] : undefined;
const committer = isRecord(commitData) ? commitData['committer'] : undefined;
const pushedAt =
  isRecord(committer) && typeof committer['date'] === 'string' ? committer['date'] : undefined;

const verdict = evaluateApproval({
  label,
  prLabels,
  events: Array.isArray(events) ? events : [],
  pushedAt,
  maintainers,
});

console.log(`approval: ${verdict.approved ? 'APPROVED' : 'NOT approved'} — ${verdict.reason}`);
if (process.env['GITHUB_OUTPUT']) {
  appendFileSync(process.env['GITHUB_OUTPUT'], `approved=${verdict.approved}\n`);
}
