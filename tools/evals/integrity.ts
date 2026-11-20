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

/** Снимок всего дерева worktree (включая untracked) в git-объект; возвращает хеш дерева. */
export async function snapshotTree(worktree: string): Promise<string> {
  await git(worktree, ['add', '-A']);
  return (await git(worktree, ['write-tree'])).trim();
}

/**
 * Разница деревьев: status-флаг + путь каждой изменённой строки diff-tree.
 * Denied-пути вычисляются по классам на момент старта сессии (см. шапку).
 */
export async function diffTrees(
  worktree: string,
  fromTree: string,
  toTree: string,
): Promise<TreeDiff> {
  if (fromTree === toTree) {
    return { changedFiles: [], denied: [] };
  }
  const raw = await git(worktree, ['diff-tree', '-r', '--name-status', fromTree, toTree]);
  const changedFiles: string[] = [];
  const denied: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    const path = line.split('\t').pop() ?? '';
    if (path === '') {
      continue;
    }
    changedFiles.push(`${line.split('\t')[0]} ${path}`);
    if (protectionOf(path) === 'deny') {
      denied.push(path);
    }
  }
  return { changedFiles, denied };
}
