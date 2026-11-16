/**
 * Регрессионные тесты доверенного чекера одобрения (ADR 0002, d8.2): перебор кандидатов
 * CODEOWNERS в порядке приоритета GitHub (.github/ → корень → docs/, берётся первый
 * существующий), fail-closed без файла и без строки `*`, разбор нескольких строк `*`.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const repoDir = resolve(import.meta.dirname, '..', '..');
const checker = join(repoDir, 'tools', 'check-gate-approval.ts');

const PUSH_AT = '2026-11-16T00:00:00Z';
const LABELED_AT = '2026-11-17T00:00:00Z';
const CANDIDATES = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Прогон чекера на фикстурах: cwd = каталог фикстур, как workflow из корня репозитория. */
function run(
  checkers: string[],
  owners: string[],
  actor: string,
): { status: number | null; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gate-approval-'));
  dirs.push(dir);
  writeFileSync(
    join(dir, 'pr.json'),
    JSON.stringify({ labels: [{ name: 'gate-change-approved' }] }),
  );
  writeFileSync(
    join(dir, 'events.json'),
    JSON.stringify([
      {
        event: 'labeled',
        actor: { login: actor },
        created_at: LABELED_AT,
        label: { name: 'gate-change-approved' },
      },
    ]),
  );
  writeFileSync(
    join(dir, 'head-commit.json'),
    JSON.stringify({ commit: { committer: { date: PUSH_AT } } }),
  );
  for (const [index, path] of checkers.entries()) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), owners[index] ?? '');
  }
  const result = spawnSync(
    process.execPath,
    [checker, 'pr.json', 'events.json', ...CANDIDATES, 'head-commit.json'],
    { cwd: dir, encoding: 'utf8', timeout: 30_000 },
  );
  if (result.error) {
    throw result.error;
  }
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

it('берёт первый существующий кандидат: только docs/ — контекст шаблона', () => {
  const result = run(['docs/CODEOWNERS'], ['* @template-owner\n'], 'template-owner');
  expect(result.status).toBe(0);
  expect(result.output).toMatch(/approval: APPROVED/);
});

it('рендер копии: только .github/ — контекст проекта', () => {
  const result = run(['.github/CODEOWNERS'], ['* @project-owner\n'], 'project-owner');
  expect(result.status).toBe(0);
  expect(result.output).toMatch(/approval: APPROVED/);
});

it('ни один кандидат не существует — NOT approved (fail-closed)', () => {
  const result = run([], [], 'anyone');
  expect(result.status).toBe(0);
  expect(result.output).toMatch(/approval: NOT approved/);
  expect(result.output).toMatch(/нет файла со строкой/);
});

it('файл без строки `*` — NOT approved', () => {
  const result = run(['docs/CODEOWNERS'], ['/tools/ @someone\n'], 'someone');
  expect(result.status).toBe(0);
  expect(result.output).toMatch(/approval: NOT approved/);
});

it('несколько строк `*` складываются, @ срезается', () => {
  const result = run(['CODEOWNERS'], ['* @first-owner\n* @second-owner\n'], 'second-owner');
  expect(result.status).toBe(0);
  expect(result.output).toMatch(/approval: APPROVED/);
});

it('label поставил не владелец — NOT approved', () => {
  const result = run(['docs/CODEOWNERS'], ['* @template-owner\n'], 'not-an-owner');
  expect(result.status).toBe(0);
  expect(result.output).toMatch(/approval: NOT approved/);
  expect(result.output).toMatch(/не входит в глобальных владельцев/);
});
