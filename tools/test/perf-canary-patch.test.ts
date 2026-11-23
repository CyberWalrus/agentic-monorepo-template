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
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

// spawnSync-тяжёлый тест: дефолтные 5 c на тест падают под параллельной
// нагрузкой verify (реестр 2026-11-13), конвенция соседей — 30 c.
vi.setConfig({ testTimeout: 30_000 });

const repoDir = resolve(import.meta.dirname, '..', '..');
const TARGET = 'apps/api/src/tasks/repository.ts';
const targetPath = join(repoDir, TARGET);
const PATCH_MARKER = 'setTimeout(resolve, 200)';
const fixtures = mkdtempSync(join(tmpdir(), 'e32-fixtures-'));
afterAll(() => {
  rmSync(fixtures, { recursive: true, force: true });
});

/**
 * Точечное самозалечивание: маркер патча в дереве — остаток воркера, жёстко
 * убитого между apply и finally (SIGKILL/OOM; ре-рид в finally при этом не
 * выполнился). Залетный патч легитимной незакоммиченной правкой быть не может,
 * файл восстанавливается из git; прочие незакоммиченные изменения не трогаются.
 */
function healLeftoverPatch(): void {
  if (readFileSync(targetPath, 'utf8').includes(PATCH_MARKER)) {
    const restored = spawnSync('git', ['checkout', '--', TARGET], {
      cwd: repoDir,
      encoding: 'utf8',
    });
    if (restored.status !== 0) {
      throw new Error(`не удалось восстановить ${TARGET} из git: ${restored.stderr}`);
    }
  }
}

beforeAll(() => {
  healLeftoverPatch();
});

afterAll(() => {
  healLeftoverPatch();
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
  const path = targetPath;
  const original = readFileSync(path, 'utf8');
  expect(original).not.toContain(PATCH_MARKER);

  try {
    const applied = runPatch();
    expect(applied.status).toBe(0);
    expect(applied.stdout).toContain('задержка 200 мс вставлена в create()');

    const patched = readFileSync(path, 'utf8');
    expect(patched).not.toBe(original);
    // Задержка стоит внутри create() — после строки сигнатуры, не в конце файла.
    expect(patched).toContain(`    await new Promise((resolve) => ${PATCH_MARKER});\n`);
    expect(patched.indexOf(PATCH_MARKER)).toBeGreaterThan(patched.indexOf('async create('));
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
