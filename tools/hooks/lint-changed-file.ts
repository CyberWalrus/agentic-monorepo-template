/** PostToolUse(Edit|Write|MultiEdit): формат + type-aware линт изменённого файла. Ошибки возвращаются агенту. */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { failClosedExit, projectDir, readHookInput, targetFile } from './lib.ts';

// Прямой вызов CLI наследует fail-closed: необработанный сбой — exit 2 (З4, C10.1).
process.on('uncaughtException', failClosedExit);
process.on('unhandledRejection', failClosedExit);

const input = await readHookInput();
const file = targetFile(input);
if (!file || !existsSync(`${projectDir}/${file}`)) {
  process.exit(0);
}

const run = (bin: string, args: string[]) =>
  spawnSync(`${projectDir}/node_modules/.bin/${bin}`, args, { cwd: projectDir, encoding: 'utf8' });

if (/\.(ts|tsx|js|mjs|cjs|json|jsonc|css|md|ya?ml)$/.test(file)) {
  run('oxfmt', ['--no-error-on-unmatched-pattern', file]);
}

if (/\.(ts|tsx|js|mjs|cjs)$/.test(file)) {
  const lint = run('oxlint', ['--type-aware', '--deny-warnings', '--format', 'agent', file]);
  if (lint.status !== 0) {
    console.error(
      `Oxlint found problems in ${file}. Fix them now (do not suppress):\n${lint.stdout}${lint.stderr}`,
    );
    process.exit(2);
  }
}
