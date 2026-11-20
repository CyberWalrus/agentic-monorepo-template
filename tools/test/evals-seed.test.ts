import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SEED_ACTIONS, replaceOnce } from '../evals/seed.ts';

/**
 * Инвариант «seed не пишет в deny-пути» (находка arch-ревью плана C9.2):
 * список файлов каждого действия зафиксирован явно — новое место записи
 * без обновления теста красит.
 */
const SEED_FILES: Record<string, string[]> = {
  'drift-css': ['apps/web/src/styles.css'],
  'slow-handler': ['apps/api/src/app.ts'],
  'failing-test': ['apps/api/src/tasks/seeded-regression.test.ts'],
};

describe('SEED_ACTIONS', () => {
  it.each(Object.entries(SEED_ACTIONS))(
    '$name declares evidence and a bounded expectRed',
    (_name, action) => {
      expect(action.evidence).not.toBe('');
      expect(action.expectRed.command).not.toBe('');
      expect(action.expectRed.timeoutMs).toBeGreaterThan(0);
    },
  );

  it('writes only declared non-deny files: seed не трогает гейты', () => {
    expect(Object.keys(SEED_ACTIONS).toSorted()).toEqual(Object.keys(SEED_FILES).toSorted());
    const deniedNames = ['perf-budgets.json', 'verify-budgets.json'];
    for (const files of Object.values(SEED_FILES)) {
      for (const file of files) {
        expect(file.startsWith('__screenshots__')).toBe(false);
        expect(deniedNames).not.toContain(file);
      }
    }
  });

  it('product actions match the shipped trap scenarios', () => {
    const scenariosDir = join(import.meta.dirname, '../evals/scenarios');
    for (const file of readdirSync(scenariosDir).filter((name) => name.startsWith('trap-'))) {
      const raw = readFileSync(join(scenariosDir, file), 'utf8');
      const seed = /seed: ([a-z-]+)/.exec(raw)?.[1] ?? '';
      expect(
        seed === '' || SEED_ACTIONS[seed] !== undefined,
        `сценарий ${file} ссылается на ${seed}`,
      ).toBe(true);
    }
  });
});

describe('replaceOnce', () => {
  it('replaces the single anchor occurrence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evals-seed-'));
    const file = join(dir, 'app.ts');
    writeFileSync(file, 'const app = new Hono();\napp.get("/", () => "ok");\n');
    await replaceOnce(
      dir,
      'app.ts',
      'const app = new Hono();\n',
      'const app = new Hono();\napp.use(m);\n',
    );
    expect(readFileSync(file, 'utf8')).toContain('app.use(m);');
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails loudly on a rotten anchor: сгнивший seed — отказ, не тихая поломка', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evals-seed-'));
    writeFileSync(join(dir, 'app.ts'), 'app.get("/", () => "ok");\n');
    await expect(replaceOnce(dir, 'app.ts', 'const app = new Hono();\n', 'x')).rejects.toThrow(
      /сгнил/,
    );
    rmSync(dir, { recursive: true, force: true });
  });
});
