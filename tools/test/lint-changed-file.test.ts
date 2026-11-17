/**
 * Прямой тест CLI lint-changed-file (C10.1): точка входа агента (адаптер)
 * спавнится с JSON на stdin, без запуска агента. Чистый файл — exit 0, файл
 * с нарушением правила — exit 2 и подсказка агенту (PostToolUse возвращает
 * ошибку; правила типов ловит шаг typecheck, не oxlint).
 * CLAUDE_PROJECT_DIR — реальный репозиторий (oxlint/oxfmt из node_modules/.bin
 * и type-aware контекст). Пробник — dotfile в tools/hooks/: oxlint линтует его
 * по явному пути, а knip (шаг verify идёт ПАРАЛЛЕЛЬНО test:hooks) dotfiles не
 * видит — иначе «Unused files» гонка между шагами. Удаление в afterAll (пишет
 * сам тестовый процесс — агентские хуки на него не действуют, в CI хуков нет).
 */
import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const repoDir = resolve(import.meta.dirname, '..', '..');
const adapter = join(repoDir, '.claude', 'hooks', 'lint-changed-file.ts');
const probe = join(repoDir, 'tools', 'hooks', '.lint-probe.fixture.ts');

const runHook = (file: string): { status: number | null; stderr: string } => {
  const result = spawnSync('node', [adapter], {
    encoding: 'utf8',
    cwd: repoDir,
    input: JSON.stringify({
      session_id: 'test',
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: `tools/hooks/${file}` },
    }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: repoDir },
  });
  return { status: result.status, stderr: result.stderr ?? '' };
};

afterAll(() => {
  rmSync(probe, { force: true });
});

describe('lint-changed-file CLI', () => {
  it('чистый файл — exit 0', () => {
    writeFileSync(probe, "export const probeGood = 'clean';\n");
    const result = runHook('.lint-probe.fixture.ts');
    expect(`${result.status}|${result.stderr.slice(0, 200)}`).toBe('0|');
  }, 30_000);

  it('нарушение правила линтера (no-explicit-any) — exit 2 и подсказка агенту', () => {
    // Правило без type-информации (oxlint не проверяет корректность типов —
    // это tsc в шаге typecheck): no-explicit-any включён для всех путей.
    writeFileSync(probe, 'export const probeEvil = (x: any): any => x;\n');
    const result = runHook('.lint-probe.fixture.ts');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Oxlint found problems');
    expect(result.stderr).toContain('.lint-probe.fixture.ts');
  }, 30_000);

  it('несуществующий файл — exit 0 (нечего линтовать)', () => {
    const result = runHook('.lint-probe.missing.ts');
    expect(result.status).toBe(0);
  }, 30_000);
});
