/** SessionStart: проверка окружения, чтобы агент не тратил итерации на «не та версия Node». */
import { existsSync } from 'node:fs';

import { projectDir } from './lib.ts';

const problems: string[] = [];
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
if (major < 26 || (major === 26 && minor < 13)) {
  problems.push(
    `Node ${process.versions.node} is active, the repo needs >= 26.13 (run \`nvm use\`).`,
  );
}
if (!existsSync(`${projectDir}/node_modules`)) {
  problems.push('Dependencies are not installed: run `pnpm install`.');
}

if (problems.length > 0) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `Environment problems:\n- ${problems.join('\n- ')}`,
      },
    }),
  );
}
