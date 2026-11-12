import { relative } from 'node:path';

export interface HookInput {
  session_id: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
  stop_hook_active?: boolean;
}

export const projectDir = process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Ручная валидация вместо zod: хуки агента не имеют права зависеть от node_modules,
 * иначе без зависимостей они падают с кодом 1, который считается неблокирующей ошибкой.
 * Битый вход → throw: вызывающий хук обязан закрыться (exit 2), а не пропустить действие.
 */
export async function readHookInput(): Promise<HookInput> {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += String(chunk);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || '{}');
  } catch {
    throw new Error('hook input is not valid JSON');
  }
  if (!isRecord(parsed)) {
    throw new Error('hook input is not an object');
  }
  const input: HookInput = { session_id: 'unknown' };
  if (typeof parsed['session_id'] === 'string') {
    input.session_id = parsed['session_id'];
  }
  if (typeof parsed['hook_event_name'] === 'string') {
    input.hook_event_name = parsed['hook_event_name'];
  }
  if (typeof parsed['tool_name'] === 'string') {
    input.tool_name = parsed['tool_name'];
  }
  if (isRecord(parsed['tool_input'])) {
    input.tool_input = parsed['tool_input'];
  }
  if (typeof parsed['cwd'] === 'string') {
    input.cwd = parsed['cwd'];
  }
  if (typeof parsed['stop_hook_active'] === 'boolean') {
    input.stop_hook_active = parsed['stop_hook_active'];
  }
  return input;
}

/** Путь файла из tool_input относительно корня репозитория (или null, если файла нет / он вне репо). */
export function targetFile(input: HookInput): string | null {
  const value = input.tool_input?.['file_path'] ?? input.tool_input?.['notebook_path'];
  if (typeof value !== 'string') {
    return null;
  }
  const rel = relative(projectDir, value);
  return rel.startsWith('..') ? null : rel;
}

export function deny(reason: string): never {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}
