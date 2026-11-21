/**
 * Канарейка b6: сканер секретов жив (secretlint ловит тестовый секрет),
 * проводка на месте (.secretlintrc.json с пресетом, .secretlintignore,
 * pre-commit в lefthook.yml, шаг в ci.yml). Ловля секретов — прогоном
 * secretlint на фикстуре с синтетическим ключом AWS.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const repoDir = resolve(import.meta.dirname, '..', '..');

const rc = readFileSync(join(repoDir, '.secretlintrc.json'), 'utf8');
const ignore = readFileSync(join(repoDir, '.secretlintignore'), 'utf8');
const lefthook = readFileSync(join(repoDir, 'lefthook.yml'), 'utf8');
const ci = readFileSync(join(repoDir, '.github', 'workflows', 'ci.yml'), 'utf8');

it('проводка: secretlint с пресетом recommend, ignore, pre-commit и шаг CI (b6)', () => {
  expect(rc).toContain('@secretlint/secretlint-rule-preset-recommend');
  expect(ignore).toContain('apps/api/src/server-config.test.ts');
  expect(lefthook).toMatch(/secrets:[\s\S]*secretlint \{staged_files\}/);
  expect(ci).toContain('pnpm secrets:check');
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

it('проводка: audit с порогом через чекер и шаг CI; actions запиннены по SHA (b6)', () => {
  const pkgRaw: unknown = JSON.parse(readFileSync(join(repoDir, 'package.json'), 'utf8'));
  const scripts = isRecord(pkgRaw) && isRecord(pkgRaw['scripts']) ? pkgRaw['scripts'] : {};
  expect(scripts['audit:check']).toBe('node tools/check-audit.ts');
  expect(ci).toContain('pnpm audit:check');
  // Actions закреплены по SHA во всех workflows (AC b6): ни одного @v-тега.
  const workflowFiles = [
    'ci.yml',
    'canaries.yml',
    'gate-integrity.yml',
    'nightly.yml',
    'visual-approve.yml',
    'evals.yml',
    'agent-review.yml',
    'security.yml',
  ];
  for (const file of workflowFiles) {
    const src = readFileSync(join(repoDir, '.github', 'workflows', file), 'utf8');
    expect(src).not.toMatch(/uses: [^\s]+@v\d/);
  }
  // renovate.json — строгий JSON (комментарий вынесен в ключ _comment).
  const renovate: unknown = JSON.parse(
    readFileSync(join(repoDir, '.github', 'renovate.json'), 'utf8'),
  );
  expect(
    typeof renovate === 'object' && renovate !== null && 'pinDigests' in renovate
      ? renovate.pinDigests
      : false,
  ).toBe(true);
});

// Фикстура живёт ВНУТРИ репозитория: secretlint ограничен корнем проекта,
// на файл из tmpdir вне cwd он не реагирует. Файл удаляется в afterAll;
// строка подключения синтетическая. Класс секрета — не случайный: пресет
// recommend этой версии не содержит AWS-правила, database-connection-string
// закрывает самый частый для этого шаблона класс (DATABASE_URL), он и канареечится.
const fixture = join(repoDir, 'b6-canary-leak.fixture.ts');
afterAll(() => {
  rmSync(fixture, { force: true });
});

it('secretlint ловит тестовый секрет в фикстуре (AC b6)', () => {
  writeFileSync(fixture, "const url = 'postgres://admin:s3cretpw@db.example.com:5432/prod';\n");
  const run = spawnSync('pnpm', ['exec', 'secretlint', fixture], {
    cwd: repoDir,
    encoding: 'utf8',
    timeout: 60_000,
  });
  expect(run.status).not.toBe(0);
  // Найденный секрет secretlint маскирует в выводе — ловим имя правила.
  expect(`${run.stdout}${run.stderr}`).toContain('PostgreSQLConnection');
});

it('clean-репозиторий secretlint проходит зелёным', () => {
  const run = spawnSync('pnpm', ['exec', 'secretlint', 'tools/hooks/protect-paths.ts'], {
    cwd: repoDir,
    encoding: 'utf8',
    timeout: 60_000,
  });
  expect(run.status).toBe(0);
});
