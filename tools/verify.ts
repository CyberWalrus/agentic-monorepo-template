/**
 * Локальный аналог CI-гейтов. Одна команда для человека и агента.
 *
 *   pnpm verify           статика + unit (быстро, кэш turbo)
 *   pnpm verify --full    + сборка, бюджет бандла, E2E, перф-бюджеты
 *   pnpm verify --json    машиночитаемый результат (для агентов и хуков)
 *
 * Визуальные тесты сюда не входят: они идут только в Docker (`pnpm visual`).
 */
import { spawn } from 'node:child_process';

interface Step {
  name: string;
  command: string;
  args: string[];
}

interface StepResult {
  name: string;
  ok: boolean;
  durationMs: number;
  command: string;
  output: string;
}

const json = process.argv.includes('--json');
const full = process.argv.includes('--full');
const TAIL_LINES = 60;

const turbo = (task: string): Step => ({
  name: task,
  command: 'pnpm',
  args: ['turbo', 'run', task, '--output-logs=errors-only'],
});

const fast: Step[] = [
  { name: 'format', command: 'pnpm', args: ['format:check'] },
  { name: 'lint', command: 'pnpm', args: ['lint', '--format', 'agent'] },
  turbo('typecheck'),
  { name: 'typecheck:tools', command: 'pnpm', args: ['typecheck:tools'] },
  turbo('test'),
  { name: 'boundaries', command: 'pnpm', args: ['boundaries'] },
  { name: 'knip', command: 'pnpm', args: ['knip'] },
  { name: 'test-integrity', command: 'pnpm', args: ['test:integrity'] },
  { name: 'test:hooks', command: 'pnpm', args: ['test:hooks'] },
  { name: 'sandbox', command: 'pnpm', args: ['sandbox:check'] },
  { name: 'docs', command: 'pnpm', args: ['docs:check'] },
  { name: 'sherif', command: 'pnpm', args: ['sherif'] },
  { name: 'openapi', command: 'pnpm', args: ['--filter', '@repo/contracts', 'openapi:check'] },
];

// Гейт по отчёту раннера (З3, A3) идёт после тестов: отчёты существуют, только
// если тесты отработали, — иначе он проверял бы протухший кэш turbo. Корневой
// vitest (test:hooks) вне turbo, поэтому его отчёт добавляется явным --only.
const testReport: Step = {
  name: 'test-report',
  command: 'pnpm',
  args: ['test:report', '--from-turbo', 'test', '--only', 'reports/vitest-hooks.json'],
};

// Храповик числа тестов (З7, A3): warning-only, читает те же отчёты.
const testCount: Step = {
  name: 'test-count',
  command: 'pnpm',
  args: ['test:count'],
};

// E2E и перф делят порты 3000/3001, поэтому идут последовательно после быстрых шагов.
// Порядок e2e → e2e-report → perf — контракт: отчёт e2e/reports/e2e.json пишет
// любой запуск Playwright, perf его перезапишет; переставлять шаги нельзя.
const slow: Step[] = [
  turbo('build'),
  { name: 'bundle', command: 'pnpm', args: ['bundle'] },
  turbo('e2e'),
  {
    name: 'e2e-report',
    command: 'pnpm',
    args: ['test:report', '--from-turbo', 'e2e', '--expect-project', 'functional'],
  },
  turbo('perf'),
];

function run(step: Step): Promise<StepResult> {
  const started = performance.now();
  return new Promise((resolve) => {
    const child = spawn(step.command, step.args, {
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('close', (code) => {
      resolve({
        name: step.name,
        ok: code === 0,
        durationMs: Math.round(performance.now() - started),
        command: [step.command, ...step.args].join(' '),
        output: output.split('\n').slice(-TAIL_LINES).join('\n').trim(),
      });
    });
  });
}

const started = performance.now();
const results = await Promise.all(fast.map(run));
if (results.every((result) => result.ok)) {
  results.push(await run(testReport));
  results.push(await run(testCount));
}
if (full && results.every((result) => result.ok)) {
  for (const step of slow) {
    const result = await run(step);
    results.push(result);
    if (!result.ok) {
      break;
    }
  }
}
const ok = results.every((result) => result.ok);
const totalMs = Math.round(performance.now() - started);

if (json) {
  console.log(
    JSON.stringify({ ok, totalMs, mode: full ? 'full' : 'fast', steps: results }, null, 2),
  );
} else {
  for (const result of results.filter((r) => !r.ok)) {
    console.log(`\n── ${result.name} failed: ${result.command}\n${result.output}`);
  }
  // Warning-only шаги (test-count) зелёные, но их предупреждения агент должен
  // увидеть в сводке, а не только в --json.
  for (const result of results.filter((r) => r.ok && r.output.includes('WARNING'))) {
    console.log(`\n── ${result.name} warnings:\n${result.output}`);
  }
  console.log('\nverify', full ? '(full)' : '(fast)');
  for (const result of results) {
    console.log(
      `  ${result.ok ? '✓' : '✗'} ${result.name.padEnd(16)} ${(result.durationMs / 1000).toFixed(1)}s`,
    );
  }
  console.log(`  ${ok ? 'PASS' : 'FAIL'} in ${(totalMs / 1000).toFixed(1)}s`);
}

// exitCode, а не process.exit(): иначе большой JSON в pipe обрезается.
process.exitCode = ok ? 0 : 1;
