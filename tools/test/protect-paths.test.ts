/**
 * Канарейки protect-paths (roadmap A2, пункт 6): хук блокирует запись в защищённые
 * пути инструментами Edit/Write и закрывается при сбое (exit 2, не 1).
 *
 * Изолированный CLAUDE_PROJECT_DIR (d7, 2026-11-22): bypass-механику читает хук
 * из {CLAUDE_PROJECT_DIR}/.claude/maintenance.json (b9), а deny-конфиг — из
 * модуля tools/protected-paths.json. Активное окно оператора (maintenance.json
 * в worktree задачи, ADR 0009) легитимно открывает часть deny-путей, и без
 * изоляции MUST_DENY ложнокраснел в worktree оператора — тест зависел от
 * окружения, а не от хука. Bypass-механику канареечат фикстуры
 * maintenance.test.ts; здесь проверяется защита в чистом проекте.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

const projectDir = resolve(import.meta.dirname, '..', '..');
const hook = `${projectDir}/.claude/hooks/protect-paths.ts`;
// realpathSync: targetFile резолвит пути от getcwd() (симлинки раскрыты,
// /var/folders → /private/var), projectDir должен быть тем же путём.
const isolatedDir = realpathSync(mkdtempSync(join(tmpdir(), 'protect-paths-probe-')));
mkdirSync(join(isolatedDir, '.claude'), { recursive: true });

function runHook(file: string): { status: number | null; stdout: string; stderr: string } {
  const input = JSON.stringify({
    session_id: 'test',
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: file, content: 'x' },
    cwd: isolatedDir,
  });
  const result = spawnSync(process.execPath, [hook], {
    cwd: isolatedDir,
    input,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: isolatedDir },
  });
  if (result.error) {
    throw result.error;
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const MUST_DENY: string[] = [
  'tools/protected-paths.json',
  '.claude/hooks/guard-bash.ts',
  '.claude/settings.json',
  'perf-budgets.json',
  'e2e/playwright.config.ts',
  // Абсолютный путь внутрь изолированного проекта: вне его targetFile — null
  // (чужой проект), deny не проверяется вовсе.
  `${isolatedDir}/.oxlintrc.json`,
];

for (const file of MUST_DENY) {
  it(`blocks write to: ${file}`, () => {
    const result = runHook(file);
    expect(
      result.stdout.includes('"permissionDecision":"deny"'),
      `expected deny for: ${file}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    ).toBe(true);
  });
}

const MUST_PASS: string[] = [
  'README.md',
  'CLAUDE.md',
  'packages/ui/src/index.ts',
  '/tmp/elsewhere/protected-paths.json',
];

for (const file of MUST_PASS) {
  it(`allows write to: ${file}`, () => {
    const result = runHook(file);
    expect(
      result.stdout.includes('"permissionDecision":"deny"'),
      `expected pass for: ${file}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    ).toBe(false);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
  });
}

/** Битый stdin закрывает хук (exit 2): код 1 Claude Code считает неблокирующим. */
it('fails closed on malformed stdin', () => {
  const result = spawnSync(process.execPath, [hook], {
    cwd: projectDir,
    input: 'not json',
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  });
  expect(result.status, `stderr: ${result.stderr}`).toBe(2);
  expect(result.stderr).toContain('protect-paths');
});
