/**
 * Проводка CLI: --json отдаёт машиночитаемый список проверок со статусами
 * (критерий приёмки e4), человекочитаемый вывод называет команду исправления,
 * предупреждения не делают код выхода красным. nodeRunCommand — реальный
 * spawn: код выхода, отсутствие исполняемого и таймаут.
 */
import { describe, expect, it } from 'vitest';

import { nodeRunCommand, runCli } from './cli.ts';
import {
  CHECK_ORDER,
  type CheckId,
  type CheckOutcome,
  type PreflightEnv,
  type PreflightReport,
} from './checks.ts';

function captureIo(): { lines: string[]; io: { log: (line: string) => void } } {
  const lines: string[] = [];
  return { lines, io: { log: (line) => lines.push(line) } };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringField = (record: Record<string, unknown>, key: string): string =>
  typeof record[key] === 'string' ? record[key] : '';

const isCheckId = (value: string): value is CheckId => {
  const ids: readonly string[] = CHECK_ORDER;
  return ids.includes(value);
};

/**
 * Разбор отчёта --json через guard, а не assertion от any
 * (no-unsafe-type-assertion): бросок в хелпере падает с выводом — по образцу
 * assertOk backlog-cli.test.ts.
 */
function parseJsonReport(text: string): PreflightReport {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || typeof parsed['ok'] !== 'boolean' || !Array.isArray(parsed['checks'])) {
    throw new Error(`--json: ожидался { ok, checks }, получено: ${text.slice(0, 120)}`);
  }
  const checks = parsed['checks'].map((entry: unknown): CheckOutcome => {
    if (
      !isRecord(entry) ||
      typeof entry['id'] !== 'string' ||
      !isCheckId(entry['id']) ||
      typeof entry['ok'] !== 'boolean' ||
      typeof entry['level'] !== 'string'
    ) {
      throw new Error(`--json: проверка без id/ok/level: ${JSON.stringify(entry)}`);
    }
    return {
      id: entry['id'],
      ok: entry['ok'],
      level: entry['level'] === 'warning' ? 'warning' : 'error',
      detail: stringField(entry, 'detail'),
      problem: stringField(entry, 'problem'),
      fix: stringField(entry, 'fix'),
    };
  });
  return { ok: parsed['ok'], checks };
}

const spawnOk = (
  stdout = '',
): { code: number; stdout: string; stderr: string; missing: boolean; timedOut: boolean } => ({
  code: 0,
  stdout,
  stderr: '',
  missing: false,
  timedOut: false,
});

/** Полностью зелёное подставное окружение: все команды и файлы отвечают правильно. */
const healthyEnv: PreflightEnv = {
  root: '/irrelevant',
  platform: 'linux',
  nodeVersion: '26.13.0',
  runCommand: async (command, args) => {
    if (command === 'pnpm' && args[0] === '--version') {
      return spawnOk('12.16.1\n');
    }
    if (command === 'git' && args[0] === 'rev-parse') {
      return spawnOk('.git/hooks\n');
    }
    if (command === process.execPath && args[0] === '-e') {
      return spawnOk('/fake/chrome\n');
    }
    return spawnOk();
  },
  fileExists: (path) => path === '/fake/chrome',
  readTextFile: (path) => {
    if (path === '.nvmrc') {
      return '26\n';
    }
    if (path === 'package.json') {
      return JSON.stringify({ packageManager: 'pnpm@12.16.1' });
    }
    if (path.endsWith('/.git/hooks/pre-commit') || path.endsWith('/.git/hooks/pre-push')) {
      return '#!/bin/sh\nlefthook run\n';
    }
    return undefined;
  },
};

describe('runCli --json', () => {
  it('отдаёт список проверок со статусами и код 1 при ошибке', async () => {
    const { lines, io } = captureIo();
    const env: PreflightEnv = {
      ...healthyEnv,
      readTextFile: () => undefined, // node и pnpm красные: нет .nvmrc и package.json
    };

    const exitCode = await runCli(['--json'], env, io);

    expect(exitCode).toBe(1);
    const report = parseJsonReport(lines.join('\n'));
    expect(report.ok).toBe(false);
    expect(report.checks.length).toBe(8);
    expect(
      report.checks.every(
        (check: CheckOutcome) =>
          typeof check.id === 'string' &&
          typeof check.ok === 'boolean' &&
          (check.level === 'error' || check.level === 'warning'),
      ),
    ).toBe(true);
  });

  it('здоровое окружение — ok=true и код 0', async () => {
    const { lines, io } = captureIo();

    const exitCode = await runCli(['--json'], healthyEnv, io);

    expect(exitCode).toBe(0);
    expect(parseJsonReport(lines.join('\n')).ok).toBe(true);
  });
});

describe('runCli человекочитаемый вывод', () => {
  it('называет проблему и команду исправления', async () => {
    const { lines, io } = captureIo();

    const exitCode = await runCli([], healthyEnv, io);

    expect(exitCode).toBe(0);
    const output = lines.join('\n');
    expect(output).toContain('✓ node');
    expect(output).toContain('preflight: PASS');
  });

  it('у упавшей проверки печатает строку «исправь: …»', async () => {
    const { lines, io } = captureIo();
    const env: PreflightEnv = {
      ...healthyEnv,
      readTextFile: () => 'v24\n',
      nodeVersion: '26.13.0',
    };

    const exitCode = await runCli([], env, io);

    expect(exitCode).toBe(1);
    const output = lines.join('\n');
    expect(output).toContain('✗ node');
    expect(output).toContain('исправь: nvm use');
    expect(output).toContain('preflight: FAIL');
  });

  it('только предупреждения — код 0, но строка с ⚠ в выводе', async () => {
    const { lines, io } = captureIo();
    const env: PreflightEnv = {
      ...healthyEnv,
      fileExists: (path) => path === '/fake/chrome' || path === '.claude/settings.local.json',
    };

    const exitCode = await runCli([], env, io);

    expect(exitCode).toBe(0);
    expect(lines.join('\n')).toContain('⚠ maintenance-mode');
  });
});

describe('nodeRunCommand (реальный spawn)', () => {
  it('возвращает код выхода и stdout', async () => {
    const result = await nodeRunCommand(process.execPath, ['-e', 'console.log("ok")'], 10_000);

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('ok');
    expect(result.missing).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  it('ненулевой код выхода доходит как есть', async () => {
    const result = await nodeRunCommand(process.execPath, ['-e', 'process.exit(3)'], 10_000);

    expect(result.code).toBe(3);
  });

  it('несуществующий исполняемый помечен missing, а не кодом выхода', async () => {
    const result = await nodeRunCommand('preflight-no-such-binary-xyz', ['--version'], 10_000);

    expect(result.missing).toBe(true);
    expect(result.code).toBeNull();
  });

  it('зависшая команда убивается по таймауту', async () => {
    const result = await nodeRunCommand(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 60_000)'],
      300,
    );

    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
  });
});
