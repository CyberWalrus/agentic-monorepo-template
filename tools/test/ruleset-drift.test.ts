/**
 * Канарейка a11 + e35: дрейф живого ruleset от снимка детектируется (bad-change —
 * правка снимка в фикстуре; рост и убыль массивов по живому), удалённый ruleset
 * детектируется, недоступный API валит шаг громко (З11) с кодом и телом — и это
 * не «дрейф»; ключ, скрытый от токена без write-доступа (bypass_actors), —
 * граница проверки, а не дрейф; проводка nightly и реестра на месте; права
 * джобы — ровно contents: read и issues: write, области administration нет ни
 * в одном permissions: воркфлоу (её нет у GITHUB_TOKEN).
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const repoDir = resolve(import.meta.dirname, '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'a11-drift-'));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const snapshot = {
  name: 'main',
  target: 'branch',
  enforcement: 'active',
  conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
  bypass_actors: [],
  rules: [{ type: 'deletion' }],
};

/** Ответ без ключа, который GitHub отдаёт только при write-доступе (e35). */
function withoutKey(record: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
}

function writeFixture(root: string, value: unknown): void {
  mkdirSync(join(root, 'api'), { recursive: true });
  writeFileSync(join(root, 'api', '111.json'), JSON.stringify(value, null, 2));
}

function setup(root: string, live: unknown): void {
  mkdirSync(join(root, '.github', 'rulesets'), { recursive: true });
  writeFileSync(join(root, '.github', 'rulesets', 'main.json'), JSON.stringify(snapshot, null, 2));
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(
    join(root, 'docs', 'template-state.md'),
    '### Реестр живых правил\n\n| id | снимок |\n| --- | --- |\n| 111 | .github/rulesets/main.json |\n',
  );
  writeFixture(root, live === null ? { __httpStatus__: 404 } : live);
}

/**
 * Подставной gh в формате настоящего при HTTP-ошибке: exit 1, тело ответа в
 * stdout, «gh: <message> (HTTP <код>)» в stderr — чекер классифицирует по коду.
 */
function fakeGh(stdout: string, stderr: string): string {
  return [
    '#!/bin/sh',
    `printf '%s' '${stdout}'`,
    `printf '%s\\n' '${stderr}' >&2`,
    'exit 1',
    '',
  ].join('\n');
}

interface CheckerRun {
  status: number | null;
  stdout: string;
  stderr: string;
  output: string;
}

/** Без gh — фикстуры (--fixture-api); с gh — настоящий режим, но gh подставной. */
function runChecker(root: string, gh?: string): CheckerRun {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GITHUB_STEP_SUMMARY: join(root, 'step-summary.md'),
  };
  if (gh !== undefined) {
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'gh'), gh, { mode: 0o755 });
    env['PATH'] = `${bin}${delimiter}${env['PATH'] ?? ''}`;
  }
  const args = [
    join(repoDir, 'tools', 'check-ruleset-drift.ts'),
    '--registry',
    join(root, 'docs', 'template-state.md'),
  ];
  if (gh === undefined) args.push('--fixture-api', join(root, 'api'));
  const run = spawnSync('node', args, { encoding: 'utf8', timeout: 60_000, cwd: root, env });
  const stdout = run.stdout ?? '';
  const stderr = run.stderr ?? '';
  return { status: run.status, stdout, stderr, output: `${stdout}\n${stderr}` };
}

it('совпадение: живой ruleset равен снимку — зелёный', () => {
  const root = join(tmp, 'match');
  setup(root, snapshot);
  const run = runChecker(root);
  expect(run.status).toBe(0);
  expect(run.output).not.toContain('ГРАНИЦА ПРОВЕРКИ');
});

it('дрейф: правка снимка (bad-change) — красный с причиной', () => {
  const root = join(tmp, 'drift');
  setup(root, { ...snapshot, enforcement: 'disabled' });
  const run = runChecker(root);
  expect(run.status).toBe(1);
  expect(run.stderr).toContain('дрейф');
  expect(run.stderr).toContain('enforcement');
});

it('удалённый живой ruleset при живом снимке — красный', () => {
  const root = join(tmp, 'deleted');
  setup(root, null);
  const run = runChecker(root);
  expect(run.status).toBe(1);
  expect(run.stderr).toContain('удалён');
});

it('fail-loud (З11): нет данных API — exit 2, а не «дрейфа нет»', () => {
  const root = join(tmp, 'loud');
  setup(root, snapshot);
  rmSync(join(root, 'api', '111.json'));
  const run = runChecker(root);
  expect(run.status).toBe(2);
  expect(run.stderr).toContain('fail-loud');
});

it('граница проверки (e35): bypass_actors скрыт от токена без write-доступа — зелёный, не дрейф', () => {
  const root = join(tmp, 'hidden');
  setup(root, withoutKey(snapshot, 'bypass_actors'));
  const run = runChecker(root);
  expect(run.status).toBe(0);
  expect(run.stdout).toContain(
    'ключи живого ответа (5): name, target, enforcement, conditions, rules',
  );
  expect(run.output).toContain('ГРАНИЦА ПРОВЕРКИ');
  expect(run.output).toContain('bypass_actors не возвращён API токену джобы (в снимке [])');
  expect(run.output).toContain('node tools/check-ruleset-drift.ts');
  expect(run.stdout).toContain('::warning title=ruleset-drift — граница проверки::');
  expect(run.output).not.toContain('дрейф:');
  // Сводка шага: непроверенное видно в сводке прогона, а не только в логе.
  expect(readFileSync(join(root, 'step-summary.md'), 'utf8')).toContain('bypass_actors');
});

it('граница проверки не прикрывает дрейф: при скрытом bypass_actors правка enforcement — красный', () => {
  const root = join(tmp, 'hidden-drift');
  setup(root, withoutKey({ ...snapshot, enforcement: 'disabled' }, 'bypass_actors'));
  const run = runChecker(root);
  expect(run.status).toBe(1);
  expect(run.stderr).toContain('enforcement: живое "disabled", снимок "active"');
  expect(run.output).not.toContain('ГРАНИЦА ПРОВЕРКИ');
});

it('граница проверки узкая: иной отсутствующий ключ (conditions) — дрейф, а не «скрыт»', () => {
  const root = join(tmp, 'lost-key');
  setup(root, withoutKey(snapshot, 'conditions'));
  const run = runChecker(root);
  expect(run.status).toBe(1);
  expect(run.stderr).toContain('conditions: живое <нет>');
  expect(run.stderr).toContain('вне TOKEN_HIDDEN_KEYS это дрейф');
  expect(run.output).not.toContain('ГРАНИЦА ПРОВЕРКИ');
});

it('рост обходчиков в живом bypass_actors — красный (сверка массивов по живому, e35)', () => {
  const root = join(tmp, 'actor-added');
  setup(root, {
    ...snapshot,
    bypass_actors: [{ actor_id: 5, actor_type: 'Integration', bypass_mode: 'always' }],
  });
  const run = runChecker(root);
  expect(run.status).toBe(1);
  expect(run.stderr).toContain(
    'bypass_actors[0]: живое {"actor_id":5,"actor_type":"Integration","bypass_mode":"always"}, снимок <нет>',
  );
  expect(run.output).not.toContain('ГРАНИЦА ПРОВЕРКИ');
});

it('рост массива по живому: добавленное правило сверх снимка — красный', () => {
  const root = join(tmp, 'rule-added');
  setup(root, { ...snapshot, rules: [...snapshot.rules, { type: 'non_fast_forward' }] });
  const run = runChecker(root);
  expect(run.status).toBe(1);
  expect(run.stderr).toContain('rules[1]: живое {"type":"non_fast_forward"}, снимок <нет>');
});

it('убыль массива по живому: удалённое правило — красный', () => {
  const root = join(tmp, 'rule-removed');
  setup(root, { ...snapshot, rules: [] });
  const run = runChecker(root);
  expect(run.status).toBe(1);
  expect(run.stderr).toContain('rules[0]: живое <нет>, снимок {"type":"deletion"}');
});

it('рост вложенного массива (conditions.ref_name.include) — красный', () => {
  const root = join(tmp, 'nested-growth');
  setup(root, {
    ...snapshot,
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH', 'refs/heads/feat/*'], exclude: [] } },
  });
  const run = runChecker(root);
  expect(run.status).toBe(1);
  expect(run.stderr).toContain(
    'conditions.ref_name.include[1]: живое "refs/heads/feat/*", снимок <нет>',
  );
});

it('отказ API 403 — exit 2 с кодом и телом; это не дрейф', () => {
  const root = join(tmp, 'forbidden');
  setup(root, null);
  writeFixture(root, {
    __httpStatus__: 403,
    __body__: { message: 'Resource not accessible by integration' },
  });
  const run = runChecker(root);
  expect(run.status).toBe(2);
  expect(run.stderr).toContain('отказ API');
  expect(run.stderr).toContain('у токена нет прав');
  expect(run.stderr).toContain('код 403');
  expect(run.stderr).toContain('Resource not accessible by integration');
  expect(run.stderr).not.toContain('дрейф:');
});

it('отказ API через настоящий формат gh: «gh: … (HTTP 403)» — exit 2 с кодом 403, не дрейф', () => {
  const root = join(tmp, 'gh-403');
  setup(root, snapshot);
  const run = runChecker(
    root,
    fakeGh(
      '{"message":"Resource not accessible by integration","status":"403"}',
      'gh: Resource not accessible by integration (HTTP 403)',
    ),
  );
  expect(run.status).toBe(2);
  expect(run.stderr).toContain('код 403');
  expect(run.stderr).toContain('Resource not accessible by integration');
  expect(run.stderr).not.toContain('дрейф:');
});

it('сеть: gh api не дошёл до API — exit 2 с причиной, не дрейф', () => {
  const root = join(tmp, 'network');
  setup(root, snapshot);
  const run = runChecker(
    root,
    fakeGh('', 'gh: error connecting to api.github.com: dial tcp: no such host'),
  );
  expect(run.status).toBe(2);
  expect(run.stderr).toContain('не дошёл до API');
  expect(run.stderr).toContain('error connecting to api.github.com');
  expect(run.stderr).not.toContain('дрейф:');
});

it('удалённый ruleset через настоящий формат gh: HTTP 404 — красный «удалён», не «не ответил»', () => {
  const root = join(tmp, 'gh-404');
  setup(root, snapshot);
  const run = runChecker(
    root,
    fakeGh(
      '{"message":"Not Found","documentation_url":"https://docs.github.com/rest/repos/rules","status":"404"}',
      'gh: Not Found (HTTP 404)',
    ),
  );
  expect(run.status).toBe(1);
  expect(run.stderr).toContain('удалён (API ответил 404)');
});

it('ключи живого ответа печатаются — по логу видно, что токен джобы реально видит (e35)', () => {
  const root = join(tmp, 'keys');
  setup(root, { ...snapshot, id: 111, node_id: 'node', bypass_actors: [] });
  const run = runChecker(root);
  expect(run.status).toBe(0);
  expect(run.stdout).toContain(
    'ключи живого ответа (8): name, target, enforcement, conditions, bypass_actors, rules, id, node_id',
  );
});

it('копия без снимка — exit 0: дрейф ruleset неприменим вне шаблона', () => {
  // docs/template-state.md в копию не едет (copier _exclude, ADR 0008):
  // чекер обязан зелёно молчать, а не красить nightly копии.
  const root = join(tmp, 'copy');
  mkdirSync(join(root, 'api'), { recursive: true });
  writeFileSync(join(root, 'api', '111.json'), JSON.stringify(snapshot, null, 2));
  const run = runChecker(root);
  expect(run.status).toBe(0);
});

it('проводка: nightly-джоб и реестр в template-state.md (a11)', () => {
  const nightly = readFileSync(join(repoDir, '.github', 'workflows', 'nightly.yml'), 'utf8');
  expect(nightly).toContain('ruleset drift');
  expect(nightly).toContain('check-ruleset-drift.ts');
  // Снимок живого ruleset — dev-документ шаблона: в копию не едет. В копии
  // проверяем только проводку nightly; реестр существует лишь в шаблоне.
  const statePath = join(repoDir, 'docs', 'template-state.md');
  if (!existsSync(statePath)) {
    return;
  }
  const state = readFileSync(statePath, 'utf8');
  expect(state).toContain('Реестр живых правил');
  expect(state).toMatch(/27137353[^\n]*rulesets\/main\.json/);
  expect(existsSync(join(repoDir, '.github', 'rulesets', 'main.json'))).toBe(true);
});

/** Пары «область: доступ» каждого блока `permissions:` воркфлоу; комментарии пропущены. */
function permissionEntries(workflow: string): [scope: string, access: string][] {
  const lines = workflow.split('\n');
  const entries: [string, string][] = [];
  for (const [index, line] of lines.entries()) {
    if (!/^\s*permissions:\s*$/.test(line)) {
      continue;
    }
    const indent = line.length - line.trimStart().length;
    for (const next of lines.slice(index + 1)) {
      const text = next.trim();
      if (text === '' || text.startsWith('#')) {
        continue;
      }
      if (next.length - next.trimStart().length <= indent) {
        break;
      }
      const colon = text.indexOf(':');
      if (colon > 0) {
        // `issues: write # причина` — доступ без комментария конца строки.
        const access = text
          .slice(colon + 1)
          .replace(/\s*#.*$/, '')
          .trim();
        entries.push([text.slice(0, colon), access]);
      }
    }
  }
  return entries;
}

it('проводка: права джобы ruleset-drift — ровно contents: read и issues: write (e35)', () => {
  // Области administration у GITHUB_TOKEN нет (workflow-syntax, permissions):
  // право не выдать, список обходчиков ночью не проверяется — граница проверки.
  const nightly = readFileSync(join(repoDir, '.github', 'workflows', 'nightly.yml'), 'utf8');
  // Конец среза — следующая джоба nightly. Ключ обязан существовать: иначе indexOf
  // даёт −1 и срез уходит до конца файла (e39: так сломался маркер
  // '  workflow-health:' после выноса джобы health в workflow-health.yml).
  const job = nightly.slice(
    nightly.indexOf('  ruleset-drift:'),
    nightly.indexOf('  test-count-ratchet:'),
  );
  expect(Object.fromEntries(permissionEntries(job))).toEqual({ contents: 'read', issues: 'write' });
});

it('проводка: области administration нет ни в одном permissions: воркфлоу (e35)', () => {
  // Сторож по всем воркфлоу: та же ошибка не должна вернуться в другой джобе.
  const dir = join(repoDir, '.github', 'workflows');
  const workflows = readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .toSorted();
  expect(workflows.length).toBeGreaterThan(0);
  const entries = workflows.flatMap((name) =>
    permissionEntries(readFileSync(join(dir, name), 'utf8')).map(([scope]) => `${name}: ${scope}`),
  );
  // Блоки permissions: разобраны — сторож не пуст.
  expect(entries.length).toBeGreaterThan(0);
  expect(entries.filter((entry) => entry.endsWith(': administration'))).toEqual([]);
});
