/**
 * Прямой вызов CLI хука наследует fail-closed (З4, C10.1): необработанный сбой
 * модуля (битый вход, битый конфиг) — exit 2 (блокирующий), а не 1 (агент
 * считает его неблокирующим). До C10.1 обёртка жила только в адаптерах
 * .claude/hooks — CLI, вызванный напрямую, падал открытым; failClosedExit в
 * tools/hooks/lib.ts закрывает это. Пин — на прямом spawn (не через адаптер).
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoDir = resolve(import.meta.dirname, '..', '..');
const cli = resolve(repoDir, 'tools', 'hooks', 'protect-paths.ts');

describe('прямой вызов CLI хука', () => {
  it('битый stdin — exit 2 с объяснением (fail-closed, З4)', () => {
    const result = spawnSync('node', [cli], {
      encoding: 'utf8',
      cwd: repoDir,
      input: 'not json',
      env: { ...process.env, CLAUDE_PROJECT_DIR: repoDir },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('hook failed closed');
    expect(result.stderr).toContain('not valid JSON');
  }, 30_000);
});
