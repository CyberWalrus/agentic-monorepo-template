/**
 * Сообщения проверок preflight на подставном окружении: неверная версия Node,
 * отсутствующие хуки и недоступный Docker дают каждое своё сообщение с командой
 * исправления (критерии приёмки e4). Реальный spawn проверен отдельно
 * (nodeRunCommand в cli.test.ts); здесь команды и файлы — фикстуры, поэтому
 * тесты не зависят от Docker и Chromium машины.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CHECK_ORDER,
  runPreflight,
  type CheckId,
  type CheckOutcome,
  type CommandResult,
  type PreflightEnv,
  type RunCommand,
} from './checks.ts';

interface Handler {
  matches: (command: string, args: string[]) => boolean;
  result: Partial<CommandResult>;
}

/** Строгий фейк: вызов без подходящего обработчика роняет тест (З11). */
function fakeRunner(handlers: Handler[]): RunCommand {
  return async (command, args) => {
    const handler = handlers.find((candidate) => candidate.matches(command, args));
    if (handler === undefined) {
      throw new Error(`unexpected command in test: ${command} ${args.join(' ')}`);
    }
    return { code: 0, stdout: '', stderr: '', missing: false, timedOut: false, ...handler.result };
  };
}

function healthyHandlers(root: string): Handler[] {
  return [
    { matches: (c, a) => c === 'pnpm' && a[0] === '--version', result: { stdout: '12.16.1\n' } },
    {
      matches: (c, a) => c === 'pnpm' && a[0] === 'install' && a.includes('--frozen-lockfile'),
      result: { code: 0 },
    },
    {
      matches: (c, a) => c === 'git' && a[0] === 'rev-parse',
      result: { code: 0, stdout: '.git/hooks\n' },
    },
    { matches: (c) => c === 'docker', result: { code: 0 } },
    {
      matches: (c, a) => c === process.execPath && a[0] === '-e',
      result: { code: 0, stdout: `${join(root, 'chromium-fake')}\n` },
    },
    { matches: (c) => c === 'gh', result: { code: 0 } },
  ];
}

const roots: string[] = [];

/** Временный корень с манифестом, .nvmrc и установленными хуками Lefthook. */
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'preflight-checks-'));
  roots.push(root);
  writeFileSync(join(root, '.nvmrc'), '26\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@12.16.1' }));
  mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
  for (const hook of ['pre-commit', 'pre-push']) {
    writeFileSync(join(root, '.git', 'hooks', hook), `#!/bin/sh\nlefthook run ${hook}\n`);
  }
  return root;
}

function envFor(root: string, overrides: Partial<PreflightEnv>): PreflightEnv {
  return {
    root,
    platform: 'linux',
    nodeVersion: '26.13.0',
    runCommand: fakeRunner(healthyHandlers(root)),
    fileExists: (path) => path === join(root, 'chromium-fake'),
    readTextFile: (path) => {
      try {
        return readFileSync(resolve(root, path), 'utf8');
      } catch {
        return undefined;
      }
    },
    ...overrides,
  };
}

/** Подмена отдельных команд поверх здорового набора: остальные проверки живут. */
function envWithCommands(root: string, replacements: Handler[]): PreflightEnv {
  return envFor(root, { runCommand: fakeRunner([...replacements, ...healthyHandlers(root)]) });
}

const only = (command: string, result: Partial<CommandResult>): Handler => ({
  matches: (c) => c === command,
  result,
});

const onlyPnpmVersion = (result: Partial<CommandResult>): Handler => ({
  matches: (c, a) => c === 'pnpm' && a[0] === '--version',
  result,
});

const onlyFrozenInstall = (result: Partial<CommandResult>): Handler => ({
  matches: (c, a) => c === 'pnpm' && a[0] === 'install' && a.includes('--frozen-lockfile'),
  result,
});

const onlyChromium = (result: Partial<CommandResult>): Handler => ({
  matches: (c, a) => c === process.execPath && a[0] === '-e',
  result,
});

/** Бросок вместо expect: хелпер обязан вернуть проверку, иначе тест красный с выводом (З11). */
const checkById = (report: Awaited<ReturnType<typeof runPreflight>>, id: CheckId): CheckOutcome => {
  const found = report.checks.find((check) => check.id === id);
  if (found === undefined) {
    throw new Error(`проверка ${id} не выполнилась`);
  }
  return found;
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('исправное окружение', () => {
  it('все проверки зелёные, ok=true, порядок стабильный', async () => {
    const root = makeRoot();

    const report = await runPreflight(envFor(root, {}));

    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => check.id)).toEqual([...CHECK_ORDER]);
    expect(report.checks.every((check) => check.ok)).toBe(true);
    expect(report.checks.every((check) => check.fix === '')).toBe(true);
  });
});

describe('node против .nvmrc', () => {
  it('неверная версия Node даёт своё сообщение и команду nvm use', async () => {
    const root = makeRoot();

    const report = await runPreflight(envFor(root, { nodeVersion: '25.4.2' }));

    const node = checkById(report, 'node');
    expect(node.ok).toBe(false);
    expect(node.problem).toContain('25.4.2');
    expect(node.problem).toContain('.nvmrc');
    expect(node.fix).toBe('nvm use');
    expect(report.ok).toBe(false);
  });

  it('.nvmrc с полной версией требует совпадения всех названных сегментов', async () => {
    const root = makeRoot();
    writeFileSync(join(root, '.nvmrc'), 'v26.13.0\n');

    const exact = await runPreflight(envFor(root, { nodeVersion: '26.13.0' }));
    const newer = await runPreflight(envFor(root, { nodeVersion: '26.14.1' }));

    expect(checkById(exact, 'node').ok).toBe(true);
    expect(checkById(newer, 'node').ok).toBe(false);
  });

  it('отсутствующий .nvmrc — красный', async () => {
    const root = makeRoot();
    rmSync(join(root, '.nvmrc'));

    const report = await runPreflight(envFor(root, {}));

    expect(checkById(report, 'node').ok).toBe(false);
  });
});

describe('pnpm против packageManager', () => {
  it('packageManager не про pnpm — красный без команды переустановки', async () => {
    const root = makeRoot();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ packageManager: 'yarn@3.2.0' }));

    const report = await runPreflight(envFor(root, {}));

    const pnpm = checkById(report, 'pnpm');
    expect(pnpm.ok).toBe(false);
    expect(pnpm.problem).toContain('yarn@3.2.0');
    expect(pnpm.fix).toBe('');
  });

  it('другая версия pnpm даёт сообщение и команду установки нужной', async () => {
    const root = makeRoot();

    const report = await runPreflight(
      envWithCommands(root, [onlyPnpmVersion({ stdout: '10.4.1\n' })]),
    );

    const pnpm = checkById(report, 'pnpm');
    expect(pnpm.ok).toBe(false);
    expect(pnpm.problem).toContain('10.4.1');
    expect(pnpm.problem).toContain('pnpm@12.16.1');
    expect(pnpm.fix).toBe('npm install -g pnpm@12.16.1');
  });

  it('pnpm не найден — красный с той же командой', async () => {
    const root = makeRoot();

    const report = await runPreflight(envWithCommands(root, [onlyPnpmVersion({ missing: true })]));

    const pnpm = checkById(report, 'pnpm');
    expect(pnpm.ok).toBe(false);
    expect(pnpm.problem).toContain('PATH');
    expect(pnpm.fix).toBe('npm install -g pnpm@12.16.1');
  });
});

describe('node_modules против lockfile', () => {
  it('дрейф lockfile даёт сообщение и команду pnpm install', async () => {
    const root = makeRoot();

    const report = await runPreflight(envWithCommands(root, [onlyFrozenInstall({ code: 3 })]));

    const nodeModules = checkById(report, 'node_modules');
    expect(nodeModules.ok).toBe(false);
    expect(nodeModules.problem).toContain('--frozen-lockfile');
    expect(nodeModules.fix).toBe('pnpm install');
    expect(report.ok).toBe(false);
  });
});

describe('git-хуки Lefthook', () => {
  it('отсутствующие хуки дают сообщение и команду lefthook install', async () => {
    const root = makeRoot();
    rmSync(join(root, '.git', 'hooks'), { recursive: true, force: true });

    const report = await runPreflight(envFor(root, {}));

    const hooks = checkById(report, 'git-hooks');
    expect(hooks.ok).toBe(false);
    expect(hooks.problem).toContain('pre-commit');
    expect(hooks.problem).toContain('lefthook');
    expect(hooks.fix).toBe('pnpm exec lefthook install');
    expect(report.ok).toBe(false);
  });

  it('хук без lefthook внутри считается отсутствующим', async () => {
    const root = makeRoot();
    writeFileSync(join(root, '.git', 'hooks', 'pre-push'), '#!/bin/sh\necho other\n');

    const report = await runPreflight(envFor(root, {}));

    expect(checkById(report, 'git-hooks').ok).toBe(false);
  });
});

describe('Docker', () => {
  it('недоступный демон даёт сообщение и команду запуска', async () => {
    const root = makeRoot();

    const report = await runPreflight(envWithCommands(root, [only('docker', { code: 1 })]));

    const docker = checkById(report, 'docker');
    expect(docker.ok).toBe(false);
    expect(docker.problem).toContain('Docker');
    expect(docker.fix).toBe('sudo systemctl start docker');
    expect(report.ok).toBe(false);
  });

  it('docker не найден в PATH — команда установки', async () => {
    const root = makeRoot();

    const report = await runPreflight(envWithCommands(root, [only('docker', { missing: true })]));

    const docker = checkById(report, 'docker');
    expect(docker.ok).toBe(false);
    expect(docker.problem).toContain('PATH');
    expect(docker.fix).toBe('apt-get install docker.io');
  });

  it('на macOS команда запуска — Docker Desktop', async () => {
    const root = makeRoot();

    const report = await runPreflight({
      ...envWithCommands(root, [only('docker', { code: 1 })]),
      platform: 'darwin',
    });

    expect(checkById(report, 'docker').fix).toBe('open -a Docker');
  });
});

describe('Chromium', () => {
  it('нескачанный браузер даёт сообщение и команду playwright install', async () => {
    const root = makeRoot();

    const report = await runPreflight(envFor(root, { fileExists: () => false }));

    const chromium = checkById(report, 'chromium');
    expect(chromium.ok).toBe(false);
    expect(chromium.problem).toContain('Chromium');
    expect(chromium.fix).toBe('pnpm exec playwright install --with-deps chromium');
    expect(report.ok).toBe(false);
  });

  it('резолв @playwright/test не удался — отсылка к pnpm install', async () => {
    const root = makeRoot();

    const report = await runPreflight(envWithCommands(root, [onlyChromium({ code: 1 })]));

    const chromium = checkById(report, 'chromium');
    expect(chromium.ok).toBe(false);
    expect(chromium.problem).toContain('@playwright/test');
    expect(chromium.fix).toBe('pnpm install');
  });
});

describe('предупреждения', () => {
  it('включённый режим обслуживания — предупреждение, команду не красит', async () => {
    const root = makeRoot();
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'settings.local.json'), '{}\n');

    const report = await runPreflight(
      envFor(root, {
        fileExists: (path) =>
          path === '.claude/settings.local.json' || path === join(root, 'chromium-fake'),
      }),
    );

    const maintenance = checkById(report, 'maintenance-mode');
    expect(maintenance.ok).toBe(false);
    expect(maintenance.level).toBe('warning');
    expect(maintenance.problem).toContain('режим обслуживания');
    expect(report.ok).toBe(true);
  });

  it('gh не найден — предупреждение, не ошибка', async () => {
    const root = makeRoot();

    const report = await runPreflight(envWithCommands(root, [only('gh', { missing: true })]));

    const gh = checkById(report, 'gh');
    expect(gh.ok).toBe(false);
    expect(gh.level).toBe('warning');
    expect(gh.problem).toContain('backlog doctor');
    expect(report.ok).toBe(true);
  });

  it('gh без авторизации — команда gh auth login', async () => {
    const root = makeRoot();

    const report = await runPreflight(envWithCommands(root, [only('gh', { code: 1 })]));

    expect(checkById(report, 'gh').fix).toBe('gh auth login');
  });
});
