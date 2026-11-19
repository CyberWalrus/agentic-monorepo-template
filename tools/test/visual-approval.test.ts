/**
 * Тесты одобрения визуальных базлайнов (b3.1, ADR 0015): логика ядра
 * (visual-approval-core) на чистых функциях, проводка чекера в доверенный
 * workflow и фазы перезаписи в CI — по образцу B4.1 (канарейка gate-canaries
 * ловит срыв привязки, якорь — заголовок wiring-блока).
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  evaluateVisualApproval,
  isApproveCommand,
  type CommentEvent,
} from '../visual-approval-core.ts';

const MAINTAINERS = new Set(['CyberWalrus']);
const HEAD = 'a'.repeat(40);
const pull = { headSha: HEAD, pushedAt: '2026-11-19T17:00:00Z' };

const comment = (overrides: Partial<CommentEvent> = {}): CommentEvent => ({
  author: 'CyberWalrus',
  createdAt: '2026-11-19T17:10:00Z',
  body: `/approve-visual ${HEAD}`,
  ...overrides,
});

describe('evaluateVisualApproval', () => {
  it('валидная команда владельца CODEOWNERS на текущий head после push — одобрено', () => {
    const verdict = evaluateVisualApproval({ comment: comment(), pull, maintainers: MAINTAINERS });
    expect(verdict.approved).toBe(true);
  });

  it('не-команда (обычный комментарий) — не одобрено', () => {
    const verdict = evaluateVisualApproval({
      comment: comment({ body: 'смотрю дифф' }),
      pull,
      maintainers: MAINTAINERS,
    });
    expect(verdict.approved).toBe(false);
  });

  it('лишний текст в команде — не одобрено (форма строгая)', () => {
    const verdict = evaluateVisualApproval({
      comment: comment({ body: `/approve-visual ${HEAD}\nсмотрел, ок` }),
      pull,
      maintainers: MAINTAINERS,
    });
    expect(verdict.approved).toBe(false);
    expect(verdict.reason).toMatch(/не распознана/);
  });

  it('короткий SHA — не одобрено (подмена префиксом невозможна)', () => {
    const verdict = evaluateVisualApproval({
      comment: comment({ body: `/approve-visual ${HEAD.slice(0, 12)}` }),
      pull,
      maintainers: MAINTAINERS,
    });
    expect(verdict.approved).toBe(false);
  });

  it('SHA не совпадает с head PR (push после просмотра) — не одобрено', () => {
    const verdict = evaluateVisualApproval({
      comment: comment({ body: `/approve-visual ${'b'.repeat(40)}` }),
      pull,
      maintainers: MAINTAINERS,
    });
    expect(verdict.approved).toBe(false);
    expect(verdict.reason).toMatch(/не совпадает с head/);
  });

  it('комментарий старше последнего push — не одобрено', () => {
    const verdict = evaluateVisualApproval({
      comment: comment({ createdAt: '2026-11-19T16:59:00Z' }),
      pull,
      maintainers: MAINTAINERS,
    });
    expect(verdict.approved).toBe(false);
    expect(verdict.reason).toMatch(/до последнего push/);
  });

  it('автор не из глобальных владельцев CODEOWNERS — не одобрено', () => {
    const verdict = evaluateVisualApproval({
      comment: comment({ author: 'random-contributor' }),
      pull,
      maintainers: MAINTAINERS,
    });
    expect(verdict.approved).toBe(false);
    expect(verdict.reason).toMatch(/не входит в глобальные владельцы/);
  });

  it('нет владельцев CODEOWNERS — не одобрено (fail-closed)', () => {
    const verdict = evaluateVisualApproval({ comment: comment(), pull, maintainers: new Set() });
    expect(verdict.approved).toBe(false);
  });

  it('комментарий не прочитан из API — не одобрено (fail-closed)', () => {
    const verdict = evaluateVisualApproval({ comment: undefined, pull, maintainers: MAINTAINERS });
    expect(verdict.approved).toBe(false);
  });

  it('isApproveCommand: намерение команды видно даже при кривой форме', () => {
    expect(isApproveCommand('/approve-visual abc')).toBe(true);
    expect(isApproveCommand('обсуждение /approve-visual')).toBe(false);
  });
});

describe('проводка: визуальное одобрение в доверенном workflow и CI', () => {
  const repoRoot = resolve(import.meta.dirname, '../..');
  const workflow = readFileSync(join(repoRoot, '.github/workflows/visual-approve.yml'), 'utf8');
  const ci = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');

  it('workflow вызывает чекер одобрения на тех же кандидатах CODEOWNERS', () => {
    expect(workflow).toMatch(/node tools\/check-visual-approval\.ts/);
    expect(workflow).toMatch(/\.github\/CODEOWNERS CODEOWNERS docs\/CODEOWNERS/);
  });

  it('CI собирает артефакт visual-actuals, workflow его потребляет', () => {
    expect(ci).toMatch(/bash tools\/visual-ci\.sh/);
    expect(ci).toMatch(/name: visual-actuals/);
    expect(workflow).toMatch(/"visual-actuals"/);
  });

  it('workflow диспатчит CI на новый head SHA (push токеном события не триггерит)', () => {
    expect(workflow).toMatch(/ci\.yml\/dispatches/);
    expect(ci).toMatch(/workflow_dispatch:/);
  });
});
