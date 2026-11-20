/**
 * Агентный адаптер evals (ADR 0016): сборка команды headless-агента и разбор
 * его результата. Vendor-умолчание — Claude Code (`claude -p --output-format
 * json`, промпт через stdin); новый агент — новый пресет + парсер, раннер
 * метрик не привязывает к одному вендору (vision, «Проблема», п. 5).
 * Метрики — из финального JSON агента; доверие к ним ограничено: pass раннер
 * считает сам запуском verify (run.ts), а не самоотчётом агента.
 */
import { type runProcess, type RunResult } from './exec.ts';

/** Время wall-clock вокруг агента считает раннер; это — собственный замер CLI (диагностика расхождения). */
export interface AgentMetrics {
  iterations: number | null;
  tokens: number | null;
  cliTimeMs: number | null;
  model: string | null;
  isError: boolean;
  resultText: string;
}

export interface AgentPreset {
  command: string;
  args: string[];
}

const CLAUDE_PRESET: AgentPreset = {
  command: 'claude',
  args: ['-p', '--output-format', 'json', '--dangerously-skip-permissions'],
};

/** Именованные пресеты агентов; `--agent-command` подменяет команду целиком. */
export const AGENT_PRESETS: Record<string, AgentPreset> = {
  claude: CLAUDE_PRESET,
};

export function buildAgentInvocation(
  presetName: string,
  model?: string,
): {
  command: string;
  args: string[];
} {
  const preset = AGENT_PRESETS[presetName];
  if (preset === undefined) {
    throw new Error(
      `неизвестный агент «${presetName}»: известны ${Object.keys(AGENT_PRESETS).join(', ')}`,
    );
  }
  return {
    command: preset.command,
    args: model === undefined ? [...preset.args] : [...preset.args, '--model', model],
  };
}

/**
 * Разбор финального JSON Claude Code (`-p --output-format json` печатает
 * массив сообщений [system, assistant, result] — берём последний элемент с
 * type: 'result'; одиночный объект результата тоже принимается). Шум до/после
 * JSON (предупреждения CLI) переживает поиск внешних скобок.
 */
export function parseAgentResult(run: RunResult): AgentMetrics {
  const text = run.stdout.trim();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) {
      const tail = run.stderr.trim().slice(-200);
      throw new Error(`агент не вернул JSON-результат${tail === '' ? '' : `; stderr: ${tail}`}`);
    }
    try {
      payload = JSON.parse(text.slice(start, end + 1));
    } catch {
      throw new Error('агент вернул вывод, не разбираемый как JSON результата');
    }
  }
  const record = Array.isArray(payload)
    ? payload.findLast((item) => isRecord(item) && item['type'] === 'result')
    : payload;
  if (!isRecord(record)) {
    throw new Error('в выводе агента нет результата (type: result)');
  }
  return {
    iterations: numberOrNull(record['num_turns']),
    tokens: usageTotal(record['usage']),
    cliTimeMs: numberOrNull(record['duration_ms']),
    model: typeof record['model'] === 'string' ? record['model'] : null,
    isError: record['is_error'] === true,
    resultText: typeof record['result'] === 'string' ? record['result'] : '',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Канонические поля расхода токенов: вход, выход и оба кэша. Прочие поля и
 * вложенные объекты usage (детали.reasoning, server_tool_use, служебные
 * метки) в сумму не входят — иначе одно и то же считалось бы дважды.
 */
const USAGE_TOKEN_KEYS = [
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
] as const;

function usageTotal(usage: unknown): number | null {
  if (!isRecord(usage)) {
    return null;
  }
  let total = 0;
  let seen = false;
  for (const key of USAGE_TOKEN_KEYS) {
    const value = usage[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      total += value;
      seen = true;
    }
  }
  return seen ? total : null;
}

/** Версия CLI агента — для отчёта сопоставимости (два прогона с одной версией). */
export async function agentVersion(
  command: string,
  cwd: string,
  runCli: typeof runProcess,
): Promise<string | null> {
  const run = await runCli(command, ['--version'], { cwd, timeoutMs: 15_000 });
  if (run.code !== 0) {
    return null;
  }
  const first = run.stdout.split('\n')[0]?.trim() ?? '';
  return first === '' ? null : first;
}
