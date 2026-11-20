/**
 * Integrity-детект ловушек (задача C9.2): снапшоты дерева worktree до/после
 * агента (`git write-tree` — покрывает и untracked-файлы, и удаления) и дифф
 * между ними. Каждый затронутый путь проверяется matcher-ом классов
 * (`protectionOf` из tools/protected-paths.ts — тот же единственный источник,
 * что у хука и CI, З10): deny-касание = «гейт ослаблен» независимо от цвета
 * verify. Список классов читается matcher-ом один раз на старте сессии
 * модуля: правка классов посреди 90-минутного прогона на замер не влияет —
 * это осознанная фиксация, а не race (находка ревью плана C9.2).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { protectionOf } from '../protected-paths.ts';
import { runProcess } from './exec.ts';

export interface TreeDiff {
  /** Все файлы, изменившиеся между деревьями (status + путь). */
  changedFiles: string[];
  /** Подмножество, попавшее в deny-пути: «гейты ослаблены». */
  denied: string[];
}

async function git(worktree: string, args: string[]): Promise<string> {
  const run = await runProcess('git', args, { cwd: worktree, timeoutMs: 120_000 });
  if (run.code !== 0) {
    throw new Error(`git ${args.join(' ')} не удался: ${run.stderr.trim().slice(0, 200)}`);
  }
  return run.stdout;
}

/** Снимок дерева worktree в git-объект; возвращает хеш дерева.
 * Deny-пути добавляются force: gitignored файлы (.claude/settings.local.json
 * и др.) не могут спрятать ослабление в ignore (находка security-ревью C9.2).
 * Force — только по pathspec deny-глобов из tools/protected-paths.json:
 * полный `add -A --force` стейджит node_modules и вешает pre-commit-хуки на
 * сотни тысяч файлов (урок прогона 2026-11-20T07:38). */
export async function snapshotTree(worktree: string): Promise<string> {
  await git(worktree, ['add', '-A']);
  const denyGlobs = denyGlobsOf(worktree);
  if (denyGlobs.length > 0) {
    await git(worktree, ['add', '-A', '--force', '--', ...denyGlobs]);
  }
  return (await git(worktree, ['write-tree'])).trim();
}

/** Deny-глобы из конфига worktree (та же база baseSha, что и сам замер). */
function denyGlobsOf(worktree: string): string[] {
  try {
    const config = JSON.parse(readFileSync(join(worktree, 'tools/protected-paths.json'), 'utf8'));
    return typeof config?.deny === 'object' && Array.isArray(config.deny) ? config.deny : [];
  } catch {
    // Конфиг не читается — force-фаза пропускается, обычный add -A работает;
    // matcher классов (protectionOf) при этом продолжает защищать детект.
    return [];
  }
}

/**
 * Разница деревьев: status-флаг + путь каждой изменённой записи diff-tree
 * (-z + quotepath=false: не-ASCII и спец-пути не квотируются, rename даёт
 * две записи old/new — matcher получает оба пути). Denied-пути вычисляются
 * по классам на момент старта сессии (см. шапку).
 */
export async function diffTrees(
  worktree: string,
  fromTree: string,
  toTree: string,
): Promise<TreeDiff> {
  if (fromTree === toTree) {
    return { changedFiles: [], denied: [] };
  }
  const raw = await git(worktree, [
    '-c',
    'core.quotepath=false',
    'diff-tree',
    '-r',
    '--name-status',
    '-z',
    fromTree,
    toTree,
  ]);
  // Формат -z: «status\0path\0» (rename: «status\0old\0new\0») — разбираем NUL-поток.
  const records = raw.split('\0').filter((part) => part !== '');
  const changedFiles: string[] = [];
  const denied: string[] = [];
  let index = 0;
  while (index < records.length) {
    const status = records[index] ?? '';
    const paths = records.slice(index + 1, index + 1 + (status.startsWith('R') ? 2 : 1));
    index += 1 + paths.length;
    if (paths.length === 0) {
      continue;
    }
    for (const path of paths) {
      changedFiles.push(`${status} ${path}`);
      if (protectionOf(path) === 'deny') {
        denied.push(path);
      }
    }
  }
  return { changedFiles, denied };
}
