/**
 * PreToolUse(Bash): запрет команд, которые обходят или ослабляют гейты.
 * Это подсказка агенту (З3), а не граница безопасности: границей является
 * проверка по результату и gate-integrity из доверенной базы.
 * Загружается из guard-bash.ts, который при любом сбое (включая import-time)
 * закрывает действие (exit 2).
 */
import { relative } from 'node:path';

import {
  checkoutOverwritesPaths,
  commandWords,
  repoWriteTargets,
  splitCommands,
  stripHeredocs,
  updatesSnapshots,
  withoutGitGlobalOptions,
} from '../analyze-command.ts';
import { protectionOf } from '../protected-paths.ts';
process.env['HOOK_GATE_NAME'] ??= 'guard-bash';
import { deny, failClosedExit, projectDir, readHookInput } from './lib.ts';

// Прямой вызов CLI наследует fail-closed: необработанный сбой — exit 2 (З4, C10.1).
process.on('uncaughtException', failClosedExit);
process.on('unhandledRejection', failClosedExit);

/**
 * Сверхдлинный вход не анализируем: таймаут хука пропускает команду, поэтому бюджет разбора ограничен
 * заранее — длиной входа и линейным от неё разбором (`scan` в tools/analyze-command.ts).
 */
const MAX_COMMAND_LENGTH = 64_000;

const input = await readHookInput();
const raw = typeof input.tool_input?.['command'] === 'string' ? input.tool_input['command'] : '';
const cwd = input.cwd ?? projectDir;
if (raw.length > MAX_COMMAND_LENGTH) {
  deny(
    'guard-bash',
    `Blocked command: it is ${raw.length} chars, over the ${MAX_COMMAND_LENGTH} this guard can analyze. Split it into smaller commands.`,
  );
}
const command = stripHeredocs(raw);
// `git -C <dir> push -f` правила читают как `git push -f`: глобальные опции перед подкомандой сняты (e50)
const normalized = withoutGitGlobalOptions(command);
/** Слова каждой простой команды — для правил, которым буквальной формы мало. */
const simple = splitCommands(normalized).map(commandWords);

/**
 * Правило читает команду дважды: текстом (`pattern` — командой и её нормализацией) и по словам
 * (`inWords` — каждой простой команды). Любого совпадения достаточно.
 */
const rules: { pattern: RegExp; inWords?: (words: string[]) => boolean; reason: string }[] = [
  {
    pattern:
      /visual:update|VISUAL_UPDATE=1|--update-snapshots|\b(?:vitest|playwright)\b[^|;&\n]*\s(?:-u|--update)\b/,
    // флаг обновления цельным словом: в хвосте после `--` (`pnpm test -- -u`) и в тестовом запуске без разделителя
    inWords: updatesSnapshots,
    reason:
      'Updating screenshot baselines is a human-only action. Triage the diff (skill visual-diff-triage) and fix the code.',
  },
  {
    pattern:
      /--no-verify|\bLEFTHOOK=(?:0|false|no|off)\b|\bLEFTHOOK_EXCLUDE=|\bHUSKY=(?:0|false)\b|\bcore\.hooksPath(?:\s*=|\s)|git\s+commit\b[^|;&\n]*\s-n(?=\s|$|=)/,
    reason: 'Skipping git hooks is not allowed.',
  },
  {
    pattern: /git\s+push\b[^|;&\n]*(\s-f\b|--force|\s\+\S+:)/,
    reason: 'Force-push is not allowed.',
  },
  {
    pattern: /git\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|restore\s)/,
    // `git checkout <ревизия> -- <файл>` и `<ревизия> <файл>` без `--` отбрасывают изменения файлов так же
    inWords: checkoutOverwritesPaths,
    reason: 'Destructive git commands are not allowed for agents.',
  },
];

for (const rule of rules) {
  const byPattern = rule.pattern.test(command) || rule.pattern.test(normalized);
  const byWords = simple.some((words) => rule.inWords?.(words) ?? false);
  if (byPattern || byWords) {
    deny('guard-bash', `Blocked command: ${rule.reason}`);
  }
}

for (const absolute of repoWriteTargets(command, cwd, projectDir)) {
  const path = relative(projectDir, absolute);
  if (protectionOf(path) === 'deny') {
    deny(
      'guard-bash',
      `Blocked command: it writes to the protected path "${path}" (tools/protected-paths.json).`,
    );
  }
}
