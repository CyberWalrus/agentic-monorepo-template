/**
 * Снимок защищённых файлов — проверка по результату (roadmap A2 пункт 1, ADR 0003).
 * SessionStart запоминает содержимое tracked-файлов из deny-путей на начало сессии,
 * PostToolUse(Bash) и Stop сверяют текущее состояние со снимком: изменение отменяется
 * возвратом к снимку и объясняется агенту; дрейф, совпавший с новым HEAD (pull/merge),
 * перебазирует снимок; новые файлы под deny только сообщаются и никогда не удаляются.
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
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
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

export type ReconcileOutcome = { kind: 'missing' } | ({ kind: 'checked' } & ReconcileResult);

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

/** Ключ state-каталога: сессия + хеш пути worktree, сам state живёт вне репозитория. */
export function stateDir(projectDir: string, sessionId: string): string {
  const safeId = sessionId.replaceAll(/[^A-Za-z0-9._-]/g, '-');
  const key = createHash('sha256').update(projectDir).digest('hex').slice(0, 12);
  return join(STATE_ROOT, `${safeId}-${key}`);
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
export function createSnapshot(projectDir: string, sessionId: string): SnapshotManifest {
  const dir = stateDir(projectDir, sessionId);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const manifest: SnapshotManifest = { version: 1, head: headSha(projectDir), files: {} };
  for (const path of enumerateProtected(projectDir)) {
    const absolute = join(projectDir, path);
    const copy = join(dir, path.replaceAll('/', '__'));
    copyFileSync(absolute, copy);
    chmodSync(copy, 0o600);
    manifest.files[path] = {
      hash: contentHash(absolute),
      executable: (statSync(absolute).mode & 0o111) !== 0,
    };
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
  return manifest;
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
      !isRecord(entry) ||
      typeof entry['hash'] !== 'string' ||
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
  const tree = headTree(projectDir);
  const currentHead = headSha(projectDir);
  const result: ReconcileResult = { restored: [], rebased: [], dropped: [], created: [] };
  let changed = false;
  for (const [path, entry] of Object.entries(manifest.files)) {
    const absolute = join(projectDir, path);
    if (!existsSync(absolute)) {
      if (tree.has(path)) {
        restoreFile(projectDir, sessionId, path, entry);
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
      restoreFile(projectDir, sessionId, path, entry);
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
