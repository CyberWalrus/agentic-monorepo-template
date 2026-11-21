import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';

export interface HookInput {
  session_id: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
  stop_hook_active?: boolean;
  source?: string;
}

export const projectDir = process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd();

/**
 * Fail-closed для прямого вызова CLI (З4, C10.1): любой необработанный сбой
 * модуля хука — exit 2 (блокирующий), а не 1 (неблокирующий). Регистрируется
 * в каждом CLI tools/hooks; адаптеры агентов дублируют обёрткой на случай
 * сбоя самой загрузки модуля.
 */
export function failClosedExit(reason: unknown): never {
  console.error(
    `hook failed closed (З4): ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
  );
  // C9.3: факт fail-closed — в журнал отказов (гейт — из HOOK_GATE_NAME).
  appendDenial(process.env['HOOK_GATE_NAME'] ?? 'unknown-hook', 'fail-closed');
  process.exit(2);
}

export interface DenialRecord {
  /** ISO-дата отказа. */
  date: string;
  /** Имя гейта/хука, который отказал. */
  gate: string;
  /** Тип причины (категория, не текст команды и не код). */
  reason: string;
}

export function journalPath(): string {
  // Пустая строка env = не задан (||, не ?? — иначе '' перебивает дефолт).
  return (
    process.env['DENIAL_JOURNAL_PATH'] ||
    join(homedir(), '.agentic-monorepo-template', 'denials.jsonl')
  );
}

/** Пишет одну строку отказа; сбои журнала не ломают отказ гейта (best-effort). */
export function appendDenial(gate: string, reason: string): void {
  try {
    const path = journalPath();
    mkdirSync(join(path, '..'), { recursive: true });
    const record: DenialRecord = { date: new Date().toISOString(), gate, reason };
    appendFileSync(path, `${JSON.stringify(record)}\n`);
  } catch {
    // Журнал — наблюдаемость, не граница: границу держит сам отказ хука.
  }
}

/** Читает журнал; отсутствующий файл — пустой список, а не ошибка. */
export function readDenials(path: string = journalPath()): DenialRecord[] {
  if (!existsSync(path)) return [];
  const records: DenialRecord[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (
        isRecord(parsed) &&
        typeof parsed['gate'] === 'string' &&
        typeof parsed['reason'] === 'string'
      ) {
        records.push({
          date: typeof parsed['date'] === 'string' ? parsed['date'] : '',
          gate: parsed['gate'],
          reason: parsed['reason'],
        });
      }
    } catch {
      // Битая строка не роняет отчёт.
    }
  }
  return records;
}

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
  if (typeof parsed['source'] === 'string') {
    input.source = parsed['source'];
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

/** Отказ хука: решение клиенту (JSON, exit 0) + факт отказа в журнал (C9.3).
 *  В журнал идёт только гейт и категория причины — не текст команды и не код. */
export function deny(gate: string, reason: string): never {
  appendDenial(gate, denyCategory(gate, reason));
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

/** Категория причины для журнала: словарь по гейтам, без содержимого команд. */
function denyCategory(gate: string, reason: string): string {
  if (gate === 'protect-paths') return 'protected-path-write';
  if (gate === 'guard-bash') {
    if (reason.includes('over the')) return 'oversized-command';
    if (reason.includes('screenshot baselines')) return 'baseline-update';
    if (reason.includes('Skipping git hooks')) return 'hooks-skip';
    if (reason.includes('Force-push')) return 'force-push';
    if (reason.includes('Destructive git')) return 'destructive-git';
    if (reason.includes('protected path')) return 'protected-path-write';
    return 'blocked-command';
  }
  return 'denied';
}
