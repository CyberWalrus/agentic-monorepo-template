/**
 * Запуск внешнего процесса для evals (ADR 0016): stdin, перехват stdout/stderr,
 * таймаут с завершением по SIGTERM. Без зависимостей из node_modules — идиома
 * tools/ (как хуки агента, C10.1). Все внешние шаги раннера — установка
 * зависимостей, агент, verify — идут через эту функцию: у тестов один шов
 * для подмены любой команды (находка sanity-ревью плана C9.1).
 */
import { spawn } from 'node:child_process';

/** Лимит перехвата вывода: отчёт агента — килобайты; переполнение — усечение, не висящий процесс. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface RunResult {
  /** null — процесс убит по таймауту или аварийно завершён без кода. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; input?: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<RunResult> {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env === undefined ? process.env : { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // SIGTERM могло не хватить (агент ставит обработчики) — добиваем.
      setTimeout(() => {
        child.kill('SIGKILL');
      }, 5_000).unref();
    }, options.timeoutMs);
    timer.unref();

    const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      const sink = target === 'stdout' ? stdout : stderr;
      if (sink.length + text.length <= MAX_OUTPUT_BYTES) {
        if (target === 'stdout') {
          stdout += text;
        } else {
          stderr += text;
        }
      }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      append('stdout', chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      append('stderr', chunk);
    });

    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolveRun({ code: null, stdout, stderr: `${stderr}${error.message}`, timedOut });
    });
    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr, timedOut });
    });

    if (options.input !== undefined) {
      child.stdin.on('error', () => {
        // EPIPE при раннем выходе агента — не ошибка раннера: код процесса скажет сам.
      });
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}
