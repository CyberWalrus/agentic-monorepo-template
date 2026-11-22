/**
 * Режим обслуживания по областям (ADR 0009, задача b9).
 *
 * Полный режим (`.claude/settings.local.json` с disableAllHooks) выключает все
 * хуки разом — включая линт после правки и Stop-verify, которые в осознанном
 * изменении гейта нужны. Локальный режим открывает не всё, а пути из `touches`
 * задачи: файл `.claude/maintenance.json` в корне worktree создаёт человек или
 * оператор (обычному агенту запись в него запрещена — файл под deny и под
 * denyWrite песочницы, включение и удаление через интерфейс хоста).
 *
 * Какие слои файл поднимает (ревью плана b9):
 *  - protect-paths (Edit/Write) — не отказывает по открытым путям;
 *  - проверка по результату (protect-result → reconcile в tools/snapshot.ts) —
 *    открытые пути исключены из сверки и отката;
 *  - НЕ поднимает guard-bash и OS-песочницу: shell-записи в открытые пути
 *    остаются закрытыми на уровне ОС, режим фактически Edit/Write-only;
 *  - НЕ выключает остальные хуки: lint-changed-file, stop-verify, session-start
 *    работают как раньше.
 *
 * Fail-closed (З4): отсутствующий, нечитаемый или битый файл игнорируется —
 * защита полная. Файл привязан к id задачи (для аудита и анонса session-start).
 * Без зависимостей от node_modules: модуль импортируют хуки и snapshot (З4).
 */
import { readFileSync } from 'node:fs';
import { join, matchesGlob } from 'node:path';

/** Путь файла режима по областям относительно корня worktree. */
export const MAINTENANCE_FILE = '.claude/maintenance.json';

export interface MaintenanceSession {
  /** id задачи, для которой открыты пути (аудит и анонс session-start). */
  task: string;
  /** Паттерны путей (literal или `каталог/**`), открытых на сессию. */
  paths: string[];
}

/**
 * Читает и валидирует файл режима; любой сбой — null («режима нет», защита
 * полная). Throw здесь сделал бы битый опциональный файл причиной exit 2 у
 * каждого хука сессии: громче нужного, защита и так не ослаблена.
 */
export function readMaintenanceSession(root: string): MaintenanceSession | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(root, MAINTENANCE_FILE), 'utf8')) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const task = parsed['task'];
  const paths = parsed['paths'];
  if (typeof task !== 'string' || task === '') {
    return null;
  }
  if (!Array.isArray(paths) || !paths.every((path) => typeof path === 'string' && path !== '')) {
    return null;
  }
  return { task, paths: paths.filter((path): path is string => typeof path === 'string') };
}

/**
 * Открыт ли путь (относительно корня репозитория) локальным режимом.
 * Семантика паттернов — как у touches/protected-paths: literal и `каталог/**`;
 * каталог, внутри которого лежит файл, покрыт так же (сравни
 * protectionOf в tools/protected-paths.ts).
 */
export function isPathOpen(root: string, relativePath: string): boolean {
  const session = readMaintenanceSession(root);
  if (session === null) {
    return false;
  }
  const normalized = relativePath.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  const candidates = [normalized, `${normalized}/__child__`];
  return session.paths.some((pattern) =>
    candidates.some((candidate) => matchesGlob(candidate, pattern)),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
