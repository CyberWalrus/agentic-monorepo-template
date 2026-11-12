import { relative } from 'node:path';

import * as z from 'zod';

const HookInputSchema = z.looseObject({
  session_id: z.string().default('unknown'),
  hook_event_name: z.string().optional(),
  tool_name: z.string().optional(),
  tool_input: z.record(z.string(), z.unknown()).optional(),
  stop_hook_active: z.boolean().optional(),
});

export type HookInput = z.infer<typeof HookInputSchema>;

export const projectDir = process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd();

export async function readHookInput(): Promise<HookInput> {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += String(chunk);
  }
  const parsed: unknown = JSON.parse(raw || '{}');
  return HookInputSchema.parse(parsed);
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
