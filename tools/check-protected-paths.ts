/**
 * CI-проверка: PR не меняет deny-пути без явного одобрения человека.
 *   node tools/check-protected-paths.ts <base-ref> [--approved]
 * --approved передаётся, когда на PR стоит label `gate-change-approved`.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

import { protectionOf } from './protected-paths.ts';

const baseRef = process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? 'origin/main';
const approved = process.argv.includes('--approved');

const changed = execFileSync('git', ['diff', '--name-only', `${baseRef}...HEAD`], {
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean);

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
    '\nThis PR changes quality gates (baselines, thresholds, lint/CI config). A human must review and add the `gate-change-approved` label.',
  );
  process.exit(1);
}
