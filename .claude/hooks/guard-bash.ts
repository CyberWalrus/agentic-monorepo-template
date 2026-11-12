/** PreToolUse(Bash): запрет команд, которые обходят или ослабляют гейты. */
import { isAbsolute, relative, resolve } from 'node:path';

import { protectionOf } from '../../tools/protected-paths.ts';
import { deny, projectDir, readHookInput } from './lib.ts';

const input = await readHookInput();
const raw = typeof input.tool_input?.['command'] === 'string' ? input.tool_input['command'] : '';
const cwd = typeof input['cwd'] === 'string' ? input['cwd'] : projectDir;

// Тела heredoc — это данные (текст файла), а не команды: не проверяем их.
const command = raw.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\n|$)/g, '<<HEREDOC');

const rules: { pattern: RegExp; reason: string }[] = [
  {
    pattern:
      /visual:update|VISUAL_UPDATE=1|--update-snapshots|\bvitest\b[^|;&\n]*\s(-u|--update)\b/,
    reason:
      'Updating screenshot baselines is a human-only action. Triage the diff (skill visual-diff-triage) and fix the code.',
  },
  {
    pattern: /--no-verify|\bLEFTHOOK=0\b|\bHUSKY=0\b/,
    reason: 'Skipping git hooks is not allowed.',
  },
  { pattern: /git\s+push\b[^|;&\n]*(\s-f\b|--force)/, reason: 'Force-push is not allowed.' },
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

/** Простая токенизация с учётом кавычек: достаточно для поиска путей-целей записи. */
function tokenize(segment: string): string[] {
  return [...segment.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');
}

/** Пути, в которые команда пишет (или которые удаляет/перемещает). */
function writeTargets(segment: string): string[] {
  const targets: string[] = [];
  for (const match of segment.matchAll(/(?:^|[^0-9&<>])>{1,2}\s*([^\s;&|<>]+)/g)) {
    const target = match[1] ?? '';
    if (!target.startsWith('&') && target !== '/dev/null') {
      targets.push(target);
    }
  }
  const tokens = tokenize(segment.replace(/\d?>{1,2}\s*\S+/g, ' '));
  const args = (from: number) => tokens.slice(from).filter((t) => !t.startsWith('-'));
  const index = tokens.findIndex((t) => /^(sed|tee|mv|cp|rm|truncate|ln|install)$/.test(t));
  if (index === -1) {
    return targets;
  }
  const tool = tokens[index];
  const rest = args(index + 1);
  if (tool === 'sed' && tokens.some((t) => t.startsWith('-i'))) {
    targets.push(...rest.slice(1));
  } else if (tool === 'cp' || tool === 'ln' || tool === 'install') {
    targets.push(...rest.slice(-1));
  } else if (tool === 'tee' || tool === 'mv' || tool === 'rm' || tool === 'truncate') {
    targets.push(...rest);
  }
  return targets;
}

const segments = command.split(/&&|\|\||[;|\n]/);
for (const segment of segments) {
  for (const target of writeTargets(segment)) {
    const absolute = isAbsolute(target) ? target : resolve(cwd, target);
    const path = relative(projectDir, absolute);
    if (!path.startsWith('..') && protectionOf(path) === 'deny') {
      deny(
        `Blocked command: it writes to the protected path "${path}" (tools/protected-paths.json).`,
      );
    }
  }
}
