import { describe, expect, it } from 'vitest';

import {
  dependencyCycles,
  invalidTouch,
  parseTask,
  statusOf,
  touchesOverlap,
  type BoardFacts,
  type TaskFile,
} from '../backlog-board.ts';

const raw = `---
title: Пробная задача
type: change
priority: high
depends_on: a1, a2
touches: apps/api/src/tasks/**, packages/contracts/src/tasks.ts
needs_human: решить про демо
---
# Пробная задача

## Журнал
`;

function facts(tasks: TaskFile[], claimed: string[] = []): BoardFacts {
  return { tasks, claimedIds: new Set(claimed) };
}

const mk = (id: string, dependsOn: string[]): TaskFile =>
  parseTask(
    id,
    `---\ntitle: ${id}\ntype: change\npriority: low\ndepends_on: ${dependsOn.join(', ')}\n---\n`,
  );

const withTouches = (id: string, touches: string[]): TaskFile =>
  parseTask(
    id,
    `---\ntitle: ${id}\ntype: change\npriority: low\ntouches: ${touches.join(', ')}\n---\n`,
  );

/** Свободная задача t1 без зависимостей и without needs_human, с переопределениями. */
const base = (overrides: Partial<TaskFile>): TaskFile => ({
  ...parseTask('t1', raw),
  dependsOn: [],
  needsHuman: '',
  ...overrides,
});

describe('parseTask', () => {
  it('читает поля, списки в строку и признак done', () => {
    const task = parseTask('d3', raw, false);
    expect(task).toMatchObject({
      id: 'd3',
      title: 'Пробная задача',
      type: 'change',
      priority: 'high',
      dependsOn: ['a1', 'a2'],
      touches: ['apps/api/src/tasks/**', 'packages/contracts/src/tasks.ts'],
      needsHuman: 'решить про демо',
      done: false,
    });
    expect(parseTask('d3', raw, true).done).toBe(true);
  });

  it('дочерние id и пустые списки допустимы', () => {
    const child = parseTask('d12.1', '---\ntitle: x\ntype: research\npriority: low\n---\n');
    expect(child.dependsOn).toEqual([]);
    expect(child.touches).toEqual([]);
    expect(child.needsHuman).toBe('');
  });

  it('падает на отсутствии front matter, bad type, bad priority и дубле поля', () => {
    expect(() => parseTask('x', 'нет front matter')).toThrow(/front matter/);
    expect(() => parseTask('x', '---\ntitle: x\ntype: unknown\npriority: low\n---\n')).toThrow(
      /type/,
    );
    expect(() => parseTask('x', '---\ntitle: x\ntype: change\npriority: urgent\n---\n')).toThrow(
      /priority/,
    );
    expect(() =>
      parseTask('x', '---\ntitle: x\ntitle: y\ntype: change\npriority: low\n---\n'),
    ).toThrow(/дважды/);
    expect(() => parseTask('Bad id', raw)).toThrow(/id/);
  });
});

describe('invalidTouch', () => {
  it('принимает литеральный путь и каталог/**', () => {
    expect(invalidTouch('apps/api/src/tasks/repository.ts')).toBeNull();
    expect(invalidTouch('apps/api/src/tasks/**')).toBeNull();
  });

  it('отклоняет произвольные glob-ы, абсолютные пути и ..', () => {
    expect(invalidTouch('apps/*/src')).toMatch(/литерального|каталог/);
    expect(invalidTouch('/abs/path')).toMatch(/относительным/);
    expect(invalidTouch('../up')).toMatch(/\.\./);
    expect(invalidTouch('a/**/b')).toMatch(/литерального|каталог/);
  });
});

describe('dependencyCycles', () => {
  it('находит цикл и перечисляет участников', () => {
    const tasks = [mk('a', ['b']), mk('b', ['c']), mk('c', ['a']), mk('d', ['a'])];
    expect(dependencyCycles(tasks).toSorted()).toEqual(['a', 'b', 'c']);
  });

  it('не видит цикла в ациклических зависимостях и на dangling-ссылках', () => {
    expect(dependencyCycles([mk('a', ['b']), mk('b', [])])).toEqual([]);
    // Ссылка на несуществующую задачу — не цикл; её ловит check-docs.
    expect(dependencyCycles([mk('a', ['ghost'])])).toEqual([]);
  });
});

describe('statusOf', () => {
  it('done важнее всего', () => {
    expect(statusOf(base({ done: true }), facts([base({ done: true })], ['t1']))).toBe('done');
  });

  it('захваченная веткой задача — в работе, даже если dependencies закрыты', () => {
    const task = base({});
    expect(statusOf(task, facts([task], ['t1']))).toBe('in-progress');
  });

  it('незакрытая зависимость или needs_human блокируют', () => {
    const dep = base({ id: 'dep', done: false });
    const task = base({ dependsOn: ['dep'] });
    expect(statusOf(task, facts([dep, task]))).toBe('blocked');
    const doneDep = { ...dep, done: true };
    expect(statusOf(task, facts([doneDep, task]))).toBe('free');
    expect(statusOf(base({ needsHuman: 'решить' }), facts([base({ needsHuman: 'решить' })]))).toBe(
      'blocked',
    );
  });

  it('touches под deny требует режим обслуживания, review — нет', () => {
    expect(
      statusOf(base({ touches: ['tools/evil.ts'] }), facts([base({ touches: ['tools/evil.ts'] })])),
    ).toBe('maintenance');
    expect(
      statusOf(base({ touches: ['lefthook.yml'] }), facts([base({ touches: ['lefthook.yml'] })])),
    ).toBe('maintenance');
    expect(
      statusOf(
        base({ touches: ['docs/adr/0100-x.md'] }),
        facts([base({ touches: ['docs/adr/0100-x.md'] })]),
      ),
    ).toBe('free');
  });
});

describe('touchesOverlap', () => {
  it('литеральный путь внутри каталога/** пересекается', () => {
    const inProgress = [withTouches('w', ['apps/api/src/tasks/**'])];
    expect(touchesOverlap(withTouches('t', ['apps/api/src/tasks/repository.ts']), inProgress)).toBe(
      true,
    );
    expect(touchesOverlap(withTouches('t', ['apps/web/src/lib/api.ts']), inProgress)).toBe(false);
  });

  it('два каталога/** пересекаются при вложенности', () => {
    const inProgress = [withTouches('w', ['apps/api/**'])];
    expect(touchesOverlap(withTouches('t', ['apps/api/src/**']), inProgress)).toBe(true);
    expect(touchesOverlap(withTouches('t', ['packages/ui/**']), inProgress)).toBe(false);
  });

  it('литеральный файл совпадает с литеральным файлом, литеральный каталог не glob', () => {
    const inProgress = [withTouches('w', ['AGENTS.md'])];
    expect(touchesOverlap(withTouches('t', ['AGENTS.md']), inProgress)).toBe(true);
    expect(touchesOverlap(withTouches('t', ['AGENTS.md.bak']), inProgress)).toBe(false);
  });
});
