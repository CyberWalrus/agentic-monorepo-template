/**
 * Определения шагов verify — общий источник для tools/verify.ts (оркестрация),
 * канареек гейтов (tools/run-gate-canaries.ts) и их санити-теста. Без побочных
 * эффектов: только таблицы шагов. Порядок slow — контракт (см. комментарий
 * ниже); хуки и CI не имеют права выбирать подмножество (--only — только
 * для человека и канареек).
 */

export interface Step {
  name: string;
  command: string;
  args: string[];
}

const turbo = (task: string): Step => ({
  name: task,
  command: 'pnpm',
  args: ['turbo', 'run', task, '--output-logs=errors-only'],
});

export const fast: Step[] = [
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

/** Пост-волновые шаги: читают отчёты, поэтому идут только после зелёных тестов. */
export const post: Step[] = [
  // Гейт по отчёту раннера (З3, A3). Корневой vitest (test:hooks) вне turbo,
  // поэтому его отчёт добавляется явным --only.
  {
    name: 'test-report',
    command: 'pnpm',
    args: ['test:report', '--from-turbo', 'test', '--only', 'reports/vitest-hooks.json'],
  },
  // Храповик числа тестов (З7, A3): warning-only, читает те же отчёты.
  { name: 'test-count', command: 'pnpm', args: ['test:count'] },
];

// E2E → e2e-report → perf идут последовательно: perf перезаписывает отчёт
// reports/e2e.json, который читает e2e-report; переставлять шаги нельзя.
// Порты у шагов больше не общие: выводятся из worktree (З9, A5 PR-3).
export const slow: Step[] = [
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

export const allStepNames: string[] = [...fast, ...post, ...slow].map((step) => step.name);
