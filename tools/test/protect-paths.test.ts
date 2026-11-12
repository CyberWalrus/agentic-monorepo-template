/**
 * Канарейки protect-paths (roadmap A2, пункт 6): хук блокирует запись в защищённые
 * пути инструментами Edit/Write и закрывается при сбое (exit 2, не 1).
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const projectDir = resolve(import.meta.dirname, '..', '..');
const hook = `${projectDir}/.claude/hooks/protect-paths.ts`;

function runHook(file: string): { status: number | null; stdout: string; stderr: string } {
  const input = JSON.stringify({
    session_id: 'test',
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: file, content: 'x' },
    cwd: projectDir,
  });
  const result = spawnSync(process.execPath, [hook], {
    cwd: projectDir,
    input,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
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
  `${projectDir}/.oxlintrc.json`,
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
