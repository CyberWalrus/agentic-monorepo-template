/**
 * Канарейка regex-гейта check-test-integrity.ts (A3, п.2): гейт держит то,
 * чего отчёт раннера не видит — expected failure в Vitest (`fails`, в отчёте
 * статус "passed" без маркера), его цепочки с .each и подавляющие комментарии
 * мутаций (Stryker) и покрытия (v8, istanbul, c8). Пропуски (skip/fixme/todo)
 * в гейт-проектах ловит отчётный гейт test-report — здесь закреплено только,
 * что regex не дублирует формы, видимые отчёту (skipIf/runIf), и что честный
 * файл не флагуется. Исходники собираются конкатенацией: готовый литерал
 * запрещённого вызова или комментария в этом файле поймал бы сам гейт.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const repoDir = resolve(import.meta.dirname, '..', '..');
const checker = join(repoDir, 'tools', 'check-test-integrity.ts');

let tmp = '';

afterAll(() => {
  if (tmp !== '') {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// Ключевые слова собираются из кусков (см. шапку).
const FAILS = ['fa', 'ils'].join('');
const FAIL = ['fa', 'il'].join('');
const ONLY = ['on', 'ly'].join('');
const SKIP = ['sk', 'ip'].join('');
const FIXME = ['fix', 'me'].join('');
const TODO = ['to', 'do'].join('');
const STRYKER = ['Stry', 'ker'].join('');
const V8 = ['v', '8'].join('');
const ISTANBUL = ['istan', 'bul'].join('');
const C8 = ['c', '8'].join('');

/** source, ожидаемая подстрока находки (или null — находки быть не должно). */
const MODIFIER_CASES: Array<[string, string | null]> = [
  [`it.${FAILS}('hides a bug', () => { expect(1).toBe(2); });`, `.${FAILS}(`],
  [`test.${FAIL}('playwright expected failure', () => {});`, `.${FAIL}(`],
  [`it.${FAILS}.each([1])('each expected failure', () => {});`, `.${FAILS}.each(`],
  [`describe.${ONLY}('focused suite', () => {});`, `.${ONLY}(`],
  [`it.${SKIP}('skipped', () => {});`, `.${SKIP}(`],
  [`test.${FIXME}('fixme', () => {});`, `.${FIXME}(`],
  [`it.${TODO}('todo', () => {});`, `.${TODO}(`],
  // skipIf/runIf исполняются и видны отчёту: regex их не флагует (З3 — не дублировать).
  [`it.${SKIP}If(true)('conditional', () => { expect(1).toBe(1); });`, null],
  [`it.runIf(false)('rare', () => { expect(1).toBe(1); });`, null],
];

function runChecker(cwd: string): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [checker], { encoding: 'utf8', cwd, timeout: 30_000 });
  if (result.error) {
    throw result.error;
  }
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

it('модификаторы, невидимые отчёту, флагуются с файлом и строкой; skipIf/runIf — нет', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a3-integrity-'));
  tmp = dir;
  const lines = ["import { describe, it, test } from 'vitest';", ''].concat(
    MODIFIER_CASES.map(([source]) => source),
  );
  // Гейт сканирует layout репозитория (apps/**, tools/**/*.test.ts) от cwd —
  // фикстура раскладывается в тот же макет.
  mkdirSync(join(dir, 'apps'), { recursive: true });
  writeFileSync(join(dir, 'apps', 'sample.test.ts'), lines.join('\n'));
  const result = runChecker(dir);
  expect(result.status).toBe(1);
  for (const [, expected] of MODIFIER_CASES) {
    if (expected === null) {
      continue;
    }
    expect(result.output).toContain(expected);
    expect(result.output).toContain('sample.test.ts');
  }
  // Строка с skipIf/runIf числится в файле — но находки для неё нет.
  const flaggedLines = result.output
    .split('\n')
    .filter((line) => line.includes('sample.test.ts:'))
    .map((line) => Number(line.split(':')[1]));
  const skipIfLine = lines.findIndex((line) => line.includes('If(true)')) + 1;
  expect(flaggedLines).not.toContain(skipIfLine);
});

it('подавляющие комментарии мутаций и покрытия флагуются с подсказкой', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a3-integrity-'));
  tmp = dir;
  const sources = [
    `// ${STRYKER} disable all`,
    `// ${STRYKER} disable next-line all`,
    `/* ${V8} ignore start */`,
    `/* ${V8} ignore next */`,
    `// ${ISTANBUL} ignore next`,
    `/* ${C8} ignore start */`,
    'it("honest", () => { expect(1).toBe(1); });',
  ];
  mkdirSync(join(dir, 'apps'), { recursive: true });
  writeFileSync(join(dir, 'apps', 'suppress.test.ts'), sources.join('\n'));
  const result = runChecker(dir);
  expect(result.status).toBe(1);
  expect(result.output).toContain(`${STRYKER} disable`);
  expect(result.output).toContain(`${V8} ignore`);
  expect(result.output).toContain(`${ISTANBUL} ignore`);
  expect(result.output).toContain(`${C8} ignore`);
  expect(result.output).toMatch(/suppress\.test\.ts:\d/);
  expect(result.output).toMatch(/move the exclusion to the config/i);
});

it('честный файл проходит зелёным', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a3-integrity-'));
  tmp = dir;
  const sources = [
    "import { describe, expect, it } from 'vitest';",
    `describe('honest suite', () => {`,
    `  it('passes', () => { expect(1).toBe(1); });`,
    `  it('mentions modifiers in a string without calling them', () => {`,
    `    expect(['.${SKIP} ', '.${ONLY} '].join('')).toHaveLength(10);`,
    `  });`,
    `});`,
  ];
  mkdirSync(join(dir, 'apps'), { recursive: true });
  writeFileSync(join(dir, 'apps', 'honest.test.ts'), sources.join('\n'));
  const result = runChecker(dir);
  expect(result.status).toBe(0);
  expect(result.output).toMatch(/ok/);
});
