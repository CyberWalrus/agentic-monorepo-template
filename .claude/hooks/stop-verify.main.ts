/**
 * Stop: агент не завершает работу, пока `pnpm verify` красный (roadmap A2 пункт 2).
 * Изменения ищутся от merge-base с main (fallback: origin/main → main → HEAD),
 * поэтому закоммиченная работа проверяется так же, как незакоммиченная; untracked
 * файлы тоже изменение. Документация (*.md) дифф проверку не запускает; прочее
 * под `docs/` — код и проверяется. Чтобы не гонять verify повторно на том же
 * состоянии, хранится отпечаток последнего зелёного прогона: HEAD + полный патч
 * diff + `git status --porcelain` + содержимое untracked-файлов — правка
 * содержимого уже изменённого файла меняет отпечаток. State вне репозитория.
 * После 3 подряд красных хук отпускает, но требует сообщить пользователю.
 * Без zod (З4): отчёт verify валидируется вручную, нечитаемый отчёт — как
 * красный, неожиданная ошибка — exit 2 через обёртку, никогда не код 1.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { projectDir, readHookInput } from './lib.ts';
import { ensureStateRoot, stateDir } from '../../tools/snapshot.ts';

const MAX_BLOCKS = 3;
const VERIFY_TIMEOUT_MS = 280_000;
/** Документация (*.md) verify не запускает; всё остальное — код. */
const DOCS = /\.md$/;

interface VerifyStep {
  name: string;
  ok: boolean;
  command: string;
  output: string;
}

interface VerifyReport {
  ok: boolean;
  steps: VerifyStep[];
}

interface StopState {
  /** Отпечаток последнего зелёного прогона. */
  green: string | null;
  blocks: number;
}

const input = await readHookInput();
ensureStateRoot();
const statePath = join(stateDir(projectDir, input.session_id), 'stop-verify.json');
const state = loadState(statePath);

const head = revParse('HEAD');
const base = mergeBase() ?? head;
const diffNames = diffAgainst(base);
const untracked = listUntracked();

// Нечитаемый git — неизвестность: считаем, что изменения есть (verify запустится).
const changed = [
  ...(diffNames ?? ['<git diff failed>']),
  ...(untracked ?? ['<git ls-files failed>']),
];
const docsOnly = changed.every((file) => DOCS.test(file));
if (docsOnly) {
  process.exit(0);
}

const fingerprint = createHash('sha1')
  .update([head, diffPatch(base), statusRaw(), untrackedFingerprint()].join('\0'))
  .digest('hex');
if (state?.green === fingerprint) {
  process.exit(0);
}

const result = spawnSync(process.execPath, ['tools/verify.ts', '--json'], {
  cwd: projectDir,
  encoding: 'utf8',
  timeout: VERIFY_TIMEOUT_MS,
});
const report = parseReport(result.stdout);

if (report?.ok === true) {
  writeState(statePath, { green: fingerprint, blocks: 0 });
  process.exit(0);
}

const blocks = state?.blocks ?? 0;
if (blocks >= MAX_BLOCKS) {
  writeState(statePath, { green: null, blocks: 0 });
  console.log(
    JSON.stringify({
      systemMessage: `pnpm verify is still failing after ${MAX_BLOCKS} attempts. Tell the user which gates are red and why.`,
    }),
  );
  process.exit(0);
}

writeState(statePath, { green: null, blocks: blocks + 1 });
const failed = report?.steps.filter((step) => !step.ok) ?? [];
const details = failed.length
  ? failed.map((step) => `### ${step.name} (${step.command})\n${step.output}`).join('\n\n')
  : `verify did not produce a report:\n${result.stderr}`;
console.log(
  JSON.stringify({
    decision: 'block',
    reason: `pnpm verify is red, so the task is not done. Fix the failures below (fix code, do not weaken gates), then finish.\n\n${details}`,
  }),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function gitOut(args: string[]): string | null {
  const run = spawnSync('git', args, { cwd: projectDir, encoding: 'utf8' });
  return run.status === 0 ? run.stdout : null;
}

function revParse(ref: string): string {
  const out = gitOut(['rev-parse', '--verify', ref]);
  return out === null ? '' : out.trim();
}

/** merge-base с origin/main, затем с main; null — ни одного нет (используем HEAD). */
function mergeBase(): string | null {
  for (const ref of ['origin/main', 'main']) {
    if (revParse(ref) === '') {
      continue;
    }
    const out = gitOut(['merge-base', ref, 'HEAD']);
    if (out !== null) {
      return out.trim();
    }
  }
  return null;
}

function diffAgainst(from: string): string[] | null {
  if (from === '') {
    return [];
  }
  const out = gitOut(['diff', '--name-only', from, '--']);
  return out === null
    ? null
    : out
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
}

/** Полный патч (не только имена): правка содержимого уже изменённого файла меняет отпечаток. */
function diffPatch(from: string): string {
  if (from === '') {
    return '';
  }
  return gitOut(['diff', from, '--']) ?? '';
}

function statusRaw(): string {
  return gitOut(['status', '--porcelain']) ?? '';
}

/**
 * Хеш имён и содержимого untracked-файлов: новый файл после зелёного Stop и
 * правка его содержимого меняют отпечаток. Нечитаемый файл считается по имени.
 */
function untrackedFingerprint(): string {
  const out = gitOut(['ls-files', '--others', '--exclude-standard', '-z']);
  if (out === null) {
    return '<git ls-files failed>';
  }
  const hash = createHash('sha1');
  for (const name of out.split('\0').filter(Boolean)) {
    hash.update(name);
    try {
      hash.update(readFileSync(join(projectDir, name)));
    } catch {
      hash.update('<unreadable>');
    }
  }
  return hash.digest('hex');
}

function listUntracked(): string[] | null {
  const out = gitOut(['ls-files', '--others', '--exclude-standard']);
  return out === null
    ? null
    : out
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
}

/** null — снимка нет или он нечитаем: отпечаток не совпадёт, verify запустится. */
function loadState(path: string): StopState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const green = parsed['green'];
  const blockCount = parsed['blocks'];
  if (green !== null && typeof green !== 'string') {
    return null;
  }
  if (typeof blockCount !== 'number' || !Number.isInteger(blockCount) || blockCount < 0) {
    return null;
  }
  return { green: green === null ? null : green, blocks: blockCount };
}

function writeState(path: string, next: StopState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(next), { mode: 0o600 });
}

/** Ручная валидация вместо zod (З4): нечитаемый отчёт — как красный, не как пропуск. */
function parseReport(stdout: string): VerifyReport | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed['ok'] !== 'boolean' || !Array.isArray(parsed['steps'])) {
    return null;
  }
  const steps: VerifyStep[] = [];
  for (const step of parsed['steps']) {
    if (
      !isRecord(step) ||
      typeof step['name'] !== 'string' ||
      typeof step['ok'] !== 'boolean' ||
      typeof step['command'] !== 'string' ||
      typeof step['output'] !== 'string'
    ) {
      return null;
    }
    steps.push({
      name: step['name'],
      ok: step['ok'],
      command: step['command'],
      output: step['output'],
    });
  }
  return { ok: parsed['ok'], steps };
}
