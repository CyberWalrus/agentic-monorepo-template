/** PreToolUse(Edit|Write|MultiEdit|NotebookEdit): запрет записи в защищённые пути. */
import { protectionOf } from '../../tools/protected-paths.ts';
import { deny, readHookInput, targetFile } from './lib.ts';

const input = await readHookInput();
const file = targetFile(input);

if (file && protectionOf(file) === 'deny') {
  deny(
    `${file} is a protected quality gate (tools/protected-paths.json). ` +
      'Agents must not change baselines, budgets, thresholds or lint/CI config. ' +
      'Fix the code instead. If you believe the gate itself is wrong, stop and explain it to the user.',
  );
}
