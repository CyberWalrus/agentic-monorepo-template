/**
 * Канарейка якоря perf-патча (e32): apply+revert патча 200 мс прогоняется на
 * настоящем apps/api/src/tasks/repository.ts. Раньше дрейф якоря был виден
 * только в ночной джобе «perf canary (200 ms)» (e32: якорь устарел ещё в
 * C1.5 — workspaceId в сигнатуре create) — теперь apply краснеет в test:hooks
 * при каждом изменении create(). Revert — возврат исходного содержимого в
 * finally: тест не оставляет патч в рабочем дереве даже при падении ассерта.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const repoDir = resolve(import.meta.dirname, '..', '..');
const TARGET = 'apps/api/src/tasks/repository.ts';
const fixtures = mkdtempSync(join(tmpdir(), 'e32-fixtures-'));
afterAll(() => {
  rmSync(fixtures, { recursive: true, force: true });
});

interface PatchResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runPatch(...args: string[]): PatchResult {
  const result = spawnSync(
    process.execPath,
    [join(repoDir, 'tools', 'perf-canary-patch.ts'), ...args],
    { cwd: repoDir, encoding: 'utf8' },
  );
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

it('apply вставляет задержку в create() настоящего файла, revert возвращает байт в байт', () => {
  const path = join(repoDir, TARGET);
  const original = readFileSync(path, 'utf8');
  expect(original).not.toContain('setTimeout(resolve, 200)');

  try {
    const applied = runPatch();
    expect(applied.status).toBe(0);
    expect(applied.stdout).toContain('задержка 200 мс вставлена в create()');

    const patched = readFileSync(path, 'utf8');
    expect(patched).not.toBe(original);
    // Задержка стоит внутри create() — после строки сигнатуры, не в конце файла.
    expect(patched).toContain('    await new Promise((resolve) => setTimeout(resolve, 200));\n');
    expect(patched.indexOf('setTimeout(resolve, 200)')).toBeGreaterThan(
      patched.indexOf('async create('),
    );
  } finally {
    writeFileSync(path, original);
  }
  expect(readFileSync(path, 'utf8')).toBe(original);
});

it('apply на продрейфовавшем сигнатуре create() файле отказывает и называет искомую строку', () => {
  const drifted = join(fixtures, 'drifted-repository.ts');
  writeFileSync(drifted, 'class Repo {\n  async create(title: string): Promise<void> {}\n}\n');
  const result = runPatch('--file', drifted);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('якорь create() не найден');
  // Диагностика без чтения кода: в ошибке виден искомый фрагмент якоря.
  expect(result.stderr).toContain('async create(title: string, ownerId');
  expect(result.stderr).toContain('обнови ANCHOR');
});

it('apply на уже пропатченном файле отказывает — состояние нечистое', () => {
  const already = join(fixtures, 'already-patched.ts');
  writeFileSync(
    already,
    '  async create(title: string): Promise<Task> {\n    await new Promise((resolve) => setTimeout(resolve, 200));\n  }\n',
  );
  const result = runPatch('--file', already);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('патч уже стоит');
});
