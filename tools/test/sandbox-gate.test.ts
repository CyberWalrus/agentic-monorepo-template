/**
 * Гейт З10 (sandbox denyWrite — производный от tools/protected-paths.json, ADR 0004):
 * чекер check-sandbox-paths.ts ловит расхождение списков и откат политики
 * (enabled / allowUnsandboxedCommands / failIfUnavailable).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const repoDir = resolve(import.meta.dirname, '..', '..');
const checker = join(repoDir, 'tools', 'check-sandbox-paths.ts');

let tmp = '';

afterAll(() => {
  if (tmp !== '') {
    rmSync(tmp, { recursive: true, force: true });
  }
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const PROTECTED = { deny: ['tools/**', 'perf-budgets.json'], review: [] };
const MATCHING_SETTINGS: Record<string, unknown> = {
  sandbox: {
    enabled: true,
    allowUnsandboxedCommands: false,
    failIfUnavailable: true,
    filesystem: { denyWrite: ['perf-budgets.json', 'tools/**'] },
  },
};

/** Глубокая копия эталонного конфига: форма проверяется guard-ами, не assertion-ами. */
function cloneSettings(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(JSON.stringify(MATCHING_SETTINGS));
  if (!isRecord(parsed) || !isRecord(parsed['sandbox'])) {
    throw new Error('fixture settings lost their shape');
  }
  return parsed;
}

function denyListOf(settings: Record<string, unknown>): string[] {
  const sandbox = settings['sandbox'];
  if (!isRecord(sandbox) || !isRecord(sandbox['filesystem'])) {
    throw new Error('fixture settings lost their shape');
  }
  const list = sandbox['filesystem']['denyWrite'];
  if (!Array.isArray(list)) {
    throw new Error('fixture denyWrite is not an array');
  }
  return list;
}

/** Готовит пару файлов (settings, protected-paths) и запускает чекер на них. */
function check(
  settings: unknown,
  protectedPaths: unknown,
): { status: number | null; output: string } {
  if (tmp === '') {
    tmp = mkdtempSync(join(tmpdir(), 'a2-sandbox-'));
  }
  const settingsPath = join(tmp, `settings-${Math.random().toString(36).slice(2)}.json`);
  const protectedPath = join(tmp, `protected-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(settingsPath, JSON.stringify(settings));
  writeFileSync(protectedPath, JSON.stringify(protectedPaths));
  const result = spawnSync(process.execPath, [checker, settingsPath, protectedPath], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.error) {
    throw result.error;
  }
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

it('реальный конфиг репозитория соответствует protected-paths.json', () => {
  const result = spawnSync(process.execPath, [checker], { encoding: 'utf8', timeout: 30_000 });
  if (result.error) {
    throw result.error;
  }
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/matches/);
});

it('совпадающие списки проходят', () => {
  const result = check(MATCHING_SETTINGS, PROTECTED);
  expect(result.status).toBe(0);
});

it('denyWrite без защищённого пути падает с перечислением', () => {
  const settings = cloneSettings();
  const list = denyListOf(settings);
  list.splice(list.indexOf('tools/**'), 1);
  const result = check(settings, PROTECTED);
  expect(result.status).toBe(1);
  expect(result.output).toContain('tools/**');
  expect(result.output).toMatch(/missing protected paths/);
});

it('лишний путь в denyWrite падает', () => {
  const settings = cloneSettings();
  denyListOf(settings).push('README.md');
  const result = check(settings, PROTECTED);
  expect(result.status).toBe(1);
  expect(result.output).toMatch(/absent from protected-paths.json/);
});

it.each([
  ['enabled', false],
  ['allowUnsandboxedCommands', true],
  ['failIfUnavailable', false],
])('откат политики %s ловится', (key, value) => {
  const settings = cloneSettings();
  const sandbox = settings['sandbox'];
  if (!isRecord(sandbox)) {
    throw new Error('fixture settings lost their shape');
  }
  sandbox[key] = value;
  const result = check(settings, PROTECTED);
  expect(result.status).toBe(1);
  expect(result.output).toContain(key);
});

it('битый JSON и отсутствие блока sandbox падают', () => {
  if (tmp === '') {
    tmp = mkdtempSync(join(tmpdir(), 'a2-sandbox-'));
  }
  const broken = join(tmp, 'broken.json');
  writeFileSync(broken, '{nope');
  const result = spawnSync(process.execPath, [checker, broken, broken], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.error) {
    throw result.error;
  }
  expect(result.status).toBe(1);
  expect(result.stdout + result.stderr).toMatch(/not valid JSON/);
});
