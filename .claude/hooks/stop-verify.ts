/**
 * Stop: агент не завершает работу, пока `pnpm verify` красный.
 * Запускается только если в рабочем дереве есть изменения кода. После 3 подряд
 * неудач отпускает (защита от бесконечного цикла), но просит сообщить пользователю.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as z from 'zod';

import { projectDir, readHookInput } from './lib.ts';

const MAX_BLOCKS = 3;

const ReportSchema = z.object({
  ok: z.boolean(),
  steps: z.array(
    z.object({ name: z.string(), ok: z.boolean(), command: z.string(), output: z.string() }),
  ),
});
const input = await readHookInput();

const changed = execFileSync('git', ['status', '--porcelain'], {
  cwd: projectDir,
  encoding: 'utf8',
})
  .split('\n')
  .map((line) => line.slice(3).trim())
  .filter(Boolean)
  .filter((file) => !/^docs\/|\.md$/.test(file));
if (changed.length === 0) {
  process.exit(0);
}

const counterFile = join(tmpdir(), `claude-stop-verify-${input.session_id}`);
const blocks = Number.parseInt(readFileSyncSafe(counterFile) ?? '0', 10) || 0;

const result = spawnSync(process.execPath, ['tools/verify.ts', '--json'], {
  cwd: projectDir,
  encoding: 'utf8',
  timeout: 280_000,
});
const report = parseReport(result.stdout);

if (report?.ok) {
  rmSync(counterFile, { force: true });
  process.exit(0);
}

if (blocks >= MAX_BLOCKS) {
  rmSync(counterFile, { force: true });
  console.log(
    JSON.stringify({
      systemMessage: `pnpm verify is still failing after ${MAX_BLOCKS} attempts. Tell the user which gates are red and why.`,
    }),
  );
  process.exit(0);
}

writeFileSync(counterFile, String(blocks + 1));
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

function readFileSyncSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function parseReport(stdout: string): z.infer<typeof ReportSchema> | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return ReportSchema.parse(parsed);
  } catch {
    return null;
  }
}
