/**
 * Таблица канареек гейтов (З6, B1): каждое «плохое изменение» должно уронить
 * ровно свой шаг verify в worktree, запущенный реальной командой
 * `pnpm verify --json --only <steps>`. Логика чекеров канареечна на уровне
 * чекеров (tools/test/*), здесь проверяется ПРОВОДКА: шаг существует, команда
 * резолвит конфиг от корня, правило в конфиге живо. Ослабление любого
 * заканареченного правила делает шаг зелёным и роняет канарейку.
 *
 * Исключения (документированы в architecture.md З6): test-count — warning-only,
 * exit 0 по контракту; e2e/e2e-report/perf — тяжёлые, их время покрывают
 * бюджеты nightly. Изменение защищённого файла как таковое ловят контуры
 * L0 (хуки) и L3 (gate-integrity); локально канареечится одностороннее
 * ослабление З10-пары (канарейка sandbox).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface GateCanary {
  name: string;
  /** Значение для verify --only (через запятую). */
  steps: string;
  /** slow-шаги — только с --full. */
  full?: boolean;
  /** Шаг, который обязан упасть (в паре шагов — целевой). */
  failedStep: string;
  /** Подстрока/паттерн в выводе упавшего шага. */
  expect: RegExp;
  apply: (root: string) => void;
}

// Высокоэнтропийный литерал: повторяющиеся символы gzip сжимает, и перерасход
// бандла перестанет ловиться.
const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BLOAT = Array.from(
  { length: 40_000 },
  () => CHARSET[Math.floor(Math.random() * CHARSET.length)],
).join('');

function write(root: string, relativePath: string, content: string): void {
  const path = join(root, relativePath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const CANARIES: GateCanary[] = [
  {
    name: 'межфичевый импорт',
    steps: 'boundaries',
    failedStep: 'boundaries',
    expect: /tasks/,
    apply: (root) =>
      write(
        root,
        'apps/web/src/features/evil/index.ts',
        "import { useTasks } from '../tasks/use-tasks';\n\nexport const evil = () => useTasks();\n",
      ),
  },
  {
    name: 'any в домене',
    steps: 'lint',
    failedStep: 'lint',
    expect: /no-explicit-any/,
    apply: (root) =>
      write(root, 'apps/api/src/evil-probe.ts', 'export const evil = (x: any): any => x;\n'),
  },
  {
    name: 'type-ошибка в приложении',
    steps: 'typecheck',
    failedStep: 'typecheck',
    expect: /evil-probe/,
    apply: (root) =>
      write(root, 'apps/api/src/evil-probe.ts', "export const evil: number = 'not-a-number';\n"),
  },
  {
    name: 'type-ошибка в tools',
    steps: 'typecheck:tools',
    failedStep: 'typecheck:tools',
    expect: /error TS/,
    apply: (root) =>
      write(root, 'tools/evil-probe.ts', "export const evil: number = 'not-a-number';\n"),
  },
  {
    name: 'expected failure в тесте',
    steps: 'test-integrity',
    failedStep: 'test-integrity',
    expect: /\.fails\(/,
    apply: (root) =>
      write(
        root,
        'apps/api/src/evil-probe.test.ts',
        "import { it } from 'vitest';\n\nit.fails('hides a bug', () => {\n  expect(1).toBe(2);\n});\n",
      ),
  },
  {
    name: 'skipped тест',
    steps: 'test,test-report',
    failedStep: 'test-report',
    expect: /skipped/,
    apply: (root) =>
      write(
        root,
        'apps/api/src/evil-probe.test.ts',
        "import { expect, it } from 'vitest';\n\nit.skipIf(true)('conditionally skipped', () => {\n  expect(1).toBe(1);\n});\n",
      ),
  },
  {
    name: 'падающий tools-тест',
    steps: 'test:hooks',
    failedStep: 'test:hooks',
    expect: /evil/,
    apply: (root) =>
      write(
        root,
        'tools/test/evil-probe.test.ts',
        "import { expect, it } from 'vitest';\n\nit('deliberately broken canary probe', () => {\n  expect(1).toBe(2);\n});\n",
      ),
  },
  {
    name: 'неиспользуемый экспорт',
    steps: 'knip',
    failedStep: 'knip',
    expect: /unusedProbe/,
    apply: (root) => {
      const path = join(root, 'apps/api/src/tasks/repository.ts');
      const source = readFileSync(path, 'utf8');
      writeFileSync(path, `${source}\nexport const unusedProbe = 1;\n`);
    },
  },
  {
    // Версии мимо каталога ловит сам pnpm (catalogMode: strict в
    // pnpm-workspace.yaml) при install — это setup в CI, не шаг verify.
    // Здесь канареечится правило sherif о порядке зависимостей.
    name: 'зависимости не отсортированы',
    steps: 'sherif',
    failedStep: 'sherif',
    expect: /unordered-dependencies/,
    apply: (root) => {
      const path = join(root, 'apps/api/package.json');
      const pkg: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!isRecord(pkg)) {
        throw new Error('canary anchor not found: apps/api/package.json is not an object');
      }
      const dependencies = pkg['dependencies'];
      if (!isRecord(dependencies)) {
        throw new Error('canary anchor not found: no dependencies block');
      }
      for (const value of Object.values(dependencies)) {
        if (typeof value !== 'string') {
          throw new Error('canary anchor not found: dependencies value is not a string');
        }
      }
      dependencies['lodash'] = '^4.17.21';
      writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
    },
  },
  {
    name: 'дрейф контракта',
    steps: 'openapi',
    failedStep: 'openapi',
    expect: /openapi/i,
    apply: (root) => {
      const path = join(root, 'packages/contracts/src/tasks.ts');
      const source = readFileSync(path, 'utf8');
      const withField = source.replace(
        '  completed: z.boolean(),',
        '  completed: z.boolean(),\n  priority: z.enum(["low"]).optional(),',
      );
      if (withField === source) {
        throw new Error('canary anchor not found in contracts/src/tasks.ts');
      }
      writeFileSync(path, withField);
    },
  },
  {
    name: 'бандл сверх бюджета',
    steps: 'build,bundle',
    full: true,
    failedStep: 'bundle',
    expect: /бюджет|budget/i,
    apply: (root) => {
      // Клиентский модуль в самом большом чанке (import-graph index-роута):
      // __root/router живут в server-бандле, orphan-модули tree-shaken.
      // atob(btoa()) не сворачивается минификатором (slice/length он
      // вычисляет на этапе сборки и выкидывает литерал).
      const path = join(root, 'apps/web/src/features/tasks/use-tasks.ts');
      const source = readFileSync(path, 'utf8');
      const content = `${source}\nconst evilBloatProbe = '${BLOAT}';\nconsole.log(atob(btoa(evilBloatProbe)).length);\n`;
      writeFileSync(path, content);
    },
  },
  {
    name: 'незакрытая ссылка в docs',
    steps: 'docs',
    failedStep: 'docs',
    expect: /evil-probe/,
    apply: (root) => write(root, 'docs/evil-probe.md', '[ссылка в никуда](missing-file.md)\n'),
  },
  {
    name: 'рассинхрон З10-пары',
    steps: 'sandbox',
    failedStep: 'sandbox',
    expect: /absent from protected-paths\.json/,
    apply: (root) => {
      const path = join(root, 'tools/protected-paths.json');
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!isRecord(parsed)) {
        throw new Error('canary anchor not found: protected-paths.json is not an object');
      }
      const deny = parsed['deny'];
      if (!Array.isArray(deny)) {
        throw new Error('canary anchor not found: no deny array');
      }
      parsed['deny'] = deny.filter((item) => item !== 'knip.json');
      writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
    },
  },
];
