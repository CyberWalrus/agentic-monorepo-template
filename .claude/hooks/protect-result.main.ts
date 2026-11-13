/**
 * Проверка по результату: сверка защищённых файлов со снимком начала сессии
 * (roadmap A2 пункт 1, ADR 0003). Изменение отменяется возвратом к снимку и
 * объясняется агенту; дрейф, совпавший с новым HEAD (pull/merge), перебазирует
 * снимок; новые файлы под deny только сообщаются и не удаляются (артефакты
 * триажа в __screenshots__, settings.local.json создаёт сам Claude Code).
 * Отсутствие снимка не притворяется успехом — сообщается как слепая проверка.
 */
import { projectDir, readHookInput } from './lib.ts';
import { reconcile } from '../../tools/snapshot.ts';

const input = await readHookInput();
const isStop = input.hook_event_name === 'Stop';
const outcome = reconcile(projectDir, input.session_id);

if (outcome.kind === 'missing') {
  console.log(
    JSON.stringify({
      systemMessage:
        'Result check is blind: the protected-file snapshot is missing or unreadable. ' +
        'Protected paths may have been changed without detection in this session.',
    }),
  );
  process.exit(0);
}
if (outcome.kind === 'broken') {
  // Никакой сверки и отката по ненадёжному state. Exit 0 (не 2): Stop с блоком
  // на каждый ход без изменения состояния — livelock; громкое сообщение честнее.
  console.log(
    JSON.stringify({
      systemMessage:
        `Result check cannot proceed: ${outcome.detail}. ` +
        'Protected files may have been changed without a trustworthy comparison. ' +
        'Do not touch protected paths; restart the session to take a fresh snapshot.',
    }),
  );
  process.exit(0);
}

const parts: string[] = [];
for (const path of outcome.restored) {
  parts.push(
    `${path} is a protected quality gate; the change was CANCELLED and the file was restored ` +
      'to the session-start snapshot. Gates are changed by humans only ' +
      '(tools/protected-paths.json).',
  );
}
for (const path of outcome.rebased) {
  parts.push(
    `${path} now matches the new HEAD, so the snapshot was rebased to it ` +
      '(a legitimate pull/merge brought the change; nothing was undone).',
  );
}
for (const path of outcome.dropped) {
  parts.push(`${path} no longer exists in HEAD; it was dropped from the snapshot.`);
}
if (outcome.created.length > 0) {
  parts.push(
    `New files appeared under protected paths (reported, not touched): ` +
      `${outcome.created.join(', ')}.`,
  );
}

if (parts.length === 0) {
  process.exit(0);
}

const message = parts.join('\n');
if (isStop) {
  if (outcome.restored.length > 0) {
    console.log(
      JSON.stringify({
        decision: 'block',
        reason:
          'Protected files were modified during the session; the hook restored them to the ' +
          'session-start snapshot. Review what happened before finishing.\n\n' +
          message,
      }),
    );
  } else {
    console.log(JSON.stringify({ systemMessage: message }));
  }
} else {
  console.log(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: message },
    }),
  );
}
