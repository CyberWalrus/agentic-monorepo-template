/** PreToolUse(Edit|Write|MultiEdit|NotebookEdit): запрет записи в защищённые пути. */
import { protectionOf } from '../protected-paths.ts';
import { deny, failClosedExit, readHookInput, targetFile } from './lib.ts';

// Прямой вызов CLI наследует fail-closed: необработанный сбой — exit 2 (З4, C10.1).
process.on('uncaughtException', failClosedExit);
process.on('unhandledRejection', failClosedExit);

const input = await readHookInput();
const file = targetFile(input);

if (file && protectionOf(file) === 'deny') {
  deny(
    `${file} is a protected quality gate (tools/protected-paths.json). ` +
      'Agents must not change baselines, budgets, thresholds or lint/CI config. ' +
      'Fix the code instead. If you believe the gate itself is wrong, stop and explain it to the user.',
  );
}
