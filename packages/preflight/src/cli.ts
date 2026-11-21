/**
 * CLI `pnpm preflight` (задача e4): проверка окружения с объяснением.
 *
 *   pnpm preflight          человекочитаемый отчёт
 *   pnpm preflight --json   машиночитаемый ({ ok, checks })
 *
 * Не гейт: в verify не входит и ничего не блокирует. Проверки — checks.ts;
 * здесь проводка: реальные spawn/файлы, разбор флагов, вывод и код выхода.
 * Проверки идут параллельно (nodeRunCommand асинхронный) — на исправном
 * окружении команда зелёная меньше чем за секунду.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  runPreflight,
  type CheckOutcome,
  type CommandResult,
  type PreflightEnv,
  type RunCommand,
} from './checks.ts';

/**
 * spawn без shell: аргументы не проходят через интерпретатор. Вывод
 * деколорируется, чтобы --json не ломался escape-последовательностями.
 */
export const nodeRunCommand: RunCommand = (command, args, timeoutMs, cwd) =>
  new Promise<CommandResult>((resolvePromise) => {
    let settled = false;
    let timedOut = false;
    const finish = (result: CommandResult): void => {
      if (!settled) {
        settled = true;
        resolvePromise(result);
      }
    };
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      finish({
        code: null,
        stdout,
        stderr: `${stderr}${String(error)}`,
        missing: error.code === 'ENOENT',
        timedOut,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ code, stdout, stderr, missing: false, timedOut });
    });
  });

export function realPreflightEnv(root: string): PreflightEnv {
  return {
    root,
    platform: process.platform,
    nodeVersion: process.versions.node,
    runCommand: nodeRunCommand,
    fileExists: (path) => existsSync(resolve(root, path)),
    readTextFile: (path) => {
      try {
        return readFileSync(resolve(root, path), 'utf8');
      } catch {
        return undefined;
      }
    },
  };
}

export interface PreflightIo {
  log: (line: string) => void;
}

// stdout.write, а не console.log: no-console в packages/** разрешает только
// warn/error, а отчёт — обычный stdout-вывод (verify печатает так же).
const consoleIo: PreflightIo = { log: (line) => process.stdout.write(`${line}\n`) };

function mark(check: CheckOutcome): string {
  if (check.ok) {
    return '✓';
  }
  return check.level === 'warning' ? '⚠' : '✗';
}

function formatHuman(report: { ok: boolean; checks: CheckOutcome[] }, io: PreflightIo): void {
  for (const check of report.checks) {
    io.log(`  ${mark(check)} ${check.id} — ${check.ok ? check.detail : check.problem}`);
    if (!check.ok && check.fix !== '') {
      io.log(`      → исправь: ${check.fix}`);
    }
  }
  const failed = report.checks.filter((check) => !check.ok);
  const summary = report.ok
    ? `PASS — ${report.checks.length} проверок зелёные`
    : `FAIL — ${failed.length} из ${report.checks.length} проверок требуют внимания`;
  io.log(`\npreflight: ${summary}`);
}

/** Возвращает код выхода: 0 — error-проверки зелёные, предупреждения не считаются. */
export async function runCli(argv: string[], env: PreflightEnv, io: PreflightIo): Promise<number> {
  const report = await runPreflight(env);
  if (argv.includes('--json')) {
    io.log(JSON.stringify(report, null, 2));
  } else {
    formatHuman(report, io);
  }
  return report.ok ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  // dirname — packages/preflight/src: три уровня вверх до корня репозитория.
  const root = resolve(import.meta.dirname, '..', '..', '..');
  process.exitCode = await runCli(process.argv.slice(2), realPreflightEnv(root), consoleIo);
}
