/**
 * PreToolUse(Bash): запрет команд, которые обходят или ослабляют гейты.
 * Это подсказка агенту (З3), а не граница безопасности: границей является
 * проверка по результату и gate-integrity из доверенной базы.
 * Загружается из guard-bash.ts, который при любом сбое (включая import-time)
 * закрывает действие (exit 2).
 */
import { relative } from 'node:path';

import { repoWriteTargets, stripHeredocs } from '../../tools/analyze-command.ts';
import { protectionOf } from '../../tools/protected-paths.ts';
import { deny, projectDir, readHookInput } from './lib.ts';

/** Сверхдлинный вход не анализируем: разбор heredoc квадратичен, а таймаут хука пропускает команду. */
const MAX_COMMAND_LENGTH = 64_000;

const input = await readHookInput();
const raw = typeof input.tool_input?.['command'] === 'string' ? input.tool_input['command'] : '';
const cwd = input.cwd ?? projectDir;
if (raw.length > MAX_COMMAND_LENGTH) {
  deny(
    `Blocked command: it is ${raw.length} chars, over the ${MAX_COMMAND_LENGTH} this guard can analyze. Split it into smaller commands.`,
  );
}
const command = stripHeredocs(raw);

const rules: { pattern: RegExp; reason: string }[] = [
  {
    pattern:
      /visual:update|VISUAL_UPDATE=1|--update-snapshots|\b(?:vitest|playwright)\b[^|;&\n]*\s(?:-u|--update)\b/,
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
    reason: 'Destructive git commands are not allowed for agents.',
  },
];

for (const rule of rules) {
  if (rule.pattern.test(command)) {
    deny(`Blocked command: ${rule.reason}`);
  }
}

for (const absolute of repoWriteTargets(command, cwd, projectDir)) {
  const path = relative(projectDir, absolute);
  if (protectionOf(path) === 'deny') {
    deny(
      `Blocked command: it writes to the protected path "${path}" (tools/protected-paths.json).`,
    );
  }
}
