/**
 * d12: проверка контура установки хуков (см. комментарий функции).
 * Отдельный модуль: импорт раннера канареек в тесте исполнял ВСЕ канарейки.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

interface SpawnResult {
  status: number | null;
  output: string;
  stdout: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * d12: `pnpm install` при `.git`-ФАЙЛЕ (worktree) ставит хуки lefthook в
 * общий `.git/hooks`. Проверка: полный клон источника → worktree → install
 * ТОЛЬКО в worktree → в `.git/hooks` клона появились `pre-commit`/`pre-push`.
 * `sabotagePrepare` подменяет prepare на откат `[ -d .git ] &&` (исходный
 * баг d11) — проверка обязана стать красной.
 */
function runInDir(): (cmd: string, args: string[], cwd: string) => SpawnResult {
  return (cmd, args, cwd) => {
    const result = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 600_000 });
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
      stdout: result.stdout,
    };
  };
}

export async function checkHookInstall(
  sourceDir: string,
  sabotagePrepare = false,
): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), 'd12-clone-'));
  const cloneDir = join(tmp, 'clone');
  const worktree = join(cloneDir, 'wt');
  const runIn = runInDir();
  try {
    const cloned = runIn('git', ['clone', '--no-hardlinks', '--quiet', sourceDir, cloneDir], tmp);
    if (cloned.status !== 0) {
      return `✗ установка хуков (d12): клон не удался — ${cloned.output.slice(-200)}`;
    }
    const wtAdded = runIn('git', ['worktree', 'add', worktree, 'HEAD'], cloneDir);
    if (wtAdded.status !== 0) {
      return `✗ установка хуков (d12): worktree не создался — ${wtAdded.output.slice(-200)}`;
    }
    if (sabotagePrepare) {
      const pkgPath = join(worktree, 'package.json');
      const pkg: unknown = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (isRecord(pkg) && isRecord(pkg['scripts'])) {
        pkg['scripts']['prepare'] = '[ -d .git ] && lefthook install';
        writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
      }
    }
    const installed = runIn('pnpm', ['install', '--frozen-lockfile'], worktree);
    if (installed.status !== 0) {
      return `✗ установка хуков (d12): install не удался — ${installed.output.slice(-200)}`;
    }
    const hooks = ['pre-commit', 'pre-push'].map((hook) => join(cloneDir, '.git', 'hooks', hook));
    const missing = hooks.filter((hook) => !existsSync(hook));
    if (missing.length > 0) {
      return `✗ установка хуков (d12): в общем .git/hooks нет ${missing.map((hook) => basename(hook)).join(', ')} — prepare при .git-файле не ставит хуки`;
    }
    return '✓ установка хуков из worktree (d12)';
  } finally {
    runIn('git', ['worktree', 'remove', '--force', worktree], cloneDir);
    rmSync(tmp, { recursive: true, force: true });
  }
}
