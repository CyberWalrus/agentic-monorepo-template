/**
 * Машиноуровневая блокировка перф-прогона (З9, A5 PR-3): два параллельных
 * worktree меряют перф на одной машине — второй замер шумаёт от нагрузки
 * первого. Lock-файл в tmpdir (O_EXCL: pid + время получения); держатель
 * печатается ждущим. Мёртвый pid или файл старше 15 минут считаются мусором
 * упавшего прогона и забираются с предупреждением (иначе один крах навсегда
 * блокирует перф на машине).
 *
 * З13: время приходит параметром (now), случайности нет. Путь lock-файла —
 * тоже параметр (lockFile): по умолчанию машинный в tmpdir, тесты передают
 * свой файл во временном каталоге, чтобы не мешать чужому perf-прогону.
 */
import { openSync, closeSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_LOCK_FILE = join(tmpdir(), 'agentic-monorepo-perf.lock');
const POLL_MS = 2_000;
const STALE_MS = 15 * 60 * 1000;

export interface PerfLockOptions {
  /** Момент «сейчас» — параметр по З13 (тесты передают фиксированный). */
  now?: number;
  /** Частота опроса держателя: тесты ускоряют. */
  pollMs?: number;
  /**
   * Путь lock-файла. По умолчанию — машинный замок в tmpdir, общий для всех
   * worktree. Тесты передают свой файл во временном каталоге: на настоящем
   * пути они ждали бы чужой живой perf-прогон до таймаута и удаляли его lock.
   */
  lockFile?: string;
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
function readPayload(lockFile: string): LockPayload | null {
  try {
    return payloadOf(readFileSync(lockFile, 'utf8'));
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

function tryAcquire(lockFile: string, now: number): PerfLock | null {
  let fd: number;
  try {
    fd = openSync(lockFile, 'wx');
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
        const held = payloadOf(readFileSync(lockFile, 'utf8'));
        if (held?.pid === process.pid) {
          unlinkSync(lockFile);
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
  const lockFile = options.lockFile ?? DEFAULT_LOCK_FILE;
  const pollMs = options.pollMs ?? POLL_MS;
  for (;;) {
    // now — на каждой итерации: вошедший при «свежем» lock ждёт вечно, если
    // держатель завис, оставаясь живым, а протухание проверять нечем.
    const now = options.now ?? Date.now();
    const acquired = tryAcquire(lockFile, now);
    if (acquired !== null) {
      return acquired;
    }
    const held = readPayload(lockFile);
    if (!isStale(held, now)) {
      console.warn(
        `perf-lock: waiting for pid ${held?.pid} to finish its perf run... (lock: ${lockFile})`,
      );
      await sleep(pollMs);
      continue;
    }
    const reread = readPayload(lockFile);
    if (!isStale(reread, now)) {
      // Файл пересоздали со свежим держателем — не наш, ждать.
      continue;
    }
    try {
      unlinkSync(lockFile);
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
