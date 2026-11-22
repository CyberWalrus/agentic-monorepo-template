/** PreToolUse(Edit|Write|MultiEdit|NotebookEdit): запрет записи в защищённые пути. */
import { isPathOpen } from '../maintenance.ts';
import { protectionOf } from '../protected-paths.ts';
import { deny, failClosedExit, projectDir, readHookInput, targetFile } from './lib.ts';
process.env['HOOK_GATE_NAME'] ??= 'protect-paths';

// Прямой вызов CLI наследует fail-closed: необработанный сбой — exit 2 (З4, C10.1).
process.on('uncaughtException', failClosedExit);
process.on('unhandledRejection', failClosedExit);

const input = await readHookInput();
const file = targetFile(input);

// Режим обслуживания по областям (b9, ADR 0009): пути из
// .claude/maintenance.json (создаёт человек/оператор) открыты для Edit/Write;
// отсутствующий или битый файл режима — null, защита полная. guard-bash и
// OS-песочница файлом не поднимаются: режим Edit/Write-only.
if (file && protectionOf(file) === 'deny' && !isPathOpen(projectDir, file)) {
  deny(
    'protect-paths',
    `${file} is a protected quality gate (tools/protected-paths.json). ` +
      'Agents must not change baselines, budgets, thresholds or lint/CI config. ' +
      'Fix the code instead. If you believe the gate itself is wrong, stop and explain it to the user.',
  );
}
