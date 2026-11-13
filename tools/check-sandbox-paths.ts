/**
 * Гейт З10: список `sandbox.filesystem.denyWrite` в песочнице агента производный
 * от `tools/protected-paths.json` — два источника одной границы недопустимы.
 * Заодно проверяет зафиксированную политику песочницы: включена, без выхода
 * из песочницы, fail-closed на машинах без Seatbelt/bubblewrap (ADR 0004).
 * Аргументы (пути к settings и protected-paths) — для тестов; по умолчанию репозиторий.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const problems: string[] = [];

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    problems.push(
      `${path}: not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
}

const repoSettings = fileURLToPath(new URL('../.claude/settings.json', import.meta.url));
const repoProtected = fileURLToPath(new URL('./protected-paths.json', import.meta.url));
const settingsPath = process.argv[2] ?? repoSettings;
const protectedPath = process.argv[3] ?? repoProtected;

const rawSettings: unknown = readJsonFile(settingsPath);
const settings = isRecord(rawSettings) ? rawSettings : null;
if (rawSettings !== null && settings === null) {
  problems.push(`${settingsPath}: expected an object`);
}

const sandbox = settings !== null && isRecord(settings['sandbox']) ? settings['sandbox'] : null;
if (settings !== null && sandbox === null) {
  problems.push(`${settingsPath}: no "sandbox" block`);
}
if (sandbox !== null) {
  if (sandbox['enabled'] !== true) {
    problems.push('sandbox.enabled must be true (ADR 0004)');
  }
  if (sandbox['allowUnsandboxedCommands'] !== false) {
    problems.push('sandbox.allowUnsandboxedCommands must be false (strict mode, ADR 0004)');
  }
  if (sandbox['failIfUnavailable'] !== true) {
    problems.push('sandbox.failIfUnavailable must be true (fail-closed, З4)');
  }
  const filesystem = isRecord(sandbox['filesystem']) ? sandbox['filesystem'] : null;
  const denyWrite = filesystem !== null ? stringArray(filesystem['denyWrite']) : null;
  if (filesystem === null) {
    problems.push('sandbox.filesystem must be an object');
  } else if (denyWrite === null) {
    problems.push('sandbox.filesystem.denyWrite must be an array of strings');
  }
  const protectedRaw: unknown = readJsonFile(protectedPath);
  const source = isRecord(protectedRaw) ? stringArray(protectedRaw['deny']) : null;
  if (protectedRaw !== null && source === null) {
    problems.push(`${protectedPath}: "deny" must be an array of strings`);
  }
  if (denyWrite !== null && source !== null) {
    const left = denyWrite.toSorted();
    const right = source.toSorted();
    const missing = right.filter((item) => !left.includes(item));
    const extra = left.filter((item) => !right.includes(item));
    if (missing.length > 0) {
      problems.push(`denyWrite is missing protected paths: ${missing.join(', ')}`);
    }
    if (extra.length > 0) {
      problems.push(`denyWrite has paths absent from protected-paths.json: ${extra.join(', ')}`);
    }
  }
}

if (problems.length > 0) {
  console.error(
    `sandbox config does not match tools/protected-paths.json (З10):\n- ${problems.join('\n- ')}`,
  );
  process.exit(1);
}
console.log('sandbox: denyWrite matches tools/protected-paths.json');
