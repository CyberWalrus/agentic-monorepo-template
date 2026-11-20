/**
 * Канарейка C10.3: ZCode-плагин держит тот же набор CLI и matcher'ов, что и
 * хуки Claude Code в .claude/settings.json (расхождение = два разных контура
 * L0), и его run-cli.sh реально останавливает запись в защищённый путь тем же
 * CLI (smoke прогоном) и fail-closed в отрыве от репозитория (кэш-копия).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const repoDir = resolve(import.meta.dirname, '..', '..');
const pluginDir = join(repoDir, 'tools', 'zcode-plugin');

interface HookEntry {
  event: string;
  matcher: string;
  cli: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRecordArray(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value) && value.every((item) => typeof item === 'object' && item !== null);
}

function cliEntries(config: unknown, pluginMode: boolean): HookEntry[] {
  const entries: HookEntry[] = [];
  if (!isRecord(config) || !isRecord(config['hooks'])) return entries;
  for (const [event, groups] of Object.entries(config['hooks'])) {
    if (!isRecordArray(groups)) continue;
    for (const group of groups) {
      const matcher = typeof group['matcher'] === 'string' ? group['matcher'] : '(все)';
      if (!isRecordArray(group['hooks'])) continue;
      for (const hook of group['hooks']) {
        const command = typeof hook['command'] === 'string' ? hook['command'] : '';
        const cli = pluginMode
          ? (command.match(/run-cli\.sh" ([a-z-]+\.ts)/)?.[1] ?? '')
          : (command.match(/\.claude\/hooks\/([a-z-]+\.ts)/)?.[1] ?? '');
        entries.push({ event, matcher, cli });
      }
    }
  }
  return entries.toSorted((a, b) =>
    `${a.event}|${a.matcher}|${a.cli}`.localeCompare(`${b.event}|${b.matcher}|${b.cli}`),
  );
}

const ccConfig: unknown = JSON.parse(
  readFileSync(join(repoDir, '.claude', 'settings.json'), 'utf8'),
);
const pluginConfig: unknown = JSON.parse(
  readFileSync(join(pluginDir, 'hooks', 'hooks.json'), 'utf8'),
);

it('плагин держит те же event/matcher/CLI, что и хуки Claude Code', () => {
  expect(cliEntries(pluginConfig, true)).toEqual(cliEntries(ccConfig, false));
});

function runCli(
  cli: string,
  payload: string,
  pluginRoot: string,
): { code: number; stderr: string } {
  const run = spawnSync('bash', [join(pluginDir, 'hooks', 'run-cli.sh'), cli], {
    input: payload,
    encoding: 'utf8',
    timeout: 30_000,
    // Явное окружение плагина: CLAUDE_PROJECT_DIR — корень репозитория,
    // где живёт CLI (в сессии-хосте он указывает на её workspace, что при
    // прогоне из worktree задачи дало бы расхождение cwd и projectDir).
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PROJECT_DIR: repoDir },
    cwd: repoDir,
  });
  return { code: run.status ?? -1, stderr: run.stderr ?? '' };
}

it('smoke: protect-paths через обёртку блокирует запись в защищённый путь (JSON-deny → exit 2)', () => {
  const run = runCli(
    'protect-paths.ts',
    JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'perf-budgets.json' } }),
    pluginDir,
  );
  expect(run.code).toBe(2);
  expect(run.stderr).toContain('protected quality gate');
});

it('smoke: CLI защищённого гейта сигналит deny по протоколу Claude Code (JSON, exit 0)', () => {
  const run = spawnSync('node', [join(repoDir, 'tools', 'hooks', 'protect-paths.ts')], {
    input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'perf-budgets.json' } }),
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: repoDir },
    cwd: repoDir,
  });
  expect(run.status).toBe(0);
  expect(run.stdout).toContain('"permissionDecision":"deny"');
});

it('smoke: protect-paths пропускает обычный файл (exit 0)', () => {
  const run = runCli(
    'protect-paths.ts',
    JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: 'apps/api/src/server-config.ts' },
    }),
    pluginDir,
  );
  expect(run.code).toBe(0);
});

let tmp = '';
afterAll(() => {
  if (tmp !== '') rmSync(tmp, { recursive: true, force: true });
});

it('fail-closed: плагин в отрыве от репозитория блокирует (exit 2), не исчезает', () => {
  tmp = mkdtempSync(join(tmpdir(), 'c103-detached-'));
  mkdirSync(join(tmp, 'hooks'), { recursive: true });
  writeFileSync(join(tmp, 'hooks', 'hooks.json'), '{}');
  const run = runCli('protect-paths.ts', '{}', tmp);
  expect(run.code).toBe(2);
  expect(run.stderr).toContain('detached from the repository');
});
