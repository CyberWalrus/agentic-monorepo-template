/**
 * Канарейка C9.3: журнал отказов пишется и читается, приватность держится
 * (в записи только дата/гейт/тип — ни команды, ни кода), тренд считает
 * по гейтам за период, проводка хуков на месте.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { appendDenial, journalPath, readDenials } from '../hooks/lib.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const repoDir = resolve(import.meta.dirname, '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'c93-journal-'));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

it('appendDenial/readDenials: запись пишется в JSONL и читается', () => {
  const path = join(tmp, 'denials.jsonl');
  process.env['DENIAL_JOURNAL_PATH'] = path;
  appendDenial('protect-paths', 'protected-path-write');
  appendDenial('guard-bash', 'force-push');
  const records = readDenials(path);
  expect(records.map((r) => `${r.gate}:${r.reason}`)).toEqual([
    'protect-paths:protected-path-write',
    'guard-bash:force-push',
  ]);
  expect(records[0]?.date).not.toBe('');
});

it('приватность: в файле журнала только ключи date/gate/reason', () => {
  const path = join(tmp, 'denials.jsonl');
  const lines = readFileSync(path, 'utf8').trim().split('\n');
  for (const line of lines) {
    const parsed: unknown = JSON.parse(line);
    const keys = isRecord(parsed) ? Object.keys(parsed).toSorted() : [];
    expect(keys).toEqual(['date', 'gate', 'reason']);
  }
});

it('тренд: счётчик по гейтам за период (CLI с DENIAL_JOURNAL_PATH)', () => {
  const path = join(tmp, 'trend.jsonl');
  const fresh = JSON.stringify({
    date: new Date().toISOString(),
    gate: 'protect-paths',
    reason: 'protected-path-write',
  });
  const stale = JSON.stringify({
    date: '2020-01-01T00:00:00Z',
    gate: 'guard-bash',
    reason: 'force-push',
  });
  writeFileSync(path, [fresh, fresh, stale, ''].join('\n'));
  const run = spawnSync('node', [join(repoDir, 'tools', 'denial-trend.ts'), '--days', '30'], {
    cwd: repoDir,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, DENIAL_JOURNAL_PATH: path },
  });
  // Свежие записи считают, старые (2020) — нет; локальный журнал машины
  // в прогоне теста не существует и даёт 0.
  expect(run.stdout).toContain('protect-paths: 2');
  expect(run.stdout).not.toContain('guard-bash:');
});

it('проводка: хуки пишут отказы, gate-integrity отдаёт артефакт (C9.3)', () => {
  const lib = readFileSync(join(repoDir, 'tools', 'hooks', 'lib.ts'), 'utf8');
  expect(lib).toMatch(/appendDenial/);
  for (const hook of ['protect-paths.ts', 'guard-bash.ts', 'protect-result.ts']) {
    const src = readFileSync(join(repoDir, 'tools', 'hooks', hook), 'utf8');
    expect(src.includes('appendDenial') || /deny\(/.test(src)).toBe(true);
  }
  const gi = readFileSync(join(repoDir, '.github', 'workflows', 'gate-integrity.yml'), 'utf8');
  expect(gi).toContain('Denial journal (C9.3)');
  expect(gi).toContain('gate-denials');
});

it('журнал по умолчанию — вне репозитория (домашний каталог)', () => {
  process.env['DENIAL_JOURNAL_PATH'] = '';
  expect(journalPath()).toContain('.agentic-monorepo-template');
  delete process.env['DENIAL_JOURNAL_PATH'];
});
