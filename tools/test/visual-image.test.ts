/**
 * Гейт A8 (чекер check-visual-image.ts): ловит расхождение версии Docker-образа
 * Playwright в ci.yml с каталогом @playwright/test, разъехавшуюся пару каталога
 * ('playwright' vs '@playwright/test'), диапазон вместо точной версии и fail-
 * closed на кривой/отсутствующий вход (ноль или несколько образов в ci.yml).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const repoDir = resolve(import.meta.dirname, '..', '..');
const checker = join(repoDir, 'tools', 'check-visual-image.ts');

const tmp = mkdtempSync(join(tmpdir(), 'a8-visual-image-'));
let fileCounter = 0;

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function fixture(name: string, content: string): string {
  const path = join(tmp, `${fileCounter++}-${name}`);
  writeFileSync(path, content);
  return path;
}

function runChecker(
  workspacePath: string,
  ciPath: string,
): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [checker, workspacePath, ciPath], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** Форма как в реальном pnpm-workspace.yaml: '@playwright/test' в кавычках, playwright без. */
function catalog(testVersion: string, runnerVersion = testVersion): string {
  return `packages:\n  - apps/*\n  - packages/*\n\ncatalog:\n  '@playwright/test': ${testVersion}\n  playwright: ${runnerVersion}\n`;
}

function ci(image: string | null, extraImage: string | null = null): string {
  const lines = ['jobs:', '  visual:', '    runs-on: ubuntu-latest', '    container:'];
  if (image !== null) {
    lines.push(`      image: ${image}`, '      options: --ipc=host');
  }
  // Дубликат — реалистичный след неудачного merge: вторая строка image в том же блоке.
  if (extraImage !== null) {
    lines.push(`      image: ${extraImage}`);
  }
  lines.push('    steps:', '      - run: bash tools/visual-inner.sh');
  return `${lines.join('\n')}\n`;
}

it('совпадающие версии — зелёный', () => {
  const result = runChecker(
    fixture('ok.yaml', catalog('1.64.1')),
    fixture('ok.yml', ci('mcr.microsoft.com/playwright:v1.64.1-noble')),
  );
  expect(result.status).toBe(0);
  expect(result.output).toContain('matches catalog');
});

it('образ отстал от каталога — красный с обеими версиями', () => {
  const result = runChecker(
    fixture('drift.yaml', catalog('1.65.0')),
    fixture('drift.yml', ci('mcr.microsoft.com/playwright:v1.64.1-noble')),
  );
  expect(result.status).toBe(1);
  expect(result.output).toContain('v1.64.1-noble');
  expect(result.output).toContain('1.65.0');
});

it("парная запись каталога 'playwright' разъехалась — красный", () => {
  const result = runChecker(
    fixture('pair.yaml', catalog('1.64.1', '1.65.0')),
    fixture('pair.yml', ci('mcr.microsoft.com/playwright:v1.64.1-noble')),
  );
  expect(result.status).toBe(1);
  expect(result.output).toContain("differs from '@playwright/test'");
});

it('диапазон вместо точной версии в каталоге — красный', () => {
  const result = runChecker(
    fixture('range.yaml', catalog('^1.64.1')),
    fixture('range.yml', ci('mcr.microsoft.com/playwright:v1.64.1-noble')),
  );
  expect(result.status).toBe(1);
  expect(result.output).toContain('exact');
});

it('нет записи каталога — красный', () => {
  const result = runChecker(
    fixture('missing.yaml', 'packages:\n  - apps/*\n'),
    fixture('missing.yml', ci('mcr.microsoft.com/playwright:v1.64.1-noble')),
  );
  expect(result.status).toBe(1);
  expect(result.output).toContain("no exact '@playwright/test'");
});

it('образ из ci.yml пропал — красный', () => {
  const result = runChecker(
    fixture('noimg.yaml', catalog('1.64.1')),
    fixture('noimg.yml', ci(null)),
  );
  expect(result.status).toBe(1);
  expect(result.output).toContain('no "image: mcr.microsoft.com/playwright');
});

it('несколько образов — красный (неясен источник правды)', () => {
  const result = runChecker(
    fixture('two.yaml', catalog('1.64.1')),
    fixture(
      'two.yml',
      ci(
        'mcr.microsoft.com/playwright:v1.64.1-noble',
        'mcr.microsoft.com/playwright:v1.65.0-noble',
      ),
    ),
  );
  expect(result.status).toBe(1);
  expect(result.output).toContain('2 Playwright images');
});

it('нечитаемый вход — красный (fail-closed)', () => {
  const result = runChecker(join(tmp, 'absent-catalog.yaml'), join(tmp, 'absent-ci.yml'));
  expect(result.status).toBe(1);
  expect(result.output).toContain('unreadable');
});
