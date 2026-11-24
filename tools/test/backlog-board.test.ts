import { describe, expect, it } from 'vitest';

import {
  dependencyCycles,
  DOCTOR_IDLE_HOURS,
  doctorFindings,
  fileInTouches,
  invalidNeedsHuman,
  invalidTouch,
  isOperatorTask,
  needsHumanKind,
  openDependentsCount,
  parseTask,
  SHARED_PATHS,
  SOFT_OVERLAP_PATHS,
  statusOf,
  touchesOverlap,
  type BoardFacts,
  type TaskFile,
} from '../backlog-board.ts';
import { protectionOf } from '../protected-paths.ts';

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
    // ADR 0014: deny внутри tools/ — точное замыкание гейтов, blanket tools/**
    // теперь review — инструмент разработки задачу режима не открывает.
    expect(
      statusOf(
        base({ touches: ['tools/check-docs.ts'] }),
        facts([base({ touches: ['tools/check-docs.ts'] })]),
      ),
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

  it('общий путь (SHARED_PATHS) пересечением не считается и не маскирует остальное', () => {
    const registry = 'docs/escaped-defects.md';
    const fixA = withTouches('fix-a', ['apps/api/src/tasks/repository.ts', registry]);
    // Строку реестра обязан нести каждый PR-исправление (AGENTS.md) — только по
    // ней две задачи-исправления параллельны (d7tail, З9).
    expect(
      touchesOverlap(withTouches('fix-b', [registry, 'apps/web/src/lib/api.ts']), [fixA]),
    ).toBe(false);
    expect(touchesOverlap(withTouches('fix-b', [registry]), [fixA])).toBe(false);
    // По любому другому общему пути пересечение на месте.
    expect(
      touchesOverlap(withTouches('fix-b', [registry, 'apps/api/src/tasks/repository.ts']), [fixA]),
    ).toBe(true);
    // Общим считается буквальная запись: «каталог/**» пересечение создаёт.
    expect(
      touchesOverlap(withTouches('t', ['docs/**']), [
        withTouches('u', ['docs/other.md', registry]),
      ]),
    ).toBe(true);
    // Задача с одним общим путём в touches ни с кем не пересекается.
    expect(touchesOverlap(withTouches('t', ['docs/**']), [withTouches('u', [registry])])).toBe(
      false,
    );
  });

  it('мягкий путь (SOFT_OVERLAP_PATHS) пересечением не считается и не маскирует остальное (ADR 0023)', () => {
    const laws = 'docs/architecture.md';
    const lawA = withTouches('law-a', ['tools/verify.ts', laws]);
    // (а) Задачи сходятся только по мягкому пути — документ обязаны объявить обе.
    expect(touchesOverlap(withTouches('law-b', ['apps/api/src/tasks/**', laws]), [lawA])).toBe(
      false,
    );
    expect(touchesOverlap(withTouches('law-b', [laws]), [withTouches('law-c', [laws])])).toBe(
      false,
    );
    // (б) По любому другому общему пути — и внутри docs/ тоже — пересечение на месте.
    expect(touchesOverlap(withTouches('law-b', [laws, 'tools/verify.ts']), [lawA])).toBe(true);
    expect(
      touchesOverlap(withTouches('t', ['docs/other.md']), [
        withTouches('u', ['docs/other.md', 'tools/solo.ts']),
      ]),
    ).toBe(true);
    expect(touchesOverlap(withTouches('t', ['AGENTS.md']), [withTouches('u', ['AGENTS.md'])])).toBe(
      true,
    );
    // (г) Сравнение буквальное: «каталог/**», покрывающий мягкий путь, — настоящий
    // захват, он пересекается и с мягким путём, и с остальными файлами каталога.
    expect(touchesOverlap(withTouches('t', ['docs/**']), [withTouches('u', [laws])])).toBe(true);
    expect(
      touchesOverlap(withTouches('t', ['docs/**']), [withTouches('u', ['docs/other.md'])]),
    ).toBe(true);
  });
});

describe('SOFT_OVERLAP_PATHS: объявлен в touches, но не пересекается (ADR 0023)', () => {
  it('(в) fileInTouches: мягкий путь вне touches — «вне touches»; объявленный — внутри', () => {
    const laws = 'docs/architecture.md';
    // Не общий путь (SHARED_PATHS): правка законов обязана быть объявленной — гейт
    // branch-scope красит её в дереве задачи без этого пути в touches.
    expect(fileInTouches(laws, ['tools/verify.ts'])).toBe(false);
    expect(fileInTouches(laws, [])).toBe(false);
    expect(fileInTouches(laws, [laws])).toBe(true);
    expect(fileInTouches(laws, ['docs/**'])).toBe(true);
    // Общий путь по-прежнему разрешён любой задаче.
    expect(fileInTouches('docs/escaped-defects.md', ['tools/verify.ts'])).toBe(true);
  });

  it('сторожа: список непустой, пути литеральные, не общие и не под deny', () => {
    expect(SOFT_OVERLAP_PATHS.length).toBeGreaterThan(0);
    expect(SOFT_OVERLAP_PATHS.filter((path) => SHARED_PATHS.includes(path))).toEqual([]);
    for (const path of SOFT_OVERLAP_PATHS) {
      // Критерий приёма ADR 0023: конфликт в мягком пути не задевает гейт-контур.
      expect(protectionOf(path)).not.toBe('deny');
      // Буквальное сравнение: «каталог/**» в списке освобождал бы весь каталог.
      expect(path.endsWith('/**')).toBe(false);
      expect(invalidTouch(path)).toBeNull();
    }
  });
});

describe('doctorFindings', () => {
  const baseFacts = {
    openIds: new Set(['a1']),
    doneIds: new Set<string>(),
    claimedIds: new Set<string>(),
    mergedIds: new Set<string>(),
    branchAgeHours: new Map<string, number>(),
    maintenanceFiles: [],
  };

  it('чистая доска — находок нет', () => {
    expect(doctorFindings(baseFacts)).toEqual([]);
  });

  it('смержена, но открыта — блокирующее unclosed с указанием переноса', () => {
    const findings = doctorFindings({ ...baseFacts, mergedIds: new Set(['a1']) });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ id: 'a1', kind: 'unclosed', blocking: true });
    expect(findings[0]?.message).toContain('перенеси backlog/a1.md в backlog/done/');
  });

  it('закрыта, ветки нигде нет — не расхождение (GitHub помнит head смерженного PR вечно)', () => {
    expect(
      doctorFindings({
        ...baseFacts,
        openIds: new Set<string>(),
        doneIds: new Set(['a1']),
        mergedIds: new Set(['a1']),
      }),
    ).toEqual([]);
  });

  it('закрыта, ветка осталась — блокирующее leftover-branch с командой удаления', () => {
    const findings = doctorFindings({
      ...baseFacts,
      openIds: new Set<string>(),
      doneIds: new Set(['a1']),
      claimedIds: new Set(['a1']),
      mergedIds: new Set(['a1']),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ id: 'a1', kind: 'leftover-branch', blocking: true });
    expect(findings[0]?.message).toContain('git branch -d task/a1');
  });

  it('брошенный захват без коммитов дольше порога — только предупреждение', () => {
    const findings = doctorFindings({
      ...baseFacts,
      claimedIds: new Set(['a1']),
      branchAgeHours: new Map([['a1', DOCTOR_IDLE_HOURS]]),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ id: 'a1', kind: 'idle-claim', blocking: false });
    expect(findings[0]?.message).toContain('pnpm backlog release a1');
  });

  it('свежий захват и возраст ниже порога — молчание', () => {
    expect(
      doctorFindings({
        ...baseFacts,
        claimedIds: new Set(['a1']),
        branchAgeHours: new Map([['a1', DOCTOR_IDLE_HOURS - 1]]),
      }),
    ).toEqual([]);
  });

  it('возраст неизвестен (нет коммитов над базой) — предупреждения нет', () => {
    expect(doctorFindings({ ...baseFacts, claimedIds: new Set(['a1']) })).toEqual([]);
  });

  it('блокирующие идут перед предупреждениями, внутри групп — по id', () => {
    const findings = doctorFindings({
      openIds: new Set(['b2', 'a1']),
      doneIds: new Set(['z9']),
      claimedIds: new Set(['z9', 'b2', 'a1']),
      mergedIds: new Set(['a1', 'z9']),
      branchAgeHours: new Map([['b2', 100]]),
      maintenanceFiles: [],
    });
    expect(findings.map((finding) => [finding.kind, finding.id])).toEqual([
      ['unclosed', 'a1'],
      ['leftover-branch', 'z9'],
      ['idle-claim', 'b2'],
    ]);
  });
});

describe('needsHumanKind', () => {
  it('три допустимых префикса и пустое значение', () => {
    expect(needsHumanKind('')).toBe(null);
    expect(needsHumanKind('оператор: настроить запись')).toBe('operator');
    expect(needsHumanKind('отложено: появится второй тег')).toBe('deferred');
    expect(needsHumanKind('человек: поставить защищённый тег')).toBe('human');
  });

  it('произвольный текст и чужие префиксы — null (гейт красит)', () => {
    expect(needsHumanKind('выбрать вариант')).toBe(null);
    expect(needsHumanKind('Оператор: настроить')).toBe(null);
    expect(needsHumanKind('оператор : с пробелом')).toBe(null);
  });
});

describe('invalidNeedsHuman', () => {
  it('пустое и корректно префиксованное — допустимо', () => {
    expect(invalidNeedsHuman('')).toBe(null);
    expect(invalidNeedsHuman('оператор: настроить запись Claude Code')).toBe(null);
    expect(invalidNeedsHuman('отложено: появился второй тег v*')).toBe(null);
    expect(invalidNeedsHuman('человек: поставить защищённый тег v0.1.0')).toBe(null);
  });

  it('без префикса — красит с подсказкой трёх префиксов', () => {
    const problem = invalidNeedsHuman('утвердить дизайн метаданных');
    expect(problem).toContain('оператор:');
    expect(problem).toContain('человек:');
  });

  it('оператор: с действием приёмки — красит: делегирование запрещено (ADR 0009)', () => {
    for (const text of [
      'оператор: поставить label gate-change-approved',
      'оператор: сделать approve и merge PR',
      'оператор: ввести пароль в форму входа',
      'оператор: создать токен доступа',
      'оператор: завести аккаунт облачного агента',
      'оператор: смержи PR после приёмки',
      'оператор: поставить лейбл на PR',
      'оператор: ввести секрет в форму',
      'оператор: ввести код подтверждения',
      'оператор: создать платный ресурс',
    ]) {
      const problem = invalidNeedsHuman(text);
      expect(problem?.includes('не делегируется')).toBe(true);
    }
  });

  it('оператор: без действий приёмки и другие префиксы со словами из списка — допустимы', () => {
    expect(
      invalidNeedsHuman('оператор: выполнить codex login через открытую сессию браузера'),
    ).toBe(null);
    expect(invalidNeedsHuman('человек: смержи PR после приёмки')).toBe(null);
    expect(invalidNeedsHuman('отложено: merge queue появится в GitHub')).toBe(null);
  });
});

describe('isOperatorTask', () => {
  it('touches под deny защищённых путей — задача оператора', () => {
    expect(isOperatorTask(withTouches('op1', ['tools/verify.ts']))).toBe(true);
    expect(isOperatorTask(withTouches('op2', ['.github/workflows/**']))).toBe(true);
  });

  it('needs_human «оператор: …» — задача оператора без защищённых путей', () => {
    const task = parseTask(
      'op3',
      '---\ntitle: op3\ntype: change\npriority: high\ntouches: docs/**\nneeds_human: оператор: настроить запись Claude Code\n---\n',
    );
    expect(isOperatorTask(task)).toBe(true);
  });

  it('обычная задача — не операторская', () => {
    expect(isOperatorTask(withTouches('free1', ['apps/api/src/**']))).toBe(false);
    const deferred = parseTask(
      'def1',
      '---\ntitle: def1\ntype: change\npriority: low\ntouches: docs/**\nneeds_human: отложено: появится второй тег\n---\n',
    );
    expect(isOperatorTask(deferred)).toBe(false);
  });
});

describe('openDependentsCount', () => {
  it('считает только открытые прямые зависимые', () => {
    const tasks = [mk('a', []), mk('b', ['a']), mk('c', ['a']), mk('d', ['b'])];
    expect(openDependentsCount('a', tasks)).toBe(2);
    expect(openDependentsCount('b', tasks)).toBe(1);
    expect(openDependentsCount('d', tasks)).toBe(0);
  });

  it('закрытая зависимая не считается', () => {
    const closed = { ...mk('b', ['a']), done: true };
    expect(openDependentsCount('a', [mk('a', []), closed])).toBe(0);
  });
});

describe('doctorFindings: файлы режима обслуживания (ADR 0009)', () => {
  const modeFacts = {
    openIds: new Set(['a1']),
    doneIds: new Set<string>(),
    claimedIds: new Set<string>(),
    mergedIds: new Set<string>(),
    branchAgeHours: new Map<string, number>(),
    maintenanceFiles: [],
  };

  it('в основном checkout — блокирующее безусловно', () => {
    const findings = doctorFindings({
      ...modeFacts,
      maintenanceFiles: [
        {
          where: '/repo',
          main: true,
          taskId: null,
          file: 'settings-local.json',
          hasOpenPr: false,
          prUnknown: false,
          idleHours: null,
        },
      ],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ id: 'main', kind: 'maintenance-mode', blocking: true });
    expect(findings[0]?.message).toContain('основном checkout');
  });

  it('в worktree задачи с открытым PR — блокирующее: режим выключают до PR', () => {
    const findings = doctorFindings({
      ...modeFacts,
      maintenanceFiles: [
        {
          where: '/repo-task-a1',
          main: false,
          taskId: 'a1',
          file: 'settings-local.json',
          hasOpenPr: true,
          prUnknown: false,
          idleHours: 1,
        },
      ],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ id: 'a1', kind: 'maintenance-mode', blocking: true });
    expect(findings[0]?.message).toContain('открытом PR');
  });

  it('maintenance.json (режим по областям, b9) — текст называет файл и объём режима', () => {
    const findings = doctorFindings({
      ...modeFacts,
      maintenanceFiles: [
        {
          where: '/repo-task-a1',
          main: false,
          taskId: 'a1',
          file: 'maintenance.json',
          hasOpenPr: true,
          prUnknown: false,
          idleHours: 1,
        },
      ],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ id: 'a1', kind: 'maintenance-mode', blocking: true });
    expect(findings[0]?.message).toContain('.claude/maintenance.json');
    expect(findings[0]?.message).not.toContain('settings.local.json');
  });

  it('в worktree задачи с простоем дольше порога — блокирующее', () => {
    const findings = doctorFindings({
      ...modeFacts,
      maintenanceFiles: [
        {
          where: '/repo-task-a1',
          main: false,
          taskId: 'a1',
          file: 'settings-local.json',
          hasOpenPr: false,
          prUnknown: false,
          idleHours: DOCTOR_IDLE_HOURS,
        },
      ],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ id: 'a1', kind: 'maintenance-mode', blocking: true });
    expect(findings[0]?.message).toContain('последнем коммите');
  });

  it('активное окно (без PR, ветка свежая) — только предупреждение', () => {
    const findings = doctorFindings({
      ...modeFacts,
      maintenanceFiles: [
        {
          where: '/repo-task-a1',
          main: false,
          taskId: 'a1',
          file: 'settings-local.json',
          hasOpenPr: false,
          prUnknown: false,
          idleHours: 2,
        },
      ],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ id: 'a1', kind: 'maintenance-mode', blocking: false });
    expect(findings[0]?.message).toContain('активное окно');
  });

  it('в worktree без ветки задачи (released/abandoned, detached) — блокирующее', () => {
    const findings = doctorFindings({
      ...modeFacts,
      maintenanceFiles: [
        {
          where: '/repo-abandoned-x',
          main: false,
          taskId: null,
          file: 'settings-local.json',
          hasOpenPr: false,
          prUnknown: false,
          idleHours: null,
        },
      ],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ id: 'main', kind: 'maintenance-mode', blocking: true });
    expect(findings[0]?.message).toContain('без ветки задачи');
  });

  it('активное окно при недоступном gh — предупреждение с пометкой о непроверенном PR', () => {
    const findings = doctorFindings({
      ...modeFacts,
      maintenanceFiles: [
        {
          where: '/repo-task-a1',
          main: false,
          taskId: 'a1',
          file: 'settings-local.json',
          hasOpenPr: false,
          prUnknown: true,
          idleHours: 2,
        },
      ],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'maintenance-mode', blocking: false });
    expect(findings[0]?.message).toContain('PR-состояние не проверено');
  });

  it('файлов нет — находок нет', () => {
    expect(doctorFindings(modeFacts)).toEqual([]);
  });
});
