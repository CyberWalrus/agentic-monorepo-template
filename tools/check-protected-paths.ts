/**
 * CI-проверка: PR не меняет deny-пути без явного одобрения человека.
 *
 *   node tools/check-protected-paths.ts [base-ref] [head-ref] [--approved]
 *   node tools/check-protected-paths.ts --api-files <files.json> [--approved]
 *
 * git-режим: diff base...head с --no-renames, чтобы переименование защищённого файла
 * выглядело удалением и добавлением, а не «исчезновением» старого имени.
 * api-режим (gate-integrity, ADR 0002): список файлов из GitHub API `pulls/{n}/files`,
 * проверяются и filename, и previous_filename. API отдаёт не больше 3000 файлов —
 * на этом пороге проверка падает, а не пропускает.
 * --approved передаётся, когда одобрение подтверждено tools/check-gate-approval.ts.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

import { protectionOf } from './protected-paths.ts';

const LABEL = 'gate-change-approved';
const API_FILE_LIMIT = 3000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const args = process.argv.slice(2);
const approved = args.includes('--approved');
const apiFilesIndex = args.indexOf('--api-files');
const apiFiles = apiFilesIndex >= 0 ? (args[apiFilesIndex + 1] ?? '') : '';
const positional = args.filter(
  (arg, index) => !arg.startsWith('--') && !(apiFilesIndex >= 0 && index === apiFilesIndex + 1),
);
const baseRef = positional[0] ?? 'origin/main';
const headRef = positional[1] ?? 'HEAD';

function changedFromGit(): string[] {
  // --no-renames: git mv защищённого файла обязан остаться видимым проверке.
  return execFileSync('git', ['diff', '--name-only', '--no-renames', `${baseRef}...${headRef}`], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
}

function changedFromApi(file: string): string[] {
  const entries: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(entries)) {
    throw new Error(`${file}: ожидался массив файлов из pulls/{n}/files`);
  }
  if (entries.length >= API_FILE_LIMIT) {
    console.error(
      `PR меняет ${entries.length} файлов (лимит API ${API_FILE_LIMIT}): полный список недоступен, проверка падает, а не пропускает. Разбей PR.`,
    );
    process.exit(1);
  }
  const names = new Set<string>();
  for (const entry of entries) {
    if (!isRecord(entry)) {
      continue;
    }
    const filename = typeof entry['filename'] === 'string' ? entry['filename'] : undefined;
    const previous =
      typeof entry['previous_filename'] === 'string' ? entry['previous_filename'] : undefined;
    for (const name of [filename, previous]) {
      if (name) {
        names.add(name);
      }
    }
  }
  return [...names];
}

if (apiFilesIndex >= 0 && !apiFiles) {
  console.error('--api-files требует путь к JSON из pulls/{n}/files');
  process.exit(2);
}
const changed = apiFiles ? changedFromApi(apiFiles) : changedFromGit();

const denied = changed.filter((file) => protectionOf(file) === 'deny');
const review = changed.filter((file) => protectionOf(file) === 'review');

const lines = [
  '## Protected paths',
  denied.length === 0
    ? 'No gate files changed.'
    : `Gate files changed (${approved ? 'approved by label' : 'NOT approved'}):\n${denied.map((f) => `- \`${f}\``).join('\n')}`,
  review.length === 0
    ? ''
    : `Requires CODEOWNERS review:\n${review.map((f) => `- \`${f}\``).join('\n')}`,
].filter(Boolean);

console.log(lines.join('\n\n'));
if (process.env['GITHUB_STEP_SUMMARY']) {
  appendFileSync(process.env['GITHUB_STEP_SUMMARY'], `${lines.join('\n\n')}\n`);
}

if (denied.length > 0 && !approved) {
  console.error(
    `\nThis PR changes quality gates (baselines, thresholds, lint/CI config). A human must review and add the \`${LABEL}\` label after the last push.`,
  );
  process.exit(1);
}
