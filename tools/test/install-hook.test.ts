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
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { checkHookInstall } from '../check-hook-install.ts';

// Каждый тест — цепочка из 9 spawnSync (git и pnpm install в клоне): проверка
// таймаута ждёт возврата из spawn. Под нагрузкой CI main (run 45153926919) тест
// занял 6,2–6,7 с — дефолтных 5 с не хватало (e41, рецидив строки реестра
// 2026-11-13). 30 с — ≥ ×3 к p95 замеров, журнал: backlog/done/e41.md.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const repoDir = resolve(import.meta.dirname, '..', '..');
const fixtures = mkdtempSync(join(tmpdir(), 'd12-fixtures-'));
afterAll(() => {
  rmSync(fixtures, { recursive: true, force: true });
});

const PREPARE_OK =
  'mkdir -p "$(git rev-parse --git-common-dir)/hooks" && printf x > "$(git rev-parse --git-common-dir)/hooks/pre-commit" && printf x > "$(git rev-parse --git-common-dir)/hooks/pre-push"';
const PREPARE_SABOTAGE =
  '[ -d .git ] && mkdir -p "$(git rev-parse --git-common-dir)/hooks" && printf x > "$(git rev-parse --git-common-dir)/hooks/pre-commit" && printf x > "$(git rev-parse --git-common-dir)/hooks/pre-push"';

/**
 * Lockfile общий на обе фикстуры (e41): зависимостей нет, и имя пакета в
 * pnpm-lock.yaml не попадает — содержимое от фикстуры не зависит. Один
 * `pnpm install --lockfile-only` на файл вместо двух: каждый тест теряет
 * тяжёлый spawn. Генерируется в beforeAll под hookTimeout, а не при импорте —
 * зависший pnpm обязан получить таймаут, а не повесить запуск.
 */
let lockfile: string;

beforeAll(() => {
  const source = join(fixtures, 'lockfile');
  mkdirSync(source);
  writeFileSync(
    join(source, 'package.json'),
    `${JSON.stringify({ name: 'd12-lockfile', version: '0.0.0' }, null, 2)}\n`,
  );
  const lock = spawnSync('pnpm', ['install', '--lockfile-only'], {
    cwd: source,
    encoding: 'utf8',
  });
  if (lock.status !== 0) {
    // Ошибка, а не expect: вне теста expect запрещён (vitest/no-standalone-expect).
    throw new Error(
      `pnpm install --lockfile-only для фикстур d12 не удался (exit ${lock.status}):\n${lock.stderr}`,
    );
  }
  lockfile = readFileSync(join(source, 'pnpm-lock.yaml'), 'utf8');
});

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
  // Lockfile нужен для pnpm install --frozen-lockfile внутри проверляемого клона.
  writeFileSync(join(root, 'pnpm-lock.yaml'), lockfile);
  git(['add', '-A']);
  git(['-c', 'user.name=d12', '-c', 'user.email=d12@test', 'commit', '-qm', 'fixture']);
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
