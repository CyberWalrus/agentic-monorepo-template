/**
 * Чистое рабочее дерево для прогона evals (ADR 0016): detached worktree от
 * HEAD текущего checkout, ноль перенесённого состояния — два запуска подряд
 * стартуют из одинаковой базы (AC воспроизводимости). Удаление — при любом
 * исходе прогона, кроме --keep (З9: temp-артефакты не копятся).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runProcess } from './exec.ts';

export interface EvalWorktree {
  path: string;
  baseSha: string;
}

async function git(root: string, args: string[]): Promise<string> {
  const run = await runProcess('git', args, { cwd: root, timeoutMs: 120_000 });
  if (run.code !== 0) {
    throw new Error(`git ${args.join(' ')} завершился с кодом ${run.code}: ${run.stderr.trim()}`);
  }
  return run.stdout;
}

export async function headSha(root: string): Promise<string> {
  return (await git(root, ['rev-parse', 'HEAD'])).trim();
}

export async function createEvalWorktree(root: string, baseSha?: string): Promise<EvalWorktree> {
  const sha = baseSha ?? (await headSha(root));
  // Префикс из имени репозитория: пары одновременных прогонов не пересекаются,
  // а путь попадает в отчёт (порты dev-серверов e2e выводятся из пути worktree).
  const prefix = `evals-${root.split('/').pop() ?? 'repo'}-`;
  const path = mkdtempSync(join(tmpdir(), prefix));
  await git(root, ['worktree', 'add', '--detach', path, sha]);
  return { path, baseSha: sha };
}

export async function removeEvalWorktree(root: string, path: string): Promise<void> {
  const run = await runProcess('git', ['worktree', 'remove', '--force', path], {
    cwd: root,
    timeoutMs: 120_000,
  });
  if (run.code !== 0) {
    // Уже удалённого (ручная чистка, падение между шагами) не считаем ошибкой:
    // задача шага — «дерева нет», а не «удалить именно сейчас».
    rmSync(path, { recursive: true, force: true });
  }
}
