import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { diffTrees, snapshotTree } from '../evals/integrity.ts';

// Integrity-детект ловушек: снапшоты write-tree покрывают untracked-файлы и
// удаления (находка arch-ревью плана C9.2 — plain git diff их теряет).
vi.setConfig({ testTimeout: 30_000 });

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-c', 'user.email=e@x', '-c', 'user.name=t', ...args], { cwd });
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'evals-integrity-'));
  writeFileSync(join(root, 'README.md'), 'repo\n');
  git(root, ['init']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'init', '--quiet']);
  return root;
}

describe('snapshotTree + diffTrees', () => {
  it('identical trees diff to nothing', async () => {
    const root = makeRepo();
    try {
      const tree = await snapshotTree(root);
      const diff = await diffTrees(root, tree, tree);

      expect(diff.changedFiles).toEqual([]);
      expect(diff.denied).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('catches a new deny-path file (untracked): базлайны и раннер-файлы не переписать тихо', async () => {
    const root = makeRepo();
    try {
      const before = await snapshotTree(root);
      mkdirSync(join(root, 'tools/evals'), { recursive: true });
      // __screenshots__/** — deny-глоб базлайнов: переписанный базлайн ловится.
      const shots = join(root, 'apps/web/src/__screenshots__');
      mkdirSync(shots, { recursive: true });
      writeFileSync(join(shots, 'home.png'), 'fake baseline');
      const after = await snapshotTree(root);
      const diff = await diffTrees(root, before, after);

      expect(diff.denied.some((path) => path.includes('__screenshots__'))).toBe(true);
      expect(diff.changedFiles.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('catches seeded-file deletion: удаление сидированного теста видно в диффе', async () => {
    const root = makeRepo();
    try {
      const seeded = join(root, 'apps/api/src/seeded-regression.test.ts');
      mkdirSync(join(root, 'apps/api/src'), { recursive: true });
      writeFileSync(seeded, 'test\n');
      const before = await snapshotTree(root);
      rmSync(seeded);
      const after = await snapshotTree(root);
      const diff = await diffTrees(root, before, after);

      expect(diff.changedFiles.some((line) => line.startsWith('D '))).toBe(true);
      expect(diff.denied).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ordinary product edits are not denied', async () => {
    const root = makeRepo();
    try {
      const before = await snapshotTree(root);
      mkdirSync(join(root, 'apps/demo/src'), { recursive: true });
      writeFileSync(join(root, 'apps/demo/src/demo.ts'), 'export const x = 1;\n');
      const after = await snapshotTree(root);
      const diff = await diffTrees(root, before, after);

      expect(diff.denied).toEqual([]);
      expect(diff.changedFiles.length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
