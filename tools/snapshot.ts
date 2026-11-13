/**
 * Снимок защищённых файлов — проверка по результату (roadmap A2 пункт 1, ADR 0003).
 * SessionStart запоминает содержимое tracked-файлов из deny-путей на начало сессии,
 * PostToolUse(Bash) и Stop сверяют текущее состояние со снимком: изменение отменяется
 * возвратом к снимку и объясняется агенту; дрейф, совпавший с новым HEAD (pull/merge),
 * перебазирует снимок; новые файлы под deny только сообщаются и никогда не удаляются.
 *
 * Порча state (пропавшая или не совпадающая с manifest копия) делает проверку громко
 * слепой: сверка и откат не проводятся по ненадёжному состоянию, сообщается отказ.
 *
 * Модуль не имеет внешних зависимостей: хуки агента не имеют права падать
 * из-за отсутствующего node_modules (З4).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { protectionOf } from './protected-paths.ts';

export interface SnapshotEntry {
  /** sha1 содержимого файла на момент снимка. */
  hash: string;
  executable: boolean;
}

export interface SnapshotManifest {
  version: 1;
  /** HEAD на момент снимка; обновляется при перебазировании. */
  head: string;
  /** Относительный путь → запись снимка. */
  files: Record<string, SnapshotEntry>;
}

export interface ReconcileResult {
  /** Изменения, отменённые возвратом к снимку. */
  restored: string[];
  /** Дрейф, совпавший с новым HEAD: снимок перебазирован, ничего не откатывалось. */
  rebased: string[];
  /** Файл исчез вместе с HEAD (легитимное движение ветки) — убран из снимка. */
  dropped: string[];
  /** Новые файлы под deny: только сообщаются, хук их не удаляет. */
  created: string[];
}

export type ReconcileOutcome =
  | { kind: 'missing' }
  | { kind: 'broken'; detail: string }
  | ({ kind: 'checked' } & ReconcileResult);

const STATE_ROOT = join(tmpdir(), 'claude-gate-guard');
const STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function git(projectDir: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: projectDir, encoding: 'utf8' });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr ?? String(result.error)}`);
  }
  return result.stdout;
}

function contentHash(path: string): string {
  return createHash('sha1').update(readFileSync(path)).digest('hex');
}

/**
 * Путь из manifest безопасен для join с корнем worktree: относительный, без `..`-сегментов
 * и абсолютных форм. Подделка state — сознательный обход, но не давать ему запись вне
 * worktree ничего не стоит.
 */
function isSafeRelPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    !path.split('/').includes('..')
  );
}

/** Ключ state-каталога: сессия + хеш пути worktree, сам state живёт вне репозитория. */
export function stateDir(projectDir: string, sessionId: string): string {
  const safeId = sessionId.replaceAll(/[^A-Za-z0-9._-]/g, '-');
  const key = createHash('sha256').update(projectDir).digest('hex').slice(0, 12);
  return join(STATE_ROOT, `${safeId}-${key}`);
}

/**
 * Корень state доступен на запись только владельцу. На Linux /tmp общий: чужой
 * заранее созданный каталог с записью для всех позволил бы подменять копии.
 */
function ensureStateRoot(): void {
  let existing;
  try {
    existing = statSync(STATE_ROOT);
  } catch {
    mkdirSync(STATE_ROOT, { recursive: true, mode: 0o700 });
    return;
  }
  if ((existing.mode & 0o022) !== 0) {
    throw new Error(
      `state root ${STATE_ROOT} is writable for group or others; refusing to keep snapshots there`,
    );
  }
}

/** HEAD-коммит репозитория или пустая строка, если коммитов ещё нет. */
function headSha(projectDir: string): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: projectDir, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

/** Tracked-файлы из deny-путей: их содержимое и есть снимаемая база. */
function enumerateProtected(projectDir: string): string[] {
  return git(projectDir, ['ls-files', '--cached', '-z'])
    .split('\0')
    .filter((path) => path.length > 0 && protectionOf(path) === 'deny');
}

/** Tracked и untracked файлы из deny-путей: для поиска появившихся файлов. */
function enumerateAll(projectDir: string): string[] {
  return git(projectDir, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter((path) => path.length > 0 && protectionOf(path) === 'deny');
}

/** Blob-ши файлов в текущем HEAD: путь → sha. Пустая карта, если коммитов нет. */
function headTree(projectDir: string): Map<string, string> {
  const tree = new Map<string, string>();
  if (headSha(projectDir) === '') {
    return tree;
  }
  for (const entry of git(projectDir, ['ls-tree', '-r', '-z', 'HEAD']).split('\0')) {
    const match = /^[0-7]+ blob ([0-9a-f]{40})\t(.+)$/.exec(entry);
    if (match !== null) {
      tree.set(match[2] ?? '', match[1] ?? '');
    }
  }
  return tree;
}

/** Снимает снимок заново: копии содержимого (0600) + manifest с записанным HEAD. */
export function createSnapshot(
  projectDir: string,
  sessionId: string,
): { manifest: SnapshotManifest; missing: string[] } {
  ensureStateRoot();
  const dir = stateDir(projectDir, sessionId);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const manifest: SnapshotManifest = { version: 1, head: headSha(projectDir), files: {} };
  const missing: string[] = [];
  for (const path of enumerateProtected(projectDir)) {
    const absolute = join(projectDir, path);
    let status;
    try {
      status = lstatSync(absolute);
    } catch {
      // tracked, но файла нет уже на старте сессии: защищать нечего, это сообщается
      missing.push(path);
      continue;
    }
    // Снимок и restore через symlink протолкнули бы содержимое в цель ссылки
    // вне worktree. Отказ громкий: проверка по результату слепа на этой сессии.
    if (status.isSymbolicLink()) {
      throw new Error(
        `protected path is a symlink: ${path}; refusing to snapshot or restore through it`,
      );
    }
    const copy = join(dir, path.replaceAll('/', '__'));
    copyFileSync(absolute, copy);
    chmodSync(copy, 0o600);
    manifest.files[path] = {
      hash: contentHash(absolute),
      executable: (status.mode & 0o111) !== 0,
    };
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
  return { manifest, missing };
}

/** null — снимка нет или он нечитаем: проверка по результату слепа, это сообщается агенту. */
export function loadSnapshot(projectDir: string, sessionId: string): SnapshotManifest | null {
  let raw: string;
  try {
    raw = readFileSync(join(stateDir(projectDir, sessionId), 'manifest.json'), 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const head = parsed['head'];
  const files = parsed['files'];
  if (parsed['version'] !== 1 || typeof head !== 'string' || !isRecord(files)) {
    return null;
  }
  const entries: Record<string, SnapshotEntry> = {};
  for (const [path, entry] of Object.entries(files)) {
    if (
      !isSafeRelPath(path) ||
      !isRecord(entry) ||
      typeof entry['hash'] !== 'string' ||
      !/^[0-9a-f]{40}$/.test(entry['hash']) ||
      typeof entry['executable'] !== 'boolean'
    ) {
      return null;
    }
    entries[path] = { hash: entry['hash'], executable: entry['executable'] };
  }
  return { version: 1, head, files: entries };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function restoreFile(
  projectDir: string,
  sessionId: string,
  path: string,
  entry: SnapshotEntry,
): void {
  const copy = join(stateDir(projectDir, sessionId), path.replaceAll('/', '__'));
  const absolute = join(projectDir, path);
  // Ссылка на защищённом пути заменяется файлом из снимка: запись сквозь неё
  // ушла бы в цель ссылки, в том числе вне worktree. Отсутствующего файла это
  // не касается — разворачиваем копию как обычный файл.
  let link;
  try {
    link = lstatSync(absolute);
  } catch {
    link = null;
  }
  if (link !== null && link.isSymbolicLink()) {
    unlinkSync(absolute);
  }
  copyFileSync(copy, absolute);
  chmodSync(absolute, entry.executable ? 0o755 : 0o644);
}

/**
 * Сверяет рабочее дерево со снимком и устраняет расхождения. Бросает только при
 * сбое окружения (git недоступен): вызывающий хук обязан закрыться (exit 2).
 */
export function reconcile(projectDir: string, sessionId: string): ReconcileOutcome {
  const manifest = loadSnapshot(projectDir, sessionId);
  if (manifest === null) {
    return { kind: 'missing' };
  }
  const dir = stateDir(projectDir, sessionId);
  try {
    ensureStateRoot();
  } catch (error) {
    return { kind: 'broken', detail: error instanceof Error ? error.message : String(error) };
  }
  const tree = headTree(projectDir);
  const currentHead = headSha(projectDir);
  const result: ReconcileResult = { restored: [], rebased: [], dropped: [], created: [] };

  // Копии — единственный источник отката: пока каждая не сверена с manifest,
  // сверять рабочее дерево и откатывать нельзя — порченая копия откатила бы файл к мусору.
  for (const [path, entry] of Object.entries(manifest.files)) {
    let copyHash: string;
    try {
      copyHash = contentHash(join(dir, path.replaceAll('/', '__')));
    } catch {
      return { kind: 'broken', detail: `copy of ${path} is missing or unreadable` };
    }
    if (copyHash !== entry.hash) {
      return { kind: 'broken', detail: `copy of ${path} does not match the manifest hash` };
    }
  }

  let changed = false;
  for (const [path, entry] of Object.entries(manifest.files)) {
    const absolute = join(projectDir, path);
    if (!existsSync(absolute)) {
      if (tree.has(path)) {
        try {
          restoreFile(projectDir, sessionId, path, entry);
        } catch (error) {
          return {
            kind: 'broken',
            detail: `could not restore ${path}: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
        result.restored.push(path);
      } else {
        delete manifest.files[path];
        result.dropped.push(path);
      }
      changed = true;
      continue;
    }
    const hash = contentHash(absolute);
    if (hash === entry.hash) {
      continue;
    }
    // Совпадение содержимого с blob текущего HEAD означает легитимное движение
    // ветки (pull/merge принёс изменения гейтов) — снимок перебазируется.
    const blob = git(projectDir, ['hash-object', '--', path]).trim();
    if (blob !== '' && blob === tree.get(path)) {
      entry.hash = hash;
      manifest.head = currentHead;
      result.rebased.push(path);
    } else {
      try {
        restoreFile(projectDir, sessionId, path, entry);
      } catch (error) {
        return {
          kind: 'broken',
          detail: `could not restore ${path}: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      result.restored.push(path);
    }
    changed = true;
  }
  const known = new Set(Object.keys(manifest.files));
  result.created = enumerateAll(projectDir).filter((path) => !known.has(path));
  if (changed) {
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
  }
  return { kind: 'checked', ...result };
}

/** Удаляет state-каталоги других сессий старше недели: state одноразовый и вне репозитория. */
export function cleanupStateDirs(projectDir: string, sessionId: string): void {
  let names: string[];
  try {
    names = readdirSync(STATE_ROOT);
  } catch {
    return;
  }
  const own = stateDir(projectDir, sessionId);
  for (const name of names) {
    const dir = join(STATE_ROOT, name);
    if (dir === own) {
      continue;
    }
    try {
      if (Date.now() - statSync(dir).mtimeMs > STATE_MAX_AGE_MS) {
        rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // каталог исчез под ногами — не мешает снимку
    }
  }
}
