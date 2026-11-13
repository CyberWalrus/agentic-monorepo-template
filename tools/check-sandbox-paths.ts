/**
 * Гейт З10: список `sandbox.filesystem.denyWrite` в песочнице агента производный
 * от `tools/protected-paths.json` — два источника одной границы недопустимы.
 * Заодно закрепляет политику песочницы на решённых в ADR 0004 значениях:
 * включена, без выхода из песочницы (strict, без excludedCommands и
 * filesystem.disabled), fail-closed на машинах без Seatbelt/bubblewrap,
 * allowWrite и сеть не шире необходимого, доступ к учётным данным закрыт.
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

/** Списки сверяются как множества строк: порядок в JSON не должен влиять на гейт. */
function sameSet(left: string[], right: string[]): boolean {
  return JSON.stringify(left.toSorted()) === JSON.stringify(right.toSorted());
}

/** Записи credentials нормализуются к строкам «target:mode» для сравнения множеств. */
function credentialSet(entries: unknown, key: 'path' | 'name'): string[] | null {
  if (!Array.isArray(entries)) {
    return null;
  }
  const list: string[] = [];
  for (const item of entries) {
    if (!isRecord(item)) {
      return null;
    }
    const target = item[key];
    const mode = item['mode'];
    if (typeof target !== 'string' || typeof mode !== 'string') {
      return null;
    }
    list.push(`${target}:${mode}`);
  }
  return list;
}

const ADR = {
  allowWrite: ['~/Library/pnpm/store'],
  allowUnixSockets: ['~/.docker/run/docker.sock'],
  allowedDomains: ['registry.npmjs.org'],
  credentialFiles: ['~/.ssh:deny'],
  credentialEnv: ['GH_TOKEN:deny', 'GITHUB_TOKEN:deny', 'NPM_TOKEN:deny'],
};

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
  const excluded = sandbox['excludedCommands'];
  const excludedList = excluded === undefined ? [] : stringArray(excluded);
  if (excludedList === null || excludedList.length > 0) {
    problems.push('sandbox.excludedCommands must be absent or empty (no out-of-sandbox commands)');
  }
  const filesystem = isRecord(sandbox['filesystem']) ? sandbox['filesystem'] : null;
  const denyWrite = filesystem !== null ? stringArray(filesystem['denyWrite']) : null;
  if (filesystem === null) {
    problems.push('sandbox.filesystem must be an object');
  } else {
    if (denyWrite === null) {
      problems.push('sandbox.filesystem.denyWrite must be an array of strings');
    }
    if (filesystem['disabled'] === true) {
      problems.push('sandbox.filesystem.disabled must not be true (file isolation stays on)');
    }
    const allowWrite = stringArray(filesystem['allowWrite']);
    if (allowWrite === null || !sameSet(allowWrite, ADR.allowWrite)) {
      problems.push(
        `sandbox.filesystem.allowWrite must be exactly ${JSON.stringify(ADR.allowWrite)} (ADR 0004)`,
      );
    }
  }
  const network = isRecord(sandbox['network']) ? sandbox['network'] : null;
  if (network === null) {
    problems.push('sandbox.network must be an object');
  } else {
    if (network['allowLocalBinding'] !== true) {
      problems.push('sandbox.network.allowLocalBinding must be true (e2e dev servers)');
    }
    if (network['allowAllUnixSockets'] === true) {
      problems.push(
        'sandbox.network.allowAllUnixSockets must not be true (docker.sock reopens host writes, ADR 0004)',
      );
    }
    const sockets = stringArray(network['allowUnixSockets']);
    if (sockets === null || !sameSet(sockets, ADR.allowUnixSockets)) {
      problems.push(
        `sandbox.network.allowUnixSockets must be exactly ${JSON.stringify(ADR.allowUnixSockets)} (ADR 0004)`,
      );
    }
    const domains = stringArray(network['allowedDomains']);
    if (domains === null || !sameSet(domains, ADR.allowedDomains)) {
      problems.push(
        `sandbox.network.allowedDomains must be exactly ${JSON.stringify(ADR.allowedDomains)} (ADR 0004)`,
      );
    }
  }
  const credentials = isRecord(sandbox['credentials']) ? sandbox['credentials'] : null;
  if (credentials === null) {
    problems.push('sandbox.credentials must be an object (ADR 0004)');
  } else {
    // Учётные данные закреплены как точные множества: лишняя запись с другим
    // target/mode — то же тихое расширение границы, что лишний путь в allowWrite.
    const files = credentialSet(credentials['files'], 'path');
    if (files === null || !sameSet(files, ADR.credentialFiles)) {
      problems.push(
        `sandbox.credentials.files must be exactly ${JSON.stringify(ADR.credentialFiles)} (ADR 0004)`,
      );
    }
    const envVars = credentialSet(credentials['envVars'], 'name');
    if (envVars === null || !sameSet(envVars, ADR.credentialEnv)) {
      problems.push(
        `sandbox.credentials.envVars must be exactly ${JSON.stringify(ADR.credentialEnv)} (ADR 0004)`,
      );
    }
  }
  const protectedRaw: unknown = readJsonFile(protectedPath);
  const source = isRecord(protectedRaw) ? stringArray(protectedRaw['deny']) : null;
  if (protectedRaw !== null && source === null) {
    problems.push(`${protectedPath}: "deny" must be an array of strings`);
  }
  if (denyWrite !== null && source !== null) {
    const missing = source.filter((item) => !denyWrite.includes(item));
    const extra = denyWrite.filter((item) => !source.includes(item));
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
