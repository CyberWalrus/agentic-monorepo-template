/**
 * Локальный аналог CI-гейтов. Одна команда для человека и агента.
 *
 *   pnpm verify                    статика + unit (быстро, кэш turbo)
 *   pnpm verify --full             + сборка, бюджет бандла, E2E, перф-бюджеты
 *   pnpm verify --json             машиночитаемый результат (для агентов и хуков)
 *   pnpm verify --only lint,knip   подмножество шагов (для канареек гейтов и отладки;
 *                                  зависимости шагов не тянутся — test-report без test
 *                                  читает отчёты прошлого прогона; slow-шаги требуют --full;
 *                                  хуки и CI передавать --only не имеют права — З5)
 *
 * Визуальные тесты сюда не входят: они идут только в Docker (`pnpm visual`).
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { budgetMsFor, parseBudgets, type VerifyBudgets } from './verify-budgets-loader.ts';
import { allStepNames, fast, post, slow, type Step } from './verify-steps.ts';

interface StepResult {
  name: string;
  ok: boolean;
  durationMs: number;
  command: string;
  output: string;
  budgetMs?: number;
  overBudget?: boolean;
}

const json = process.argv.includes('--json');
const full = process.argv.includes('--full');
const TAIL_LINES = 60;

const onlyFlag = process.argv.indexOf('--only');
const only =
  onlyFlag >= 0
    ? (process.argv[onlyFlag + 1]?.split(',') ?? []).map((name) => name.trim())
    : undefined;
if (only !== undefined) {
  const unknown = only.filter((name) => !allStepNames.includes(name));
  if (unknown.length > 0) {
    console.error(`verify --only: unknown step(s): ${unknown.join(', ')}`);
    console.error(`known steps: ${allStepNames.join(', ')}`);
    process.exit(1);
  }
  const selected = (steps: Step[]): Step[] => steps.filter((step) => only.includes(step.name));
  fast.splice(0, fast.length, ...selected(fast));
  post.splice(0, post.length, ...selected(post));
  slow.splice(0, slow.length, ...selected(slow));
  // Без --full slow-волна не исполняется: --only с slow-шагом без --full —
  // прогон, который ничего не сделал, с зелёным PASS. Не даём и такого.
  if (slow.length > 0 && !full) {
    console.error(
      'verify --only: slow step(s) selected but --full is missing (slow wave runs only with --full)',
    );
    process.exit(1);
  }
}

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
  for (const step of post) {
    results.push(await run(step));
  }
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

// Бюджеты времени (З6, B1): пороги из защищённого verify-budgets.json,
// откалиброваны по ubuntu-latest. Локально и в PR превышение — предупреждение
// (машины разные), в nightly --enforce-budgets роняет прогон. Битый или
// отсутствующий файл — предупреждение (храповик не должен молча ослепнуть),
// но с --enforce-budgets прогон без чисел — красный (fail-closed, З4).
const enforceBudgets = process.argv.includes('--enforce-budgets');

const budgetWarnings: string[] = [];
let budgets: VerifyBudgets | null = null;
const budgetsPath = resolvePath(process.cwd(), 'verify-budgets.json');
try {
  budgets = parseBudgets(JSON.parse(readFileSync(budgetsPath, 'utf8')));
} catch (error) {
  budgetWarnings.push(
    `verify-budgets.json is missing or unreadable (${error instanceof Error ? error.message : String(error)}) — time budgets are not checked`,
  );
}
if (enforceBudgets && budgets === null) {
  budgetWarnings.push(
    '--enforce-budgets: no budgets to enforce (verify-budgets.json is missing or broken)',
  );
}

const slowNames = new Set(slow.map((step) => step.name));
for (const result of results) {
  if (budgets === null) {
    continue;
  }
  const budget = budgetMsFor(result.name, slowNames.has(result.name), budgets);
  if (budget === undefined) {
    continue;
  }
  result['budgetMs'] = budget;
  result['overBudget'] = result.durationMs > budget;
  if (result['overBudget']) {
    budgetWarnings.push(
      `${result.name}: ${result.durationMs / 1000}s exceeded budget ${budget / 1000}s${
        enforceBudgets ? ' — enforced run fails (З6)' : ''
      }`,
    );
  }
}
let totalBudgetMs: number | undefined;
let totalOverBudget = false;
if (budgets !== null) {
  const totalSeconds = full ? budgets.totalSlow : budgets.totalFast;
  totalBudgetMs = totalSeconds * 1000;
  totalOverBudget = totalMs > totalBudgetMs;
  if (totalOverBudget) {
    budgetWarnings.push(
      `total: ${totalMs / 1000}s exceeded budget ${totalSeconds}s${
        enforceBudgets ? ' — enforced run fails (З6)' : ''
      }`,
    );
  }
}
// enforce без чисел — тоже «превышение»: прогон не может доказать бюджет.
const budgetsExceeded =
  budgets === null || results.some((result) => result['overBudget'] === true) || totalOverBudget;

if (json) {
  console.log(
    JSON.stringify(
      {
        ok,
        totalMs,
        mode: full ? 'full' : 'fast',
        ...(only !== undefined ? { only } : {}),
        ...(totalBudgetMs !== undefined
          ? { budgetMs: totalBudgetMs, overBudget: totalOverBudget }
          : {}),
        steps: results,
      },
      null,
      2,
    ),
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

// Предупреждения бюджета — даже у зелёного прогона (З6: превышение времени —
// дефект инфраструктуры, агент и человек должны его видеть). stderr: в nightly
// stdout перенаправляется в verify-durations.json, лог-строки ломали бы JSON.
for (const warning of budgetWarnings) {
  console.error(`WARNING: ${warning}`);
}

// exitCode, а не process.exit(): иначе большой JSON в pipe обрезается.
process.exitCode = ok && !(enforceBudgets && budgetsExceeded) ? 0 : 1;
