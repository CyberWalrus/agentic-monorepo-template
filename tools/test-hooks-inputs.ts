/**
 * Канонический список входов корневой задачи `//#test:hooks` (E1) —
 * единственное место определения. turbo.json обязан ему соответствовать:
 * расходится канарейка tools/test/test-hooks-inputs.test.ts (З6 —
 * пропущенный input означал бы тихо устаревший зелёный результат).
 * Список заведомо щедрый: лишний input только вызывает лишний перегон,
 * пропущенный — стейт-зелёность.
 */
export const TEST_HOOKS_INPUTS = [
  'tools/**',
  '.claude/hooks/**',
  '.claude/agents/**',
  '.claude/settings.json',
  '.github/**',
  // Тесты обвязки читают файлы за пределами tools/ (канарейки visual-гейта,
  // updateSnapshots и e2e-выбора мутируют их в проверках; тест живости якорей
  // применяет каждую канарейку к копии дерева, а канарейки читают apps/** и
  // packages/**): пропущенный каталог = кэш отдаёт зелёный результат на
  // изменённом файле.
  'e2e/**',
  'packages/**',
  'apps/**',
  'vitest.config.ts',
  'tsconfig.json',
  'tsconfig.base.json',
  '.dependency-cruiser.cjs',
  'knip.json',
  '.oxlintrc.json',
  'turbo.json',
  'verify-budgets.json',
  'perf-budgets.json',
  'test-count-baseline.json',
  'package.json',
  'pnpm-lock.yaml',
] as const;
