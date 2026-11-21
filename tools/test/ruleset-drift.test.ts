/**
 * Канарейка a11: дрейф живого ruleset от снимка детектируется (bad-change —
 * правка снимка в фикстуре), удалённый ruleset детектируется, недоступный
 * API валит шаг громко (З11), проводка nightly и реестра на месте.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

function setup(root: string, live: unknown): void {
  mkdirSync(join(root, '.github', 'rulesets'), { recursive: true });
  writeFileSync(join(root, '.github', 'rulesets', 'main.json'), JSON.stringify(snapshot, null, 2));
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(join(root, 'api'), { recursive: true });
  writeFileSync(
    join(root, 'docs', 'template-state.md'),
    '### Реестр живых правил\n\n| id | снимок |\n| --- | --- |\n| 111 | .github/rulesets/main.json |\n',
  );
  if (live !== null) {
    writeFileSync(join(root, 'api', '111.json'), JSON.stringify(live, null, 2));
  } else {
    writeFileSync(join(root, 'api', '111.json'), '{"__httpStatus__": 404}');
  }
}

function runChecker(root: string): { status: number | null; stderr: string } {
  const run = spawnSync(
    'node',
    [
      join(repoDir, 'tools', 'check-ruleset-drift.ts'),
      '--registry',
      join(root, 'docs', 'template-state.md'),
      '--fixture-api',
      join(root, 'api'),
    ],
    { encoding: 'utf8', timeout: 60_000, cwd: root },
  );
  return { status: run.status, stderr: run.stderr ?? '' };
}

it('совпадение: живой ruleset равен снимку — зелёный', () => {
  const root = join(tmp, 'match');
  setup(root, snapshot);
  expect(runChecker(root).status).toBe(0);
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
