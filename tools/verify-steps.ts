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
  // Гейт окружения (C3.1): чтение env только в модулях окружения + env.example.
  { name: 'env', command: 'pnpm', args: ['env:check'] },
  turbo('typecheck'),
  { name: 'typecheck:tools', command: 'pnpm', args: ['typecheck:tools'] },
  turbo('test'),
  { name: 'boundaries', command: 'pnpm', args: ['boundaries'] },
  { name: 'knip', command: 'pnpm', args: ['knip'] },
  // Состав workspace (e20): каждая обязательная задача turbo объявлена хотя бы
  // одним пакетом. turbo-прогон без носителей завершается exit 0 — без этого
  // гейта удаление последнего пакета с mutation/e2e тихо выключает CI.
  { name: 'required-tasks', command: 'pnpm', args: ['required-tasks:check'] },
  { name: 'test-integrity', command: 'pnpm', args: ['test:integrity'] },
  // Тесты обвязки под кэшем turbo (E1): inputs — tools/test-hooks-inputs.ts.
  turbo('test:hooks'),
  { name: 'sandbox', command: 'pnpm', args: ['sandbox:check'] },
  // Классы защиты tools/ (ADR 0014): замыкание гейтов == deny protected-paths.json.
  { name: 'tool-class', command: 'pnpm', args: ['tool-class:check'] },
  { name: 'docs', command: 'pnpm', args: ['docs:check'] },
  // Порядок реестров (b7): одна строка на домен по алфавиту.
  { name: 'registries', command: 'pnpm', args: ['registries:check'] },
  // Карантин флаков (b4.4): валидность защищённого файла.
  { name: 'quarantine', command: 'pnpm', args: ['flaky:quarantine'] },
  { name: 'sherif', command: 'pnpm', args: ['sherif'] },
  // Версия Docker-образа Playwright == каталог @playwright/test (З4/A8).
  { name: 'visual-image', command: 'pnpm', args: ['visual-image:check'] },
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
// bundle-delta стоит после build и bundle: читает их dist и строит базу
// merge-base с общим кэшем turbo (A6 PR-2, ADR 0013). Порты у шагов больше
// не общие: выводятся из worktree (З9, A5 PR-3).
export const slow: Step[] = [
  turbo('build'),
  { name: 'bundle', command: 'pnpm', args: ['bundle'] },
  { name: 'bundle-delta', command: 'pnpm', args: ['bundle:delta'] },
  turbo('e2e'),
  {
    name: 'e2e-report',
    command: 'pnpm',
    args: ['test:report', '--from-turbo', 'e2e', '--expect-project', 'functional'],
  },
  turbo('perf'),
];

export const allStepNames: string[] = [...fast, ...post, ...slow].map((step) => step.name);
