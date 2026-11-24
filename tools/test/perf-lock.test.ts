import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { acquirePerfLock, type PerfLockOptions } from '../perf-lock.ts';

// Ожидание держателя — суть механизма: ждём с быстрым опросом, не дефект (З13 —
// время приходит параметром).
vi.setConfig({ testTimeout: 30_000 });

const repoDir = resolve(import.meta.dirname, '..', '..');
// Свой каталог на прогон файла. Настоящий машинный замок (tmpdir) общий для всех
// worktree: на нём тест ждал бы чужой живой perf-прогон до таймаута и удалял
// его lock в afterEach — ложный red при параллельных verify (З9).
const lockDir = mkdtempSync(join(tmpdir(), 'perf-lock-test-'));
const LOCK_FILE = join(lockDir, 'agentic-monorepo-perf.lock');

/** Захват только через свой lock-файл: без параметра остался бы машинный. */
const acquire = (options: PerfLockOptions = {}) =>
  acquirePerfLock({ ...options, lockFile: LOCK_FILE });

afterEach(() => {
  try {
    unlinkSync(LOCK_FILE);
  } catch {
    // Уже не существует — чисто.
  }
});

afterAll(() => {
  rmSync(lockDir, { recursive: true, force: true });
});

const ALIVE_PID = process.pid;
const NOW = 1_700_000_000_000;

describe('acquirePerfLock', () => {
  it('acquires a free machine and releases it', async () => {
    const lock = await acquire({ now: NOW, pollMs: 10 });
    expect(() => lock.release()).not.toThrow();
    // После release машина свободна — можно взять снова.
    const again = await acquire({ now: NOW, pollMs: 10 });
    again.release();
  });

  it('waits for a live holder and acquires after release', async () => {
    const first = await acquire({ now: NOW, pollMs: 10 });

    let second: { release: () => void } | undefined;
    const waiting = acquire({ now: NOW, pollMs: 10 }).then((lock) => {
      second = lock;
      return second;
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    expect(second).toBeUndefined();
    first.release();
    await waiting;
    expect(second).toBeDefined();
    second?.release();
  });

  it('takes a stale lock of a dead pid without waiting', async () => {
    writeFileSync(LOCK_FILE, `${JSON.stringify({ pid: 999_999_999, takenAt: NOW })}\n`);

    const lock = await acquire({ now: NOW + 1, pollMs: 10 });

    expect(lock).toBeDefined();
    lock.release();
  });

  it('takes an expired lock even if the pid is alive', async () => {
    // takenAt много старше 15 минут: держатель жив, но прогон протух.
    writeFileSync(LOCK_FILE, `${JSON.stringify({ pid: ALIVE_PID, takenAt: NOW - 16 * 60_000 })}\n`);

    const lock = await acquire({ now: NOW, pollMs: 10 });

    expect(lock).toBeDefined();
    lock.release();
  });

  it('takes a corrupted lock file', async () => {
    writeFileSync(LOCK_FILE, 'not json at all');

    const lock = await acquire({ now: NOW, pollMs: 10 });

    expect(lock).toBeDefined();
    lock.release();
  });

  it('does not remove a foreign lock on release', async () => {
    const lock = await acquire({ now: NOW, pollMs: 10 });
    const foreign = `${JSON.stringify({ pid: 123456, takenAt: NOW })}\n`;
    writeFileSync(LOCK_FILE, foreign);

    lock.release();

    // Release не удалил чужой файл: следующий acquire увидит чужой pid и не
    // захватит молча (будет ждать или признает stale).
    expect(readFileSync(LOCK_FILE, 'utf8')).toContain('123456');
    unlinkSync(LOCK_FILE);
  });

  it('survives a cross-process holder releasing while a waiter polls', async () => {
    // Регрессия (test-quality major): между tryAcquire и чтением файла держатель
    // мог отпустить lock — ENOENT в readPayload не должен реджектить ожидание.
    // Ребёнок циклично держит/отпускает lock, родитель опрашивает: любой
    // ENOENT-краш родителя роняет тест.
    const child = spawn(
      process.execPath,
      [
        '-e',
        `const m = await import(${JSON.stringify(join(repoDir, 'tools', 'perf-lock.ts'))});
         for (let i = 0; i < 30; i++) {
           const lock = await m.acquirePerfLock({ pollMs: 1, lockFile: ${JSON.stringify(LOCK_FILE)} });
           await new Promise((r) => setTimeout(r, 3));
           lock.release();
         }`,
      ],
      { cwd: repoDir, stdio: 'ignore' },
    );
    try {
      const lock = await acquire({ pollMs: 1 });
      // Ассерт неявный: любой ENOENT-краш acquire — реджект await выше.
      expect(lock.release).toBeTypeOf('function');
      lock.release();
    } finally {
      await new Promise((onExit) => {
        child.once('exit', onExit);
      });
    }
  }, 30_000);
});
