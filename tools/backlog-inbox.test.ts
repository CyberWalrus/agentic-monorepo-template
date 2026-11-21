/**
 * Тесты инбокса человека (задача e8): парсер вывода gh и сортировка.
 * Критерии приёмки: PR, разблокирующий три задачи, стоит выше PR,
 * разблокирующего одну; задача «человек: …» с незакрытой зависимостью
 * в список не попадает; без gh вывод содержит явное предупреждение
 * о неполноте.
 *
 * Размещение: рядом с логикой (tools/backlog-inbox.test.ts), не в
 * tools/test/ — каталог под deny (ADR 0014), правка требует режима
 * обслуживания. Файл не входит в гейт-контур: его прогон — pnpm test:inbox
 * (вне verify), перенос в tools/test/ — операторский PR-хвост. Пока файл
 * вне гейтов, регрессии ловит только ручной прогон — осознанный разрыв,
 * записанный в журнале задачи e8.
 */
import { describe, expect, it } from 'vitest';

import { parseTask, type TaskFile } from './backlog-board.ts';
import {
  buildInboxItems,
  INBOX_IDLE_HOURS,
  parseChecks,
  parsePrView,
  sortInboxItems,
  type InboxFacts,
  type InboxItem,
  type LabelState,
  type PrFact,
} from './backlog-inbox.ts';

const taskFile = (id: string, front: { dependsOn?: string; needsHuman?: string } = {}): TaskFile =>
  parseTask(
    id,
    `---\ntitle: задача ${id}\ntype: change\npriority: medium\ndepends_on: ${front.dependsOn ?? ''}\ntouches:\nneeds_human: ${front.needsHuman ?? ''}\n---\n# ${id}\n\n## Журнал\n`,
    false,
  );

const label = (needed: boolean, approved = true, staleByPush = false): LabelState => ({
  needed,
  approved: needed ? approved : true,
  reason:
    needed && !approved ? (staleByPush ? 'label поставлен раньше push' : 'label не стоит') : '',
  staleByPush,
});

const pr = (overrides: Partial<PrFact> & { number: number; branch: string }): PrFact => ({
  title: `PR ${overrides.number}`,
  taskId: overrides.branch.startsWith('task/') ? overrides.branch.slice('task/'.length) : null,
  reviewDecision: 'REVIEW_REQUIRED',
  labels: [],
  files: [],
  headCommittedAt: '2026-11-20T10:00:00Z',
  checks: 'green',
  mergeable: 'MERGEABLE',
  isDraft: false,
  ...overrides,
});

const facts = (overrides: Partial<InboxFacts> = {}): InboxFacts => ({
  tasks: [],
  prs: [],
  labelStates: new Map(),
  branchAgeHours: new Map(),
  claimedIds: new Set(),
  maintenanceFileFound: false,
  ...overrides,
});

const itemsOf = (inbox: { items: InboxItem[] }): string[] =>
  inbox.items.map((item) => `${item.kind}:${item.target}`);

describe('parsePrView', () => {
  it('разбирает полный вывод gh pr view', () => {
    const raw = JSON.stringify({
      number: 109,
      headRefName: 'task/a10',
      title: 'A10: храповик',
      reviewDecision: 'APPROVED',
      labels: [{ name: 'gate-change-approved' }],
      files: [{ path: 'tools/backlog.ts' }, { path: 'AGENTS.md' }],
      commits: [
        { committedDate: '2026-11-20T09:00:00Z' },
        { committedDate: '2026-11-20T10:00:00Z' },
      ],
      statusCheckRollup: [
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { __typename: 'StatusContext', state: 'SUCCESS' },
      ],
      mergeable: 'MERGEABLE',
      isDraft: false,
    });
    const fact = parsePrView(raw);
    expect(fact).not.toBeNull();
    expect(fact?.number).toBe(109);
    expect(fact?.taskId).toBe('a10');
    expect(fact?.reviewDecision).toBe('APPROVED');
    expect(fact?.labels).toEqual(['gate-change-approved']);
    expect(fact?.files).toEqual(['tools/backlog.ts', 'AGENTS.md']);
    expect(fact?.headCommittedAt).toBe('2026-11-20T10:00:00Z');
    expect(fact?.checks).toBe('green');
  });

  it('битый JSON и нехватка обязательных полей — null (fail-closed)', () => {
    expect(parsePrView('not json')).toBeNull();
    expect(parsePrView('[]')).toBeNull();
    expect(parsePrView(JSON.stringify({ headRefName: 'task/a10' }))).toBeNull();
    expect(parsePrView(JSON.stringify({ number: 1 }))).toBeNull();
  });

  it('неизвестная форма проверок — unknown, а не зелёность (З4)', () => {
    expect(parseChecks([])).toBe('unknown');
    expect(parseChecks('not array')).toBe('unknown');
    expect(parseChecks([{ __typename: 'WhoKnows' }])).toBe('unknown');
    expect(parseChecks([{ __typename: 'CheckRun', status: 'IN_PROGRESS' }])).toBe('unknown');
    expect(
      parseChecks([
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' },
      ]),
    ).toBe('red');
    expect(parseChecks([{ __typename: 'StatusContext', state: 'PENDING' }])).toBe('unknown');
  });
});

describe('сортировка инбокса (критерий приёмки)', () => {
  it('PR, разблокирующий три задачи, стоит выше PR, разблокирующего одну', () => {
    const items: InboxItem[] = [
      {
        kind: 'pr',
        action: 'approve PR #1 (task/a)',
        target: 'PR #1 (task/a)',
        unblocks: 1,
        note: '',
        actionable: true,
      },
      {
        kind: 'pr',
        action: 'approve PR #2 (task/b)',
        target: 'PR #2 (task/b)',
        unblocks: 3,
        note: '',
        actionable: true,
      },
    ];
    const sorted = sortInboxItems(items);
    expect(sorted[0]?.target).toBe('PR #2 (task/b)');
    expect(sorted[1]?.target).toBe('PR #1 (task/a)');
  });

  it('файл режима обслуживания всегда первый; пассивные строки в конце', () => {
    const items: InboxItem[] = [
      {
        kind: 'pr',
        action: 'merge PR #5 (task/c)',
        target: 'PR #5 (task/c)',
        unblocks: 2,
        note: '',
        actionable: true,
      },
      {
        kind: 'maintenance-file',
        action: 'удали .claude/settings.local.json',
        target: '.claude/settings.local.json',
        unblocks: 0,
        note: '',
        actionable: true,
      },
      {
        kind: 'deferred-task',
        action: 'без действия',
        target: 'e10',
        unblocks: 1,
        note: '',
        actionable: false,
      },
    ];
    const sorted = sortInboxItems(items);
    expect(sorted.map((item) => item.kind)).toEqual(['maintenance-file', 'pr', 'deferred-task']);
  });
});

describe('сборка инбокса', () => {
  it('«человек: …» с незакрытой зависимостью в список не попадает (критерий приёмки)', () => {
    const h1 = {
      ...taskFile('h1', { needsHuman: 'человек: смержить PR #101' }),
      dependsOn: ['d1'],
    };
    const d1 = taskFile('d1');
    const inbox = buildInboxItems(facts({ tasks: [h1, d1] }));
    expect(notMentioning(inbox, 'h1')).toBe(true);
    expect(itemsOf(inbox)).not.toContain('human-task:h1');
  });

  it('«человек: …» с закрытыми зависимостями попадает в список с весом зависимых', () => {
    const tasks = [
      { ...taskFile('h1', { needsHuman: 'человек: ввести секрет' }), dependsOn: ['d9'] },
      { ...taskFile('d9'), done: true },
      taskFile('w1', { dependsOn: 'h1' }),
      taskFile('w2', { dependsOn: 'h1' }),
    ];
    const inbox = buildInboxItems(facts({ tasks }));
    const item = inbox.items.find((entry) => entry.kind === 'human-task');
    expect(item?.target).toBe('h1');
    expect(item?.action).toBe('ввести секрет');
    expect(item?.unblocks).toBe(2);
    expect(item?.actionable).toBe(true);
  });

  it('«отложено: …» перечисляет условие без призыва к действию', () => {
    const tasks = [taskFile('e10', { needsHuman: 'отложено: приёмщиков стало больше одного' })];
    const inbox = buildInboxItems(facts({ tasks }));
    const item = inbox.items.find((entry) => entry.kind === 'deferred-task');
    expect(item?.actionable).toBe(false);
    expect(item?.action).toBe('без действия');
    expect(item?.note).toContain('приёмщиков стало больше одного');
  });

  it('без gh список содержит явное предупреждение о неполноте (критерий приёмки)', () => {
    const inbox = buildInboxItems(facts({ prs: null, tasks: [taskFile('a1')] }));
    expect(inbox.incomplete.some((line) => line.includes('gh недоступен'))).toBe(true);
    expect(inbox.incomplete.some((line) => line.includes('неполн'))).toBe(true);
  });

  it('PR без задачной ветки не попадает в инбокс', () => {
    const inbox = buildInboxItems(facts({ prs: [pr({ number: 5, branch: 'feature/x' })] }));
    expect(inbox.items).toEqual([]);
  });

  it('PR ждёт approve и merge отдельными строками, label не нужен', () => {
    const inbox = buildInboxItems(
      facts({ prs: [pr({ number: 12, branch: 'task/a1' })], tasks: [taskFile('a1')] }),
    );
    expect(itemsOf(inbox)).toEqual(['pr:PR #12 (task/a1)', 'pr:PR #12 (task/a1)']);
    const actions = inbox.items.map((item) => item.action);
    expect(actions.some((action) => action.includes('approve'))).toBe(true);
    expect(actions.some((action) => action.includes('merge'))).toBe(true);
  });

  it('одобренный зелёный PR — одна строка merge (готов к merge)', () => {
    const inbox = buildInboxItems(
      facts({
        prs: [pr({ number: 12, branch: 'task/a1', reviewDecision: 'APPROVED' })],
        tasks: [taskFile('a1')],
      }),
    );
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]?.action).toContain('merge');
    expect(inbox.items[0]?.actionable).toBe(true);
  });

  it('нужен label: строка с вердиктом; CI красный — пассивная строка без merge', () => {
    const inbox = buildInboxItems(
      facts({
        prs: [
          pr({
            number: 13,
            branch: 'task/d14',
            reviewDecision: 'APPROVED',
            checks: 'red',
            files: ['tools/protected-paths.json'],
          }),
        ],
        labelStates: new Map([[13, label(true, false)]]),
        tasks: [taskFile('d14')],
      }),
    );
    const labelItem = inbox.items.find((item) => item.action.includes('label'));
    expect(labelItem?.actionable).toBe(true);
    expect(labelItem?.action).toContain('поставь label');
    const mergeItem = inbox.items.find((item) => item.action.includes('merge'));
    expect(mergeItem).toBeUndefined();
    expect(inbox.items.every((item) => item.actionable || item.action === 'без действия')).toBe(
      true,
    );
  });

  it('label снят новым push — отдельная строка с «заново»', () => {
    const inbox = buildInboxItems(
      facts({
        prs: [
          pr({
            number: 14,
            branch: 'task/d14',
            reviewDecision: 'APPROVED',
            labels: ['gate-change-approved'],
            files: ['tools/protected-paths.json'],
          }),
        ],
        labelStates: new Map([[14, label(true, false, true)]]),
        tasks: [taskFile('d14')],
      }),
    );
    const relabel = inbox.items.find((item) => item.action.includes('заново'));
    expect(relabel?.actionable).toBe(true);
    expect(relabel?.note).toContain('снят новым push');
  });

  it('черновик и конфликт — пассивные строки, merge не предлагается', () => {
    const inbox = buildInboxItems(
      facts({
        prs: [
          pr({ number: 15, branch: 'task/a1', reviewDecision: 'APPROVED', isDraft: true }),
          pr({
            number: 16,
            branch: 'task/a2',
            reviewDecision: 'APPROVED',
            mergeable: 'CONFLICTING',
          }),
        ],
        tasks: [taskFile('a1'), taskFile('a2')],
      }),
    );
    expect(inbox.items).toHaveLength(2);
    expect(inbox.items.every((item) => item.action === 'без действия')).toBe(true);
    expect(inbox.items.every((item) => !item.actionable)).toBe(true);
  });

  it('брошенный захват дольше порога — кандидат на release; без возраста — строка неполноты', () => {
    const tasks = [taskFile('a1'), taskFile('a2')];
    const inbox = buildInboxItems(
      facts({
        tasks,
        claimedIds: new Set(['a1', 'a2']),
        branchAgeHours: new Map([['a1', INBOX_IDLE_HOURS + 5]]),
      }),
    );
    const release = inbox.items.find((item) => item.kind === 'release-candidate');
    expect(release?.target).toBe('a1');
    expect(release?.action).toBe('pnpm backlog release a1');
    expect(release?.unblocks).toBe(1);
    expect(inbox.incomplete.some((line) => line.includes('task/a2'))).toBe(true);
  });

  it('брошенный захват закрытой задачи не предлагается к release', () => {
    const tasks = [{ ...taskFile('a1'), done: true }];
    const inbox = buildInboxItems(
      facts({
        tasks,
        claimedIds: new Set(['a1']),
        branchAgeHours: new Map([['a1', INBOX_IDLE_HOURS + 5]]),
      }),
    );
    expect(inbox.items).toEqual([]);
  });

  it('файл режима обслуживания попадает в инбокс первым', () => {
    const inbox = buildInboxItems(
      facts({
        maintenanceFileFound: true,
        prs: [pr({ number: 12, branch: 'task/a1', reviewDecision: 'APPROVED' })],
        tasks: [taskFile('a1')],
      }),
    );
    expect(inbox.items[0]?.kind).toBe('maintenance-file');
    expect(inbox.items[0]?.actionable).toBe(true);
  });
});

/** Проверяет, что ни одна строка инбокса не называет задачу. */
function notMentioning(inbox: { items: InboxItem[]; incomplete: string[] }, id: string): boolean {
  return (
    !inbox.items.some((item) => item.target === id) &&
    !inbox.incomplete.some((line) => line.includes(id))
  );
}
