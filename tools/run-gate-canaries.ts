/**
 * Канарейки гейтов (З6, B1): применяет плохие изменения из tools/gate-canaries.ts
 * во временном git worktree и требует, чтобы соответствующий шаг verify упал.
 * Проверяется проводка гейта (шаг → команда → конфиг → exit code), а не логика
 * чекеров — та канареечна в tools/test/*. Реальная команда (`pnpm verify --json
 * --only`) исключает дрейф между канарейкой и тем, что гоняют человек, хуки и CI.
 *
 * Ограничения: канарейки проверяют ЗАКОММИЧЕННОЕ состояние (worktree от HEAD) —
 * при локальной разработке сначала commit. Запускаются при изменении tools/,
 * .claude/, конфигов гейтов (workflow canaries.yml) и в nightly; в каждом PR
 * не нужны. pnpm install в worktree делаетс один раз на весь набор; в CI store
 * прогревается установкой в корневом чекауте (setup action) до worktree.
 *
 *   pnpm canaries
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CANARIES } from './gate-canaries.ts';

const repoDir = resolve(import.meta.dirname);
const worktreeDir = mkdtempSync(join(tmpdir(), 'b1-canaries-'));

interface SpawnResult {
  status: number | null;
  output: string;
  /** Только stdout: у verify JSON идёт в stdout, pnpm-заголовки и ELIFECYCLE — в stderr. */
  stdout: string;
}

function run(command: string[], cwd: string, timeoutMs = 600_000): SpawnResult {
  const [file, ...args] = command;
  if (file === undefined) {
    return { status: -1, output: 'empty command', stdout: '' };
  }
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    cwd,
    timeout: timeoutMs,
  });
  if (result.error !== undefined) {
    return { status: -1, output: String(result.error), stdout: '' };
  }
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    stdout: result.stdout,
  };
}

function git(args: string[]): SpawnResult {
  return run(['git', ...args], repoDir);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isResultJson(value: unknown): value is ResultJson {
  if (!isRecord(value) || typeof value['ok'] !== 'boolean') {
    return false;
  }
  return Array.isArray(value['steps']);
}

interface ResultJson {
  ok: boolean;
  steps: Array<{ name: string; ok: boolean; output: string }>;
}

function verifyInWorktree(
  steps: string,
  full: boolean,
): { json: ResultJson | null; output: string } {
  const args = ['verify', '--json', '--only', steps];
  if (full) {
    args.push('--full');
  }
  const result = run(['pnpm', ...args], worktreeDir, full ? 600_000 : 300_000);
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (!isResultJson(parsed)) {
      return { json: null, output: result.output };
    }
    return { json: parsed, output: result.output };
  } catch {
    return { json: null, output: result.output };
  }
}

let failures = 0;
const rows: string[] = [];

try {
  // Worktree от HEAD: канарейки проверяют закоммиченное состояние.
  const added = git(['worktree', 'add', worktreeDir, 'HEAD']);
  if (added.status !== 0) {
    throw new Error(`git worktree add failed:\n${added.output}`);
  }
  const installed = run(['pnpm', 'install', '--frozen-lockfile'], worktreeDir, 600_000);
  if (installed.status !== 0) {
    // throw, а не process.exit: exit обходит finally и оставляет worktree
    // зарегистрированным в основном репо и каталог в tmp.
    throw new Error(`pnpm install in worktree failed:\n${installed.output.slice(-2000)}`);
  }

  // Негатив-контроль: на чистом worktree все шаги набора зелёные — иначе
  // канарейки «пролетают» на уже красной базе.
  const union = [...new Set(CANARIES.flatMap((canary) => canary.steps.split(',')))]
    .filter((step) => step !== 'build' && step !== 'bundle')
    .join(',');
  const control = verifyInWorktree(union, false);
  if (control.json === null || !control.json.ok) {
    throw new Error(
      `negative control failed — worktree is red before any bad change:\n${control.output.slice(-3000)}`,
    );
  }
  console.log(`negative control: ${union} — ok`);
  // Отдельный контроль slow-пары: budget-канарейка не должна стрелять вакуумно.
  const bundleControl = verifyInWorktree('build,bundle', true);
  if (bundleControl.json === null || !bundleControl.json.ok) {
    throw new Error(
      `negative control (build,bundle) failed — bundle gate is already red on the clean base:\n${bundleControl.output.slice(-2000)}`,
    );
  }
  console.log('negative control: build,bundle — ok');

  for (const canary of CANARIES) {
    canary.apply(worktreeDir);
    const { json } = verifyInWorktree(canary.steps, canary.full ?? false);
    const step = json?.steps.find((item) => item.name === canary.failedStep);
    // Отчёт verify парсится, целевой шаг красный и ругается ожидаемой причиной.
    const tripped =
      json !== null &&
      !json.ok &&
      step !== undefined &&
      !step.ok &&
      canary.expect.test(step.output);
    if (tripped) {
      rows.push(`✓ ${canary.name.padEnd(30)} → ${canary.failedStep} красный`);
    } else {
      failures += 1;
      rows.push(
        `✗ ${canary.name.padEnd(30)} → ${canary.failedStep} НЕ УПАЛ${json === null ? ' (verify не дал JSON)' : ''}`,
      );
      console.error(
        `canary "${canary.name}" did not trip its gate:\n${json === null ? '(no json)' : JSON.stringify(json.steps, null, 2).slice(-2000)}`,
      );
    }
    // Возврат worktree в чистое состояние (правки + untracked probe-файлы).
    // reports/ (в .gitignore) переживает revert намеренно: канарейки его не читают.
    for (const revert of [
      ['git', 'checkout', '--', '.'],
      ['git', 'clean', '-fdq'],
    ]) {
      const reverted = run(revert, worktreeDir);
      if (reverted.status !== 0) {
        throw new Error(`revert failed (${revert.join(' ')}):\n${reverted.output}`);
      }
    }
  }
} finally {
  git(['worktree', 'remove', '--force', worktreeDir]);
  git(['worktree', 'prune']);
  rmSync(worktreeDir, { recursive: true, force: true });
}

console.log(`\ngate canaries (${CANARIES.length}):`);
for (const row of rows) {
  console.log(`  ${row}`);
}
if (failures > 0) {
  console.error(
    `\n${failures} canary(ies) did not trip their gate — a gate may have been silently weakened (З6)`,
  );
  process.exit(1);
}
console.log('all gates are alive');
