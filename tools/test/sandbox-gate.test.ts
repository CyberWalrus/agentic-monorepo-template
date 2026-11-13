/**
 * Гейт З10 (sandbox denyWrite — производный от tools/protected-paths.json, ADR 0004):
 * чекер check-sandbox-paths.ts ловит расхождение списков, откат политики
 * (enabled / allowUnsandboxedCommands / failIfUnavailable / filesystem.disabled /
 * excludedCommands), расширение allowWrite и сети, открытие учётных данных.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const repoDir = resolve(import.meta.dirname, '..', '..');
const checker = join(repoDir, 'tools', 'check-sandbox-paths.ts');

let tmp = '';
let fileCounter = 0;

afterAll(() => {
  if (tmp !== '') {
    rmSync(tmp, { recursive: true, force: true });
  }
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const PROTECTED = { deny: ['tools/**', 'perf-budgets.json'], review: [] };
const MATCHING_SETTINGS: Record<string, unknown> = {
  sandbox: {
    enabled: true,
    allowUnsandboxedCommands: false,
    failIfUnavailable: true,
    excludedCommands: [],
    filesystem: {
      denyWrite: ['perf-budgets.json', 'tools/**'],
      allowWrite: ['~/Library/pnpm/store'],
    },
    network: {
      allowLocalBinding: true,
      allowUnixSockets: ['~/.docker/run/docker.sock'],
      allowedDomains: ['registry.npmjs.org'],
    },
    credentials: {
      files: [{ path: '~/.ssh', mode: 'deny' }],
      envVars: [
        { name: 'NPM_TOKEN', mode: 'deny' },
        { name: 'GH_TOKEN', mode: 'deny' },
        { name: 'GITHUB_TOKEN', mode: 'deny' },
      ],
    },
  },
};

/** Глубокая копия эталонного конфига: форма проверяется guard-ами, не assertion-ами. */
function cloneSettings(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(JSON.stringify(MATCHING_SETTINGS));
  if (!isRecord(parsed) || !isRecord(parsed['sandbox'])) {
    throw new Error('fixture settings lost their shape');
  }
  return parsed;
}

function sandboxOf(settings: Record<string, unknown>): Record<string, unknown> {
  const sandbox = settings['sandbox'];
  if (!isRecord(sandbox)) {
    throw new Error('fixture settings lost their shape');
  }
  return sandbox;
}

function denyListOf(settings: Record<string, unknown>): string[] {
  const filesystem = sandboxOf(settings)['filesystem'];
  if (!isRecord(filesystem) || !Array.isArray(filesystem['denyWrite'])) {
    throw new Error('fixture denyWrite is not an array');
  }
  return filesystem['denyWrite'];
}

function nextPath(prefix: string): string {
  if (tmp === '') {
    tmp = mkdtempSync(join(tmpdir(), 'a2-sandbox-'));
  }
  fileCounter += 1;
  return join(tmp, `${prefix}-${fileCounter}.json`);
}

/** Готовит пару файлов (settings, protected-paths) и запускает чекер на них. */
function check(
  settings: unknown,
  protectedPaths: unknown,
): { status: number | null; output: string } {
  return checkRaw(JSON.stringify(settings), JSON.stringify(protectedPaths));
}

/** То же, но с сырым текстом: для битого JSON и форм-нарушений. */
function checkRaw(
  settingsText: string,
  protectedText: string,
): { status: number | null; output: string } {
  const settingsPath = nextPath('settings');
  const protectedPath = nextPath('protected');
  writeFileSync(settingsPath, settingsText);
  writeFileSync(protectedPath, protectedText);
  const result = spawnSync(process.execPath, [checker, settingsPath, protectedPath], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.error) {
    throw result.error;
  }
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

it('реальный конфиг репозитория соответствует protected-paths.json', () => {
  const result = spawnSync(process.execPath, [checker], { encoding: 'utf8', timeout: 30_000 });
  if (result.error) {
    throw result.error;
  }
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/matches/);
});

it('совпадающие списки проходят', () => {
  const result = check(MATCHING_SETTINGS, PROTECTED);
  expect(result.status).toBe(0);
  expect(result.output).toMatch(/matches/);
});

it('denyWrite без защищённого пути падает с перечислением', () => {
  const settings = cloneSettings();
  const list = denyListOf(settings);
  list.splice(list.indexOf('tools/**'), 1);
  const result = check(settings, PROTECTED);
  expect(result.status).toBe(1);
  expect(result.output).toContain('tools/**');
  expect(result.output).toMatch(/missing protected paths/);
});

it('лишний путь в denyWrite падает', () => {
  const settings = cloneSettings();
  denyListOf(settings).push('README.md');
  const result = check(settings, PROTECTED);
  expect(result.status).toBe(1);
  expect(result.output).toMatch(/absent from protected-paths.json/);
});

it.each([
  ['enabled', false],
  ['allowUnsandboxedCommands', true],
  ['failIfUnavailable', false],
])('откат политики %s ловится', (key, value) => {
  const settings = cloneSettings();
  sandboxOf(settings)[key] = value;
  const result = check(settings, PROTECTED);
  expect(result.status).toBe(1);
  expect(result.output).toContain(key);
});

it('filesystem.disabled и непустой excludedCommands ловятся', () => {
  const excluded = cloneSettings();
  sandboxOf(excluded)['excludedCommands'] = ['sh *'];
  const excludedResult = check(excluded, PROTECTED);
  expect(excludedResult.status).toBe(1);
  expect(excludedResult.output).toMatch(/excludedCommands/);

  const disabled = cloneSettings();
  const filesystem = sandboxOf(disabled)['filesystem'];
  if (!isRecord(filesystem)) {
    throw new Error('fixture settings lost their shape');
  }
  filesystem['disabled'] = true;
  const disabledResult = check(disabled, PROTECTED);
  expect(disabledResult.status).toBe(1);
  expect(disabledResult.output).toMatch(/file isolation stays on/);
});

it('расширение allowWrite и открытие сокетов/доменов ловятся', () => {
  const widened = cloneSettings();
  const wideFilesystem = sandboxOf(widened)['filesystem'];
  if (!isRecord(wideFilesystem)) {
    throw new Error('fixture settings lost their shape');
  }
  wideFilesystem['allowWrite'] = ['~/Library/pnpm/store', '~/.turbo'];
  const write = check(widened, PROTECTED);
  expect(write.status).toBe(1);
  expect(write.output).toMatch(/allowWrite must be exactly/);

  const allSockets = cloneSettings();
  sandboxOf(allSockets)['network'] = {
    allowLocalBinding: true,
    allowAllUnixSockets: true,
    allowedDomains: ['registry.npmjs.org'],
  };
  const sockets = check(allSockets, PROTECTED);
  expect(sockets.status).toBe(1);
  expect(sockets.output).toMatch(/docker\.sock reopens host writes/);

  const wideDomains = cloneSettings();
  sandboxOf(wideDomains)['network'] = {
    allowLocalBinding: true,
    allowUnixSockets: ['~/.docker/run/docker.sock'],
    allowedDomains: ['registry.npmjs.org', 'github.com'],
  };
  const domains = check(wideDomains, PROTECTED);
  expect(domains.status).toBe(1);
  expect(domains.output).toMatch(/allowedDomains must be exactly/);
});

it('открытие учётных данных ловится', () => {
  const noSsh = cloneSettings();
  sandboxOf(noSsh)['credentials'] = { files: [], envVars: [] };
  const ssh = check(noSsh, PROTECTED);
  expect(ssh.status).toBe(1);
  expect(ssh.output).toMatch(/credentials\.files must be exactly/);

  const noToken = cloneSettings();
  const credentials = sandboxOf(noToken)['credentials'];
  if (!isRecord(credentials) || !Array.isArray(credentials['envVars'])) {
    throw new Error('fixture credentials lost their shape');
  }
  credentials['envVars'] = credentials['envVars'].filter(
    (item) => !(isRecord(item) && item['name'] === 'NPM_TOKEN'),
  );
  const tokens = check(noToken, PROTECTED);
  expect(tokens.status).toBe(1);
  expect(tokens.output).toMatch(/credentials\.envVars must be exactly/);
});

it('ослабленный mode у учётных данных ловится как лишняя запись', () => {
  const widened = cloneSettings();
  const credentials = sandboxOf(widened)['credentials'];
  if (!isRecord(credentials) || !Array.isArray(credentials['files'])) {
    throw new Error('fixture credentials lost their shape');
  }
  credentials['files'] = [
    { path: '~/.ssh', mode: 'deny' },
    { path: '~/.aws', mode: 'deny' },
  ];
  const result = check(widened, PROTECTED);
  expect(result.status).toBe(1);
  expect(result.output).toMatch(/credentials\.files must be exactly/);
});

it.each([
  ['settings без блока sandbox', '{}', JSON.stringify(PROTECTED), /no "sandbox" block/],
  ['settings не объект', '[]', JSON.stringify(PROTECTED), /expected an object/],
  ['protected не JSON', JSON.stringify(MATCHING_SETTINGS), '{nope', /not valid JSON/],
  [
    'protected deny не массив',
    JSON.stringify(MATCHING_SETTINGS),
    '{"deny": "x"}',
    /"deny" must be an array/,
  ],
  [
    'filesystem без denyWrite',
    JSON.stringify({
      sandbox: {
        enabled: true,
        allowUnsandboxedCommands: false,
        failIfUnavailable: true,
        excludedCommands: [],
        filesystem: { allowWrite: [] },
        network: { allowLocalBinding: true, allowUnixSockets: [], allowedDomains: [] },
        credentials: { files: [], envVars: [] },
      },
    }),
    JSON.stringify(PROTECTED),
    /denyWrite must be an array of strings/,
  ],
  [
    'network не объект',
    JSON.stringify({
      sandbox: {
        enabled: true,
        allowUnsandboxedCommands: false,
        failIfUnavailable: true,
        excludedCommands: [],
        filesystem: {
          denyWrite: ['tools/**'],
          allowWrite: ['~/Library/pnpm/store'],
        },
        credentials: { files: [{ path: '~/.ssh', mode: 'deny' }], envVars: [] },
      },
    }),
    JSON.stringify(PROTECTED),
    /network must be an object/,
  ],
  [
    'credentials не объект',
    JSON.stringify({
      sandbox: {
        enabled: true,
        allowUnsandboxedCommands: false,
        failIfUnavailable: true,
        excludedCommands: [],
        filesystem: {
          denyWrite: ['tools/**'],
          allowWrite: ['~/Library/pnpm/store'],
        },
        network: { allowLocalBinding: true, allowUnixSockets: [], allowedDomains: [] },
      },
    }),
    JSON.stringify(PROTECTED),
    /credentials must be an object/,
  ],
])('форма конфига: %s — падает', (_name, settingsText, protectedText, pattern) => {
  const result = checkRaw(settingsText, protectedText);
  expect(result.status).toBe(1);
  expect(result.output).toMatch(pattern);
});

it('битый JSON settings падает', () => {
  const result = checkRaw('{nope', JSON.stringify(PROTECTED));
  expect(result.status).toBe(1);
  expect(result.output).toMatch(/not valid JSON/);
});
