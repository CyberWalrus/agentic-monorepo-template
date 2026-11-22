/**
 * SessionStart: проверка окружения + снимок защищённых файлов для проверки по
 * результату (roadmap A2 пункт 1, ADR 0003). Снимок снимается только на startup;
 * на resume/clear/compact существующий снимок переиспользуется, а при отсутствии
 * создаётся с предупреждением. SessionStart ничего не может запретить, поэтому
 * «закрытием» здесь является громкое сообщение: сбой снимка виден агенту.
 */
import { existsSync } from 'node:fs';

import { failClosedExit, projectDir, readHookInput } from './lib.ts';
import { MAINTENANCE_FILE, readMaintenanceSession } from '../maintenance.ts';

// Прямой вызов CLI наследует fail-closed: необработанный сбой — exit 2 (З4, C10.1).
process.on('uncaughtException', failClosedExit);
process.on('unhandledRejection', failClosedExit);

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

let sessionId = 'unknown';
let source = 'startup';
try {
  const input = await readHookInput();
  sessionId = input.session_id;
  if (typeof input.source === 'string') {
    source = input.source;
  }
} catch {
  problems.push('SessionStart input was not valid JSON; the snapshot key may be wrong.');
}

// Динамический импорт: сбой модуля снимка (например, битый protected-paths.json)
// не должен убить проверку окружения — она остаётся полезной без снимка.
function warnMissing(missing: string[]): void {
  if (missing.length > 0) {
    problems.push(
      'Protected files already missing at session start (not covered by the snapshot): ' +
        `${missing.join(', ')}.`,
    );
  }
}

let snapshotLine: string;
try {
  const { cleanupStateDirs, createSnapshot, loadSnapshot } = await import('../snapshot.ts');
  cleanupStateDirs(projectDir, sessionId);
  if (source === 'startup') {
    const { manifest, missing } = createSnapshot(projectDir, sessionId);
    warnMissing(missing);
    snapshotLine =
      `Protected-file snapshot taken (${Object.keys(manifest.files).length} files): ` +
      'changes to protected paths during the session are cancelled and explained.';
  } else if (loadSnapshot(projectDir, sessionId) !== null) {
    snapshotLine = 'Protected-file snapshot reused from the start of this session.';
  } else {
    const { missing } = createSnapshot(projectDir, sessionId);
    warnMissing(missing);
    problems.push('Protected-file snapshot was missing; a fresh one was taken.');
    snapshotLine = '';
  }
} catch (error) {
  problems.push(
    `Protected-file snapshot FAILED (${error instanceof Error ? error.message : String(error)}); ` +
      'the result-based check is blind for this session.',
  );
  snapshotLine = '';
}

let context = [...problems, snapshotLine].filter(Boolean).join('\n');

// Режим обслуживания по областям (b9, ADR 0009): забытое окно тише некуда —
// агент и человек должны видеть его в момент старта сессии (З11), не только
// в ручном backlog doctor. Битый файл тоже громкий: он игнорируется (защита
// полная), но присутствие мусора под именем режима — расхождение.
if (existsSync(`${projectDir}/${MAINTENANCE_FILE}`)) {
  const session = readMaintenanceSession(projectDir);
  const line =
    session === null
      ? `${MAINTENANCE_FILE} is present but unreadable/invalid — it was IGNORED, protection is fully on. Fix or remove the file (ADR 0009).`
      : `SCOPED maintenance mode is ACTIVE (task ${session.task}): ` +
        `Edit/Write to these paths is allowed for this session — ${session.paths.join(', ')}. ` +
        'Sandbox, shell writes and all other hooks remain fully protected; ' +
        'remove the file before opening the PR (ADR 0009).';
  context = context === '' ? line : `${context}\n${line}`;
}

if (context.length > 0) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: context,
      },
    }),
  );
}
