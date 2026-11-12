/**
 * Проверка одобрения изменения гейтов для gate-integrity (ADR 0002).
 * Одобрение действительно, только если одновременно:
 *   1) label `gate-change-approved` стоит на PR сейчас;
 *   2) последнее событие labeled новее даты head-коммита PR (прокси времени push);
 *   3) событие сделал человек из глобальных владельцев .github/CODEOWNERS (строка `*`).
 * Свежесть строки 2 — вторая линия: основной механизм — job, снимающий label на
 * synchronize (любой реальный push меняет head-коммит и запускает synchronize).
 * Любая неопределённость (нет события, нет владельцев, битые данные) — не одобрено.
 * Это fail-closed (З4): упавшая или обойдённая проверка блокирует, а не пропускает.
 *
 *   node tools/check-gate-approval.ts <pr.json> <events.json> <CODEOWNERS> <head-commit.json>
 *
 * pr.json          — `gh pr view <n> --json labels,headRefOid`
 * events.json      — `gh api issues/<n>/events`
 * head-commit.json — `gh api commits/<headRefOid>`
 * Вывод: человекочитаемая причина; в $GITHUB_OUTPUT дописывается approved=true|false.
 */
import { appendFileSync, readFileSync } from 'node:fs';

const LABEL = 'gate-change-approved';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

interface LabeledEvent {
  actor: string;
  createdAt: string;
}

/** Глобальные владельцы CODEOWNERS: логины из строки с паттерном `*`. */
function maintainersOf(codeownersPath: string): Set<string> {
  return new Set(
    readFileSync(codeownersPath, 'utf8')
      .split('\n')
      .filter((line) => {
        const token = line.trim();
        return token.length > 0 && !token.startsWith('#') && token.split(/\s+/)[0] === '*';
      })
      .flatMap((line) => line.trim().split(/\s+/).slice(1))
      .map((mention) => mention.replace(/^@/, ''))
      .filter((login) => login.length > 0),
  );
}

/** Последнее по времени событие labeled для нужного label. */
function lastLabeledEvent(events: unknown[]): LabeledEvent | undefined {
  let latest: LabeledEvent | undefined;
  for (const entry of events) {
    if (!isRecord(entry)) {
      continue;
    }
    if (stringOf(entry['event']) !== 'labeled') {
      continue;
    }
    const label = isRecord(entry['label']) ? stringOf(entry['label']['name']) : undefined;
    if (label !== LABEL) {
      continue;
    }
    const actor = isRecord(entry['actor']) ? stringOf(entry['actor']['login']) : undefined;
    const createdAt = stringOf(entry['created_at']);
    if (!actor || !createdAt) {
      continue;
    }
    if (!latest || Date.parse(createdAt) > Date.parse(latest.createdAt)) {
      latest = { actor, createdAt };
    }
  }
  return latest;
}

const [prPath, eventsPath, codeownersPath, headCommitPath] = process.argv.slice(2);
if (!prPath || !eventsPath || !codeownersPath || !headCommitPath) {
  console.error(
    'Использование: node tools/check-gate-approval.ts <pr.json> <events.json> <CODEOWNERS> <head-commit.json>',
  );
  process.exit(2);
}

const pr: unknown = JSON.parse(readFileSync(prPath, 'utf8'));
const events: unknown = JSON.parse(readFileSync(eventsPath, 'utf8'));
const headCommit: unknown = JSON.parse(readFileSync(headCommitPath, 'utf8'));
const maintainers = maintainersOf(codeownersPath);

let approved = false;
let reason: string;

const labels = isRecord(pr) && Array.isArray(pr['labels']) ? pr['labels'] : [];
const hasLabel =
  isRecord(pr) && labels.some((label) => isRecord(label) && stringOf(label['name']) === LABEL);
// commit.committer.date — время создания head-коммита (прокси времени push).
const commitData = isRecord(headCommit) ? headCommit['commit'] : undefined;
const pushedAt =
  isRecord(commitData) && isRecord(commitData['committer'])
    ? stringOf(commitData['committer']['date'])
    : undefined;

if (!maintainers.size) {
  reason = 'в CODEOWNERS нет глобальных владельцев (строка `*`) — некому доверять одобрение';
} else if (!hasLabel) {
  reason = `label ${LABEL} не стоит на PR`;
} else if (!pushedAt || Number.isNaN(Date.parse(pushedAt))) {
  reason = 'не удалось определить время head-коммита PR';
} else {
  const event = lastLabeledEvent(Array.isArray(events) ? events : []);
  if (!event) {
    reason = `нет события labeled для ${LABEL} (истёк срок хранения API) — поставить заново`;
  } else if (!maintainers.has(event.actor)) {
    reason = `label поставил @${event.actor}, который не входит в глобальных владельцев CODEOWNERS`;
  } else if (Date.parse(event.createdAt) <= Date.parse(pushedAt)) {
    reason = `label поставлен ${event.createdAt}, до последнего push (head-коммит ${pushedAt})`;
  } else {
    approved = true;
    reason = `label поставлен @${event.actor} (владелец CODEOWNERS) после последнего push (head-коммит ${pushedAt})`;
  }
}

console.log(`approval: ${approved ? 'APPROVED' : 'NOT approved'} — ${reason}`);
if (process.env['GITHUB_OUTPUT']) {
  appendFileSync(process.env['GITHUB_OUTPUT'], `approved=${approved}\n`);
}
