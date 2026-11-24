/**
 * Канарейка и тесты гейта check-tool-class (ADR 0014, e9): логика чекера —
 * на синтетических деревьях (замыкание вне deny обязано красить, лишняя
 * deny-запись тоже, зелёный случай проходит), проводка шага verify — на
 * настоящем репозитории (B4.1: канарейка gate-canaries «выбор E2E…» — образец).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkToolClass } from '../check-tool-class.ts';

// --- Синтетическое дерево -------------------------------------------------------

let tmp = '';

const TREE: Record<string, string> = {
  'package.json': `${JSON.stringify(
    {
      name: 'fixture',
      private: true,
      type: 'module',
      scripts: { 'docs:check': 'node tools/check-docs.ts' },
    },
    null,
    2,
  )}\n`,
  'vitest.config.ts': `export default { test: { include: ['tools/test/**/*.test.ts'] } };\n`,
  'tools/verify-steps.ts': `export const fast = [
  { name: 'docs', command: 'pnpm', args: ['docs:check'] },
];
export const post = [];
export const slow = [];\n`,
  // Литерал делает tools/protected-paths.json членом замыкания — как в
  // настоящем репозитории (gate-canaries, hooks), чтобы (б) проверялся с
  // цикличностью на месте.
  'tools/check-docs.ts': `import { model } from './board-model.ts';\nexport const use = model;\nexport const config = 'tools/protected-paths.json';\n`,
  'tools/board-model.ts': `export const model = { rules: 1 };\n`,
  'tools/hooks/lib.ts': `export const hookLib = true;\n`,
  'tools/test/board.test.ts': `import { expect, it } from 'vitest';\nit('stub', () => {\n  expect(1).toBe(1);\n});\n`,
  // Файл вне замыкания: для (б) — лишняя deny-запись и blanket tools/**.
  'tools/loose.ts': `export const loose = 1;\n`,
};

const DENY = [
  'tools/verify-steps.ts',
  'tools/check-docs.ts',
  'tools/board-model.ts',
  'tools/protected-paths.json',
  'tools/hooks/**',
  'tools/test/**',
];

function writeTree(deny: string[]): void {
  mkdirSync(tmp, { recursive: true });
  for (const [relative, content] of Object.entries(TREE)) {
    const path = join(tmp, relative);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  writeProtected(tmp, deny);
}

function writeProtected(root: string, deny: string[]): void {
  writeFileSync(
    join(root, 'tools/protected-paths.json'),
    `${JSON.stringify({ deny, review: [] }, null, 2)}\n`,
  );
}

beforeEach(() => {
  tmp = join(tmpdir(), `tool-class-fixture-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  writeTree(DENY);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// --- Логика чекера на синтетическом дереве --------------------------------------

describe('check-tool-class: логика на синтетическом дереве', () => {
  it('зелёный случай: замыкание покрыто deny — проблем нет', () => {
    const report = checkToolClass({
      root: tmp,
      knownGates: ['tools/check-docs.ts', 'tools/hooks/lib.ts', 'tools/test/board.test.ts'],
    });
    expect(report.problems).toEqual([]);
    expect(report.closure).toEqual(
      expect.arrayContaining([
        'tools/check-docs.ts',
        'tools/board-model.ts',
        'tools/hooks/lib.ts',
        'tools/test/board.test.ts',
      ]),
    );
    // Файл вне замыкания не попадает в отчёт.
    expect(report.closure).not.toContain('tools/loose.ts');
  });

  it('(а) файл замыкания вне deny — красит', () => {
    writeProtected(
      tmp,
      DENY.filter((entry) => entry !== 'tools/board-model.ts'),
    );
    const report = checkToolClass({ root: tmp, knownGates: ['tools/check-docs.ts'] });
    expect(report.problems.join('\n')).toMatch(/board-model\.ts/);
  });

  it('(б) лишняя deny-запись внутри tools/ — красит', () => {
    writeProtected(tmp, [...DENY, 'tools/loose.ts']);
    const report = checkToolClass({ root: tmp, knownGates: ['tools/check-docs.ts'] });
    expect(report.problems.join('\n')).toMatch(/tools\/loose\.ts/);
  });

  it('(б) blanket tools/** красит — покрывает файл вне замыкания', () => {
    writeProtected(tmp, [...DENY, 'tools/**']);
    const report = checkToolClass({ root: tmp, knownGates: ['tools/check-docs.ts'] });
    expect(report.problems.join('\n')).toMatch(/tools\/\*\*|tools\/loose\.ts/);
  });

  it('(в) шаг verify ссылается на несуществующий скрипт — красит', () => {
    writeFileSync(join(tmp, 'package.json'), `${JSON.stringify({ scripts: {} }, null, 2)}\n`);
    const report = checkToolClass({ root: tmp, knownGates: [] });
    expect(report.problems.join('\n')).toMatch(/docs:check/);
  });

  it('(в) скрипт ссылается на несуществующий tools-файл — красит', () => {
    writeFileSync(
      join(tmp, 'package.json'),
      `${JSON.stringify({ scripts: { 'docs:check': 'node tools/missing-gate.ts' } }, null, 2)}\n`,
    );
    const report = checkToolClass({ root: tmp, knownGates: [] });
    expect(report.problems.join('\n')).toMatch(/missing-gate\.ts/);
  });

  it('fail-closed: известный гейт не найден в замыкании — расчёт красный', () => {
    const report = checkToolClass({ root: tmp, knownGates: ['tools/ghost-gate.ts'] });
    expect(report.problems.join('\n')).toMatch(/ghost-gate\.ts/);
  });

  it('(major-1) цепочка скриптов pnpm→pnpm→tools-файл попадает в замыкание', () => {
    writeFileSync(
      join(tmp, 'package.json'),
      `${JSON.stringify(
        {
          scripts: {
            'docs:check': 'pnpm inner:check',
            'inner:check': 'node tools/hidden-gate.ts',
          },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(join(tmp, 'tools/hidden-gate.ts'), `export const gate = 1;\n`);
    // Замыкание изменилось: docs:check больше не ведёт к check-docs.ts —
    // его deny-записи убраны, иначе (б) честно красит устаревший список.
    writeProtected(tmp, [
      'tools/verify-steps.ts',
      'tools/hooks/**',
      'tools/test/**',
      'tools/hidden-gate.ts',
    ]);
    const report = checkToolClass({ root: tmp, knownGates: ['tools/hidden-gate.ts'] });
    expect(report.problems).toEqual([]);
    expect(report.closure).toContain('tools/hidden-gate.ts');
  });

  it('(major-1) tools-файл из цепочки скриптов без deny — красит', () => {
    writeFileSync(
      join(tmp, 'package.json'),
      `${JSON.stringify(
        {
          scripts: {
            'docs:check': 'pnpm inner:check',
            'inner:check': 'node tools/hidden-gate.ts',
          },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(join(tmp, 'tools/hidden-gate.ts'), `export const gate = 1;\n`);
    const report = checkToolClass({ root: tmp, knownGates: ['tools/check-docs.ts'] });
    expect(report.problems.join('\n')).toMatch(/hidden-gate\.ts/);
  });

  it('(major-2) нераспознанный относительный импорт — красит', () => {
    writeFileSync(
      join(tmp, 'tools/check-docs.ts'),
      `import { helper } from './ghost-helper.ts';\nimport { model } from './board-model.ts';\nexport const use = model;\n`,
    );
    const report = checkToolClass({ root: tmp, knownGates: ['tools/check-docs.ts'] });
    expect(report.problems.join('\n')).toMatch(/нераспознанный относительный импорт.*ghost-helper/);
  });

  it('(major-2) import-текст внутри строки — не ребро и не красит', () => {
    // Пробник канарейки: import-текст в строке записываемого файла; литерал
    // protected-paths.json сохранён — json остаётся членом замыкания.
    writeFileSync(
      join(tmp, 'tools/check-docs.ts'),
      `import { model } from './board-model.ts';\nexport const config = 'tools/protected-paths.json';\nexport const probe = "import { x } from '../tasks/use-tasks';";\nexport const use = model;\n`,
    );
    const report = checkToolClass({ root: tmp, knownGates: ['tools/check-docs.ts'] });
    expect(report.problems).toEqual([]);
  });

  it('(major-3) npx в контурном файле — красит', () => {
    writeFileSync(
      join(tmp, 'lefthook.yml'),
      `pre-commit:\n  commands:\n    x:\n      run: npx evil-tool\n`,
    );
    const report = checkToolClass({ root: tmp, knownGates: ['tools/check-docs.ts'] });
    expect(report.problems.join('\n')).toMatch(/нераспознанный вызов/);
  });

  it('(major-3) pnpm run — прозрачный токен, скрипт резолвится', () => {
    writeFileSync(
      join(tmp, 'lefthook.yml'),
      `pre-commit:\n  commands:\n    x:\n      run: pnpm run docs:check\n`,
    );
    const report = checkToolClass({ root: tmp, knownGates: ['tools/check-docs.ts'] });
    expect(report.problems).toEqual([]);
  });
});

// --- Проводка шага на настоящем репозитории (B4.1) -------------------------------

const repoRoot = resolve(import.meta.dirname, '../..');

/** Объект из JSON без `as`-присваиваний (правило линтера): плоская копия. */
function asRecord(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof value === 'object' && value !== null) {
    Object.assign(out, value);
  }
  return out;
}

describe('проводка: шаг tool-class в verify', () => {
  it('verify-steps содержит шаг tool-class в fast-волне', () => {
    const source = readFileSync(join(repoRoot, 'tools/verify-steps.ts'), 'utf8');
    expect(source).toMatch(/name:\s*'tool-class'/);
    expect(source).toMatch(/'tool-class:check'/);
  });

  it('package.json ведёт шаг к гейту', () => {
    const pkg = asRecord(JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')));
    const scripts = asRecord(pkg['scripts']);
    expect(scripts['tool-class:check']).toBe('node tools/check-tool-class.ts');
    expect(existsSync(join(repoRoot, 'tools/check-tool-class.ts'))).toBe(true);
  });

  it('CI исполняет шаг в job static (needs у gate)', () => {
    const ci = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toMatch(/pnpm tool-class:check/);
  });

  it('бюджет шага в verify-budgets.json', () => {
    const budgets = asRecord(
      JSON.parse(readFileSync(join(repoRoot, 'verify-budgets.json'), 'utf8')),
    );
    const fast = asRecord(budgets['fast']);
    expect(typeof fast['tool-class']).toBe('number');
  });
});

// --- Проводка плагина agent-harness (c10.1, e49) ----------------------------------
//
// `.claude/.claude-plugin/hooks.json` — та же проводка защитных хуков, что `hooks`
// в `.claude/settings.json`, для репозиториев-потребителей: CLI резолвится
// относительно потребителя (`$CLAUDE_PROJECT_DIR/tools/hooks/`), защитные хуки
// обёрнуты `|| exit 2` (в шаблоне fail-closed дают адаптеры `.claude/hooks/`, в
// плагине адаптеров нет — З4). До e49 равенство держал только ручной
// `pnpm probe:plugin`; здесь — на каждом test:hooks, на настоящих файлах.
// Потребитель приходит к проводке через маркетплейс: `.claude-plugin/marketplace.json`
// отдаёт `source` плагина — каталог с манифестом; он сверен с защищённым манифестом.

const SETTINGS_HOOKS = '.claude/settings.json';
/** Корень плагина в шаблоне: здесь лежат манифест и hooks.json. */
const PLUGIN_ROOT = '.claude';
const PLUGIN_HOOKS = `${PLUGIN_ROOT}/.claude-plugin/hooks.json`;
const PLUGIN_MANIFEST = `${PLUGIN_ROOT}/.claude-plugin/plugin.json`;
const MARKETPLACE_MANIFEST = '.claude-plugin/marketplace.json';
const PLUGIN_PROBE = 'tools/probe-claude-plugin.ts';

/**
 * Ключи, которые сверяет тест, — корень hooks.json, группа, хук. Прочее — не «не
 * читается», а ошибка разбора (fail-closed): `if` с неисполняющимся шаблоном и
 * `async: true` оставляют тип, команду и таймаут на месте, но защитный хук не
 * запускается либо не блокирует. Новый ключ проводки сначала расширяет сверку.
 * Корень сверяется только у hooks.json: у settings.json ключи корня свои.
 */
const FILE_KEYS = ['hooks'];
const GROUP_KEYS = ['hooks', 'matcher'];
const HOOK_KEYS = ['command', 'timeout', 'type'];

/** Защитные хуки: в плагине обязаны идти с `|| exit 2`. Список сверен с пробником. */
const PROTECTIVE_PLUGIN_HOOKS = [
  'guard-bash.ts',
  'protect-paths.ts',
  'protect-result.ts',
  'stop-verify.ts',
];

interface WiringHook {
  type: string;
  command: string;
  timeout?: number;
}

interface WiringGroup {
  matcher?: string;
  hooks: WiringHook[];
}

type WiringEventMap = Record<string, WiringGroup[]>;

function wiringArray(value: unknown, source: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${source}: ожидается массив`);
  }
  return value;
}

/** Объект по ссылке: asRecord делает копию, для правки на месте не годится. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Ключ вне сверяемого набора — ошибка с адресом: поле, которым хук отключают. */
function assertComparedKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  at: string,
): void {
  const extra = Object.keys(record).filter((key) => !keys.includes(key));
  if (extra.length > 0) {
    throw new Error(`${at}: ключи вне сверки — ${extra.join(', ')}; сверяются ${keys.join(', ')}`);
  }
}

/** Сырой файл проводки из репозитория. */
function readWiringFile(path: string): Record<string, unknown> {
  return asRecord(JSON.parse(readFileSync(join(repoRoot, path), 'utf8')));
}

/**
 * События → группы → хуки файла проводки. Ключ вне сверяемого набора — ошибка
 * разбора, а не «не читается»: `if` и `async` не меняют тип, команду и таймаут.
 */
function parseHookEvents(file: Record<string, unknown>, path: string): WiringEventMap {
  if (path === PLUGIN_HOOKS) {
    assertComparedKeys(file, FILE_KEYS, path);
  }
  const events: WiringEventMap = {};
  for (const [event, rawGroups] of Object.entries(asRecord(file['hooks']))) {
    const groups: WiringGroup[] = [];
    for (const rawGroup of wiringArray(rawGroups, `${path}: ${event}`)) {
      const at = `${path}: ${event}[${groups.length}]`;
      const record = asRecord(rawGroup);
      assertComparedKeys(record, GROUP_KEYS, at);
      const group: WiringGroup = { hooks: [] };
      if (typeof record['matcher'] === 'string') {
        group.matcher = record['matcher'];
      }
      for (const rawHook of wiringArray(record['hooks'], at)) {
        const hook = asRecord(rawHook);
        if (typeof hook['command'] !== 'string') {
          throw new Error(`${at} — хук без command`);
        }
        assertComparedKeys(hook, HOOK_KEYS, `${at}.hooks[${group.hooks.length}]`);
        const wiring: WiringHook = {
          type: typeof hook['type'] === 'string' ? hook['type'] : 'command',
          command: hook['command'],
        };
        if (typeof hook['timeout'] === 'number') {
          wiring.timeout = hook['timeout'];
        }
        group.hooks.push(wiring);
      }
      groups.push(group);
    }
    events[event] = groups;
  }
  return events;
}

/** События → группы → хуки настоящего файла репозитория. */
function readHookEvents(path: string): WiringEventMap {
  return parseHookEvents(readWiringFile(path), path);
}

/** Ожидаемое зеркало settings.json: CLI потребителя и `|| exit 2` у защитных. */
function expectedPluginHooks(settings: WiringEventMap): WiringEventMap {
  return Object.fromEntries(
    Object.entries(settings).map(([event, groups]) => [
      event,
      groups.map((group) => ({
        ...group,
        hooks: group.hooks.map((hook) => {
          const command = hook.command.replace('.claude/hooks/', 'tools/hooks/');
          const protective = PROTECTIVE_PLUGIN_HOOKS.some((name) => command.includes(name));
          return protective ? { ...hook, command: `${command} || exit 2` } : { ...hook, command };
        }),
      })),
    ]),
  );
}

/** Отличия проводки плагина от ожидаемого зеркала; пусто — проводка равна. */
function wiringDrift(plugin: WiringEventMap, expected: WiringEventMap): string[] {
  const problems: string[] = [];
  const events = [...new Set([...Object.keys(expected), ...Object.keys(plugin)])].toSorted();
  for (const event of events) {
    const wanted = expected[event] ?? [];
    const actual = plugin[event] ?? [];
    if (!(event in expected)) {
      problems.push(`hooks.json плагина: лишнее событие ${event} — в settings.json его нет`);
    } else if (!(event in plugin)) {
      problems.push(`hooks.json плагина потерял событие ${event}`);
    }
    for (let index = 0; index < Math.max(wanted.length, actual.length); index++) {
      const want = wanted[index];
      const got = actual[index];
      if (want === undefined || got === undefined) {
        problems.push(
          `hooks.json плагина: ${event} — групп ${actual.length}, в settings.json ${wanted.length}`,
        );
        continue;
      }
      if ((want.matcher ?? '') !== (got.matcher ?? '')) {
        problems.push(
          `hooks.json плагина: ${event}[${index}] matcher «${got.matcher ?? ''}», в settings.json «${want.matcher ?? ''}»`,
        );
      }
      for (let hook = 0; hook < Math.max(want.hooks.length, got.hooks.length); hook++) {
        const wantHook = want.hooks[hook];
        const gotHook = got.hooks[hook];
        if (wantHook === undefined || gotHook === undefined) {
          problems.push(
            `hooks.json плагина: ${event}[${index}] — хуков ${got.hooks.length}, в settings.json ${want.hooks.length}`,
          );
        } else if (
          wantHook.command !== gotHook.command ||
          wantHook.timeout !== gotHook.timeout ||
          wantHook.type !== gotHook.type
        ) {
          problems.push(
            `hooks.json плагина: ${event}[${index}] команда/таймаут/тип расходятся с settings.json (ожидалось: ${wantHook.command})`,
          );
        }
      }
    }
  }
  return problems;
}

/** Зеркало настоящих hooks из settings.json — ожидание для hooks.json плагина. */
function expectedWiring(): WiringEventMap {
  return expectedPluginHooks(readHookEvents(SETTINGS_HOOKS));
}

/** Саботаж проводки: меняет копию настоящего hooks.json плагина на месте. */
type Sabotage = (plugin: WiringEventMap) => void;

/** Группа события; нет группы — саботаж нечего проверять, тест падает здесь. */
function groupOf(plugin: WiringEventMap, event: string): WiringGroup {
  const group = plugin[event]?.[0];
  if (group === undefined) {
    throw new Error(`в hooks.json плагина нет группы ${event}[0]`);
  }
  return group;
}

/** Хук группы; нет хука — саботаж нечего проверять, тест падает здесь. */
function hookOf(plugin: WiringEventMap, event: string, group: number, index: number): WiringHook {
  const hook = plugin[event]?.[group]?.hooks[index];
  if (hook === undefined) {
    throw new Error(`в hooks.json плагина нет хука ${event}[${group}].hooks[${index}]`);
  }
  return hook;
}

/**
 * Виды рассинхрона — по одному на каждое поле, которое сверяет wiringDrift. Если
 * саботаж ничего не меняет (нет такого события, группы, хука), тест красный.
 */
const SABOTAGES: [string, Sabotage][] = [
  [
    'потеряно событие Stop',
    (plugin) => {
      delete plugin['Stop'];
    },
  ],
  [
    'лишнее событие UserPromptSubmit',
    (plugin) => {
      plugin['UserPromptSubmit'] = [];
    },
  ],
  [
    'потеряна группа Stop[1]',
    (plugin) => {
      plugin['Stop']?.pop();
    },
  ],
  [
    'лишняя группа в Stop',
    (plugin) => {
      plugin['Stop']?.push({ hooks: [] });
    },
  ],
  [
    'другой matcher у PreToolUse[0]',
    (plugin) => {
      groupOf(plugin, 'PreToolUse').matcher = 'Bash';
    },
  ],
  [
    'потерян хук в Stop[0]',
    (plugin) => {
      groupOf(plugin, 'Stop').hooks.pop();
    },
  ],
  [
    'лишний хук в Stop[0]',
    (plugin) => {
      groupOf(plugin, 'Stop').hooks.push({ type: 'command', command: 'node evil' });
    },
  ],
  [
    'другой тип у SessionStart[0].hooks[0]',
    (plugin) => {
      hookOf(plugin, 'SessionStart', 0, 0).type = 'prompt';
    },
  ],
  [
    'защитный хук без `|| exit 2` (PreToolUse[0].hooks[0])',
    (plugin) => {
      const hook = hookOf(plugin, 'PreToolUse', 0, 0);
      hook.command = hook.command.replace(' || exit 2', '');
    },
  ],
  [
    'CLI шаблона вместо потребителя (SessionStart[0].hooks[0])',
    (plugin) => {
      const hook = hookOf(plugin, 'SessionStart', 0, 0);
      hook.command = hook.command.replace('tools/hooks/', '.claude/hooks/');
    },
  ],
  [
    'другой таймаут (Stop[1].hooks[0])',
    (plugin) => {
      hookOf(plugin, 'Stop', 1, 0).timeout = 30;
    },
  ],
];

/** Группа события в сыром файле — по ссылке; нет группы — саботаж нечего проверять. */
function rawGroupAt(
  file: Record<string, unknown>,
  event: string,
  index: number,
): Record<string, unknown> {
  const group = wiringArray(asRecord(file['hooks'])[event], `hooks.${event}`)[index];
  if (!isRecord(group)) {
    throw new Error(`в файле проводки нет группы ${event}[${index}]`);
  }
  return group;
}

/** Хук группы в сыром файле — по ссылке; нет хука — саботаж нечего проверять. */
function rawHookAt(
  file: Record<string, unknown>,
  event: string,
  group: number,
  index: number,
): Record<string, unknown> {
  const hook = wiringArray(rawGroupAt(file, event, group)['hooks'], `hooks.${event}[${group}]`)[
    index
  ];
  if (!isRecord(hook)) {
    throw new Error(`в файле проводки нет хука ${event}[${group}].hooks[${index}]`);
  }
  return hook;
}

/**
 * Ключи вне сверки — на сыром JSON, до parseHookEvents: отличия по сверяемым полям
 * тут нет (тип, команда и таймаут на месте), тест требует ошибки разбора. Оба файла:
 * settings.json — зеркало, поле только в нём тоже рассинхрон. Если саботаж ничего
 * не меняет (нет такого события, группы, хука) или ключ попал в сверку — тест красный.
 */
const UNCOMPARED_KEY_SABOTAGES: [string, string, (file: Record<string, unknown>) => void][] = [
  [
    '`if` у protect-paths — условие запуска (PreToolUse[0].hooks[0])',
    PLUGIN_HOOKS,
    (file) => {
      rawHookAt(file, 'PreToolUse', 0, 0)['if'] = 'false';
    },
  ],
  [
    '`async: true` у guard-bash — фон, не блокирует (PreToolUse[1].hooks[0])',
    PLUGIN_HOOKS,
    (file) => {
      rawHookAt(file, 'PreToolUse', 1, 0)['async'] = true;
    },
  ],
  [
    'лишний ключ у группы PreToolUse[0]',
    PLUGIN_HOOKS,
    (file) => {
      rawGroupAt(file, 'PreToolUse', 0)['statusMessage'] = 'x';
    },
  ],
  [
    'лишний ключ в корне hooks.json',
    PLUGIN_HOOKS,
    (file) => {
      file['disableAllHooks'] = true;
    },
  ],
  [
    '`async: true` у guard-bash в settings.json — зеркало не молчит',
    SETTINGS_HOOKS,
    (file) => {
      rawHookAt(file, 'PreToolUse', 1, 0)['async'] = true;
    },
  ],
];

describe('проводка плагина agent-harness: hooks.json повторяет hooks из settings.json', () => {
  it('события, matcher, хуки, команды и таймауты — 1:1 и без лишнего', () => {
    expect(wiringDrift(readHookEvents(PLUGIN_HOOKS), expectedWiring())).toEqual([]);
  });

  it('маркетплейс отдаёт потребителю каталог с этим манифестом: одна запись, source — корень плагина', () => {
    const manifest = asRecord(JSON.parse(readFileSync(join(repoRoot, PLUGIN_MANIFEST), 'utf8')));
    const marketplace = asRecord(
      JSON.parse(readFileSync(join(repoRoot, MARKETPLACE_MANIFEST), 'utf8')),
    );
    const listed = wiringArray(marketplace['plugins'], MARKETPLACE_MANIFEST)
      .map((entry) => asRecord(entry))
      .filter((entry) => entry['name'] === manifest['name']);
    // строго и строкой: вторая запись с тем же именем и объектные формы source не проходят
    expect(listed.map((entry) => entry['source'])).toEqual([`./${PLUGIN_ROOT}`]);
  });

  for (const [name, path, sabotage] of UNCOMPARED_KEY_SABOTAGES) {
    it(`саботаж замечается: ${name}`, () => {
      const file = readWiringFile(path);
      sabotage(file);
      expect(() => parseHookEvents(file, path)).toThrow(/ключи вне сверки/);
    });
  }

  it('манифест подключает именно этот файл проводки', () => {
    const manifest = asRecord(JSON.parse(readFileSync(join(repoRoot, PLUGIN_MANIFEST), 'utf8')));
    expect(manifest['hooks']).toEqual(['./.claude-plugin/hooks.json']);
  });

  it('защитные хуки — тот же список, что в пробнике pnpm probe:plugin', () => {
    const probe = readFileSync(join(repoRoot, PLUGIN_PROBE), 'utf8');
    const block = /const PROTECTIVE_HOOKS = \[([^\]]*)\]/.exec(probe)?.[1] ?? '';
    expect([...block.matchAll(/'([^']+)'/g)].map((match) => match[1])).toEqual(
      PROTECTIVE_PLUGIN_HOOKS,
    );
  });

  for (const [name, sabotage] of SABOTAGES) {
    it(`саботаж замечается: ${name}`, () => {
      const drifted = structuredClone(readHookEvents(PLUGIN_HOOKS));
      sabotage(drifted);
      expect(wiringDrift(drifted, expectedWiring()).length).toBeGreaterThan(0);
    });
  }
});
