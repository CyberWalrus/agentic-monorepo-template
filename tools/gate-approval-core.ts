/**
 * Чистое ядро проверки одобрения изменения гейтов (ADR 0002; параметризация по
 * label — A6 PR-2, ADR 0013). Импортируют CLI-чекеры check-gate-approval.ts
 * (дефолт gate-change-approved) и check-bundle-gate.ts
 * (bundle-growth-approved). Любая неопределённость — не одобрено: fail-closed
 * (З4): упавшая или обойдённая проверка блокирует, а не пропускает.
 */
import { existsSync, readFileSync } from 'node:fs';

export interface LabeledEvent {
  actor: string;
  createdAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Глобальные владельцы CODEOWNERS: логины из строк с паттерном `*`. */
export function maintainersOf(codeownersCandidates: string[]): Set<string> {
  const codeownersPath = codeownersCandidates.find((candidate) => existsSync(candidate));
  if (!codeownersPath) {
    return new Set();
  }
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
export function lastLabeledEvent(events: unknown[], label: string): LabeledEvent | undefined {
  let latest: LabeledEvent | undefined;
  for (const entry of events) {
    if (!isRecord(entry)) {
      continue;
    }
    if (stringOf(entry['event']) !== 'labeled') {
      continue;
    }
    const labelName = isRecord(entry['label']) ? stringOf(entry['label']['name']) : undefined;
    if (labelName !== label) {
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

export interface ApprovalInput {
  /** Имя label-а, которым одобряется изменение. */
  label: string;
  /** Имена label-ов на PR сейчас (pr.json). */
  prLabels: string[];
  /** Лента событий issues (events.json). */
  events: unknown[];
  /** Время head-коммита PR (прокси времени push) или undefined, если не прочитать. */
  pushedAt: string | undefined;
  /** Глобальные владельцы CODEOWNERS. */
  maintainers: Set<string>;
}

export interface ApprovalVerdict {
  approved: boolean;
  reason: string;
}

/**
 * Одобрение действительно, только если одновременно: label стоит на PR сейчас;
 * последнее событие labeled новее даты head-коммита (прокси времени push);
 * событие сделал владелец CODEOWNERS из строки `*`. Свежесть — вторая линия:
 * основная — job, снимающий label на synchronize.
 */
export function evaluateApproval(input: ApprovalInput): ApprovalVerdict {
  const { label, prLabels, events, pushedAt, maintainers } = input;
  if (!maintainers.size) {
    return {
      approved: false,
      reason:
        'в CODEOWNERS (кандидаты: .github/, корень, docs/) нет файла со строкой `*` — некому доверять одобрение',
    };
  }
  if (!prLabels.includes(label)) {
    return { approved: false, reason: `label ${label} не стоит на PR` };
  }
  if (!pushedAt || Number.isNaN(Date.parse(pushedAt))) {
    return { approved: false, reason: 'не удалось определить время head-коммита PR' };
  }
  const event = lastLabeledEvent(events, label);
  if (!event) {
    return {
      approved: false,
      reason: `нет события labeled для ${label} (истёк срок хранения API) — поставить заново`,
    };
  }
  if (!maintainers.has(event.actor)) {
    return {
      approved: false,
      reason: `label поставил @${event.actor}, который не входит в глобальных владельцев CODEOWNERS`,
    };
  }
  if (Date.parse(event.createdAt) <= Date.parse(pushedAt)) {
    return {
      approved: false,
      reason: `label поставлен ${event.createdAt}, до последнего push (head-коммит ${pushedAt})`,
    };
  }
  return {
    approved: true,
    reason: `label поставлен @${event.actor} (владелец CODEOWNERS) после последнего push (head-коммит ${pushedAt})`,
  };
}
