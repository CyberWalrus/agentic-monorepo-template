/**
 * Чистое ядро одобрения визуальных базлайнов командой мейнтейнера в PR
 * (b3.1, ADR 0015). Импортируют CLI tools/check-visual-approval.ts и тесты.
 * Любая неопределённость — не одобрено: fail-closed (З4).
 * Проверка автора — та же линия доверия, что у label-одобрений (З1/З2):
 * глобальные владельцы CODEOWNERS из tools/gate-approval-core.ts, вторая
 * реализация не пишется (Решение b3.1).
 */
import { maintainersOf } from './gate-approval-core.ts';

export interface CommentEvent {
  author: string;
  createdAt: string;
  body: string;
}

/** SHA head-коммита PR и время последнего push (прокси — из check-run'ов). */
export interface PullFact {
  headSha: string;
  pushedAt: string | undefined;
}

export interface VisualApprovalInput {
  comment: CommentEvent | undefined;
  pull: PullFact;
  /** Глобальные владельцы CODEOWNERS (строка `*`). */
  maintainers: Set<string>;
}

export interface VisualVerdict {
  approved: boolean;
  reason: string;
}

const COMMAND_RE = /^\/approve-visual\s+([0-9a-f]{40})\s*$/;

/** Это вообще команда одобрения (даже если кривая)? — для ответа в PR. */
export function isApproveCommand(body: string): boolean {
  return body.trim().startsWith('/approve-visual');
}

/**
 * Одобрение действительно, только если одновременно: текст комментария —
 * ровно `/approve-visual <sha>`; SHA совпадает с текущим head PR; комментарий
 * новее последнего push; автор — глобальный владелец CODEOWNERS.
 */
export function evaluateVisualApproval(input: VisualApprovalInput): VisualVerdict {
  const { comment, pull, maintainers } = input;
  if (!maintainers.size) {
    return {
      approved: false,
      reason:
        'в CODEOWNERS (кандидаты: .github/, корень, docs/) нет файла со строкой `*` — некому доверять одобрение',
    };
  }
  if (comment === undefined) {
    return { approved: false, reason: 'комментарий не прочитан из API (fail-closed, З4)' };
  }
  const match = COMMAND_RE.exec(comment.body.trim());
  if (match === null) {
    return {
      approved: false,
      reason:
        'команда не распознана — ожидается ровно одна строка: /approve-visual <40-символьный sha>',
    };
  }
  const sha = match[1] ?? '';
  if (sha !== pull.headSha) {
    return {
      approved: false,
      reason: `SHA в команде (${sha.slice(0, 12)}) не совпадает с head PR (${pull.headSha.slice(0, 12)}) — после просмотра диффа был push; посмотрите свежий дифф и повторите команду`,
    };
  }
  if (!pull.pushedAt || Number.isNaN(Date.parse(pull.pushedAt))) {
    return {
      approved: false,
      reason: 'не удалось определить время последнего push (fail-closed, З4)',
    };
  }
  if (Date.parse(comment.createdAt) <= Date.parse(pull.pushedAt)) {
    return {
      approved: false,
      reason: `комментарий оставлен ${comment.createdAt}, до последнего push (${pull.pushedAt}) — одобрен может быть только просмотр последнего диффа`,
    };
  }
  if (!maintainers.has(comment.author)) {
    return {
      approved: false,
      reason: `команду оставил @${comment.author}, который не входит в глобальные владельцы CODEOWNERS`,
    };
  }
  return {
    approved: true,
    reason: `команда @${comment.author} (владелец CODEOWNERS) на head SHA ${pull.headSha.slice(0, 12)} после последнего push (${pull.pushedAt})`,
  };
}

export { maintainersOf };
