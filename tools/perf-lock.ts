/**
 * Машиноуровневая блокировка перф-прогона (З9, A5 PR-3): два параллельных
 * worktree меряют перф на одной машине — второй замер шумаёт от нагрузки
 * первого. Lock-файл в tmpdir (O_EXCL: pid + время получения); держатель
 * печатается ждущим. Мёртвый pid или файл старше 15 минут считаются мусором
 * упавшего прогона и забираются с предупреждением (иначе один крах навсегда
 * блокирует перф на машине).
 *
 * З13: время приходит параметром (now), случайности нет.
 */
import { openSync, closeSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOCK_FILE = join(tmpdir(), 'agentic-monorepo-perf.lock');
const POLL_MS = 2_000;
const STALE_MS = 15 * 60 * 1000;

export interface PerfLockOptions {
  /** Момент «сейчас» — параметр по З13 (тесты передают фиксированный). */
  now?: number;
  /** Частота опроса держателя: тесты ускоряют. */
  pollMs?: number;
}

export interface PerfLock {
  release: () => void;
}

interface LockPayload {
  pid: number;
  takenAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function payloadOf(raw: string): LockPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const { pid, takenAt } = parsed;
  if (typeof pid !== 'number' || typeof takenAt !== 'number') {
    return null;
  }
  return { pid, takenAt };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Читает lock: исчез между попытками (держатель отпустил) — null, не ошибка. */
function readPayload(): LockPayload | null {
  try {
    return payloadOf(readFileSync(LOCK_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isStale(held: LockPayload | null, now: number): boolean {
  return held === null || !isAlive(held.pid) || now - held.takenAt > STALE_MS;
}

function tryAcquire(now: number): PerfLock | null {
  let fd: number;
  try {
    fd = openSync(LOCK_FILE, 'wx');
  } catch {
    return null;
  }
  try {
    writeSync(fd, `${JSON.stringify({ pid: process.pid, takenAt: now })}\n`);
  } finally {
    closeSync(fd);
  }
  return {
    release: () => {
      try {
        const held = payloadOf(readFileSync(LOCK_FILE, 'utf8'));
        if (held?.pid === process.pid) {
          unlinkSync(LOCK_FILE);
        }
      } catch {
        // Не наш файл или уже удалён — освобождать нечего.
      }
    },
  };
}

/**
 * Берёт блокировку на машину: ждёт держателя с логом, мёртвый/протухший lock
 * забирает. Устойчива к churn'у: между попыткой захвата и чтением держатель
 * мог отпустить файл (ENOENT — новая попытка), между чтением и удалением файл
 * мог появиться заново (перечитываем и удаляем только подтверждённо-протухший).
 */
export async function acquirePerfLock(options: PerfLockOptions = {}): Promise<PerfLock> {
  const pollMs = options.pollMs ?? POLL_MS;
  for (;;) {
    // now — на каждой итерации: вошедший при «свежем» lock ждёт вечно, если
    // держатель завис, оставаясь живым, а протухание проверять нечем.
    const now = options.now ?? Date.now();
    const acquired = tryAcquire(now);
    if (acquired !== null) {
      return acquired;
    }
    const held = readPayload();
    if (!isStale(held, now)) {
      console.warn(
        `perf-lock: waiting for pid ${held?.pid} to finish its perf run... (lock: ${LOCK_FILE})`,
      );
      await sleep(pollMs);
      continue;
    }
    const reread = readPayload();
    if (!isStale(reread, now)) {
      // Файл пересоздали со свежим держателем — не наш, ждать.
      continue;
    }
    try {
      unlinkSync(LOCK_FILE);
    } catch (error: unknown) {
      // ENOENT — уже удалён (держатель отпустил сам); sticky-каталог мог не дать
      // удалить чужую запись (EPERM) — громко ждём дальше, не роняя прогон.
      console.warn(`perf-lock: cannot remove stale lock (${errorMessage(error)}) — retry`);
      await sleep(pollMs);
      continue;
    }
    console.warn(
      `perf-lock: stale lock removed (${held === null ? 'unreadable' : `pid ${held.pid} not alive or expired`})`,
    );
  }
}
