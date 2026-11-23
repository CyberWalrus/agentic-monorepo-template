/**
 * Тесты d12: checkHookInstall на синтетическом репо. prepare-фикстура
 * мимикрирует под lefthook — создаёт хуки в общем .git/hooks клона (без
 * зависимостей: pnpm install --frozen-lockfile в фикстуре с lockfile).
 * Саботаж — откат prepare до `[ -d .git ] &&` (исходный баг d11): в worktree
 * .git — файл, хуки не появляются, проверка красная.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { checkHookInstall } from '../check-hook-install.ts';

const repoDir = resolve(import.meta.dirname, '..', '..');
const fixtures = mkdtempSync(join(tmpdir(), 'd12-fixtures-'));
afterAll(() => {
  rmSync(fixtures, { recursive: true, force: true });
});

const PREPARE_OK =
  'mkdir -p "$(git rev-parse --git-common-dir)/hooks" && printf x > "$(git rev-parse --git-common-dir)/hooks/pre-commit" && printf x > "$(git rev-parse --git-common-dir)/hooks/pre-push"';
const PREPARE_SABOTAGE =
  '[ -d .git ] && mkdir -p "$(git rev-parse --git-common-dir)/hooks" && printf x > "$(git rev-parse --git-common-dir)/hooks/pre-commit" && printf x > "$(git rev-parse --git-common-dir)/hooks/pre-push"';

/** Снимок индекса настоящего репозитория (режим, sha, путь каждой записи) — барьер e37. */
function realRepoIndex(): string {
  return spawnSync('git', ['ls-files', '--stage'], { cwd: repoDir, encoding: 'utf8' }).stdout;
}

function buildFixture(name: string, prepare: string): string {
  // e37: процесс без cwd наследует cwd vitest — корень настоящего репозитория.
  // git без cwd фикстуры ставил в его индекс всё изменённое и untracked ветки
  // (отсюда флак branch-scope). Индекс снимается до и после сборки: на чистом
  // дереве (CI) барьер спит — там git add -A настоящего репозитория ничего не меняет.
  const indexBefore = realRepoIndex();
  const root = join(fixtures, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name, version: '0.0.0', scripts: { prepare } }, null, 2)}\n`,
  );
  const git = (args: string[]): void => {
    spawnSync('git', args, { cwd: root });
  };
  git(['init', '-b', 'main']);
  git(['add', '-A']);
  git(['-c', 'user.name=d12', '-c', 'user.email=d12@test', 'commit', '-qm', 'fixture']);
  // Lockfile нужен для pnpm install --frozen-lockfile внутри проверяемого клона.
  spawnSync('pnpm', ['install', '--lockfile-only'], { cwd: root });
  git(['add', '-A']);
  git(['-c', 'user.name=d12', '-c', 'user.email=d12@test', 'commit', '-qm', 'lockfile']);
  expect(
    realRepoIndex(),
    `индекс настоящего репозитория изменился за сборку фикстуры «${name}»: тест test:hooks зовёт git без cwd фикстуры (e37) — смотри git status`,
  ).toBe(indexBefore);
  return root;
}

it('зелёная: prepare при .git-файле ставит хуки в общий .git/hooks', async () => {
  const fixture = buildFixture('ok', PREPARE_OK);
  const row = await checkHookInstall(fixture);
  expect(row).toContain('✓');
  expect(row).toContain('установка хуков');
});

it('красная: откат prepare до [ -d .git ] не ставит хуки (AC d12)', async () => {
  const fixture = buildFixture('sabotage', PREPARE_SABOTAGE);
  const row = await checkHookInstall(fixture, true);
  // Саботаж красит контур на любом механизме: install падает от неудавшегося
  // prepare (exit 1 у `[ -d .git ] && ...` на worktree) или хуки отсутствуют.
  expect(row).toContain('✗');
});

it('проводка: раннер зовёт checkHookInstall от корня репо; canaries.yml триггерится на package.json', () => {
  const runner = readFileSync(join(repoDir, 'tools', 'run-gate-canaries.ts'), 'utf8');
  expect(runner).toContain("checkHookInstall(resolve(import.meta.dirname, '..'))");
  const canaries = readFileSync(join(repoDir, '.github', 'workflows', 'canaries.yml'), 'utf8');
  expect(canaries).toContain('package.json');
  expect(existsSync(join(repoDir, '.github', 'workflows', 'canaries.yml'))).toBe(true);
});
