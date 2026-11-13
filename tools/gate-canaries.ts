/**
 * Таблица канареек гейтов (З6, B1): каждое «плохое изменение» должно уронить
 * ровно свой шаг verify в worktree, запущенный реальной командой
 * `pnpm verify --json --only <steps>`. Логика чекеров канареечна на уровне
 * чекеров (tools/test/*), здесь проверяется ПРОВОДКА: шаг существует, команда
 * резолвит конфиг от корня, правило в конфиге живо. Ослабление любого
 * заканареченного правила делает шаг зелёным и роняет канарейку.
 *
 * Исключения (документированы в architecture.md З6): test-count — warning-only,
 * exit 0 по контракту; e2e-report/perf — тяжёлые, их время покрывают бюджеты.
 * e2e канареечится начиная с ADR 0005 (прокси /rpc): удаление прокси —
 * детерминированный bad-change, уроняющий e2e. Изменение защищённого файла как
 * таковое ловят контуры L0 (хуки) и L3 (gate-integrity); локально канареечится
 * одностороннее ослабление З10-пары (канарейка sandbox).
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
export const BLOAT = Array.from(
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
    // Продуктовый код не импортирует tools/ (правило границ, ADR 0005/З9):
    // порты и окружение приходят через запуск, tools — потребитель, не зависимость.
    name: 'импорт tools из продукта',
    steps: 'boundaries',
    failedStep: 'boundaries',
    expect: /product-not-to-tools/,
    apply: (root) =>
      write(
        root,
        'apps/web/src/lib/evil-probe.ts',
        "import { MIN_BASE } from '../../../../tools/ports.ts';\n\nexport const evil = () => MIN_BASE;\n",
      ),
  },
  {
    name: 'межфичевый импорт',
    steps: 'boundaries',
    failedStep: 'boundaries',
    expect: /evil/,
    apply: (root) =>
      write(
        root,
        'apps/web/src/features/evil/index.ts',
        "import { useTasks } from '../tasks/use-tasks';\n\nexport const evil = () => useTasks();\n",
      ),
  },
  {
    name: 'нарушение форматирования',
    steps: 'format',
    failedStep: 'format',
    expect: /evil-probe/,
    apply: (root) =>
      write(
        root,
        'apps/api/src/evil-probe.ts',
        'const   evil=1;;const  other=2\nexport { evil, other };\n',
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
    expect: /evil-probe/,
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
      const keys = Object.keys(dependencies);
      const lastKey = keys.at(-1);
      if (lastKey === undefined || lastKey < 'lodash') {
        // lodash дописывается последним: если последний ключ встанет раньше,
        // порядок не нарушится и канарейка перестанет стрелять.
        throw new Error('canary anchor not found: last dependency sorts before "lodash"');
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
    expect: /out of date/,
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
  {
    // Без прокси браузерный fetch `/rpc` попадает в SSR-обработчик Start и
    // функции API недоступны: падают ВСЕ клиентские тесты, в хвосте вывода
    // Playwright остаётся «N failed» с N ≥ 2 — массовое падение отличает
    // канарейку от одиночного флака (ADR 0005).
    name: 'прокси /rpc удалён',
    steps: 'e2e',
    full: true,
    failedStep: 'e2e',
    expect: /([2-9]|\d{2,})\s+failed/,
    apply: (root) => {
      const path = join(root, 'apps/web/vite.config.ts');
      const source = readFileSync(path, 'utf8');
      const stripped = source.replaceAll('proxy: rpcProxy', 'proxy: undefined');
      if (stripped === source) {
        throw new Error('canary anchor not found: apps/web/vite.config.ts has no rpcProxy');
      }
      writeFileSync(path, stripped);
    },
  },
  {
    // Правило «через web-origin доступен только /rpc» (ADR 0005) закреплено
    // e2e-тестом api-origin; канарейка гарантирует, что тест не перестанет
    // ловить: добавленный в прокси /__test__ красит e2e его тестом. Якорь —
    // заголовок теста: он остаётся в хвосте вывода Playwright, текст ассерта
    // вылетает из 60 строк (наблюдалось в первом прогоне этой канарейки).
    name: '/__test__ добавлен в прокси',
    steps: 'e2e',
    full: true,
    failedStep: 'e2e',
    expect: /test API is not reachable through the web origin/,
    apply: (root) => {
      const path = join(root, 'apps/web/vite.config.ts');
      const source = readFileSync(path, 'utf8');
      const leaked = source.replaceAll(
        "'/rpc': { target: process.env['API_URL'] ?? '', changeOrigin: false }",
        "'/rpc': { target: process.env['API_URL'] ?? '', changeOrigin: false },\n    '/__test__': { target: process.env['API_URL'] ?? '', changeOrigin: false },",
      );
      if (leaked === source) {
        throw new Error('canary anchor not found: apps/web/vite.config.ts has no /rpc proxy entry');
      }
      writeFileSync(path, leaked);
    },
  },
  {
    // Детерминизм сборки (ADR 0005): запечённый адрес в клиентском бандле
    // ловит скан шага bundle. atob(btoa()) не сворачивается минификатором
    // (урок B1), литерал останется в чанке.
    name: 'адрес API запечён в бандл',
    steps: 'build,bundle',
    full: true,
    failedStep: 'bundle',
    expect: /Baked API addresses/i,
    apply: (root) => {
      const path = join(root, 'apps/web/src/lib/api-client.ts');
      const source = readFileSync(path, 'utf8');
      const content = `${source}\nconst evilBakedProbe = 'http://localhost:3001';\nconsole.log(atob(btoa(evilBakedProbe)));\n`;
      writeFileSync(path, content);
    },
  },
  {
    // Запуск visual-проекта вне Linux ловит guard в конфиге Playwright
    // (З4, A8); живость guard'а держит wiring-тест в tools/test/visual-guard.
    // Плохое изменение — guard удалён из конфига: тест краснеет, шаг test:hooks
    // с ним падает. Якорь — заголовок wiring-теста (TAIL_LINES режет ассерты).
    name: 'visual-гейт удалён из Playwright-конфига',
    steps: 'test:hooks',
    failedStep: 'test:hooks',
    expect: /guard до побочных эффектов/,
    apply: (root) => {
      const path = join(root, 'e2e/playwright.config.ts');
      const source = readFileSync(path, 'utf8');
      const stripped = source
        .replaceAll(
          "import { assertVisualRunAllowed, snapshotsUpdateMode } from '../tools/visual-guard.ts';",
          "import { snapshotsUpdateMode } from '../tools/visual-guard.ts';",
        )
        .replace(
          `\nassertVisualRunAllowed({\n  argv: process.argv,\n  platform: process.platform,\n  allowEnv: process.env['ALLOW_HOST_SCREENSHOTS'],\n});\n`,
          '\n',
        );
      if (stripped === source) {
        throw new Error('canary anchor not found: e2e/playwright.config.ts has no visual guard');
      }
      writeFileSync(path, stripped);
    },
  },
  {
    // Запись базлайнов вне VISUAL_UPDATE=1 запрещена snapshotsUpdateMode (A8):
    // откат к тернарнику по CI разрешал бы «missing» на хосте. Тот же wiring-
    // тест краснеет — якорь тот же.
    name: 'updateSnapshots вернулся к флагу CI',
    steps: 'test:hooks',
    failedStep: 'test:hooks',
    expect: /guard до побочных эффектов/,
    apply: (root) => {
      const path = join(root, 'e2e/playwright.config.ts');
      const source = readFileSync(path, 'utf8');
      const reverted = source.replaceAll(
        'updateSnapshots: snapshotsUpdateMode(process.env),',
        "updateSnapshots: CI ? 'none' : 'missing',",
      );
      if (reverted === source) {
        throw new Error('canary anchor not found: playwright.config.ts has no snapshotsUpdateMode');
      }
      writeFileSync(path, reverted);
    },
  },
  {
    // Версия Docker-образа Playwright в ci.yml равна каталогу @playwright/test
    // (З4/A8, один чекер check-visual-image.ts). Плохое изменение — сдвиг версии
    // образа внутри noble-формы: чекер краснеет сообщением с обеими версиями.
    // Якорь по префиксу, не по номеру: Renovate обновляет версию, якорь не
    // должен за ней следить. Тег остаётся валидным (-noble): выход из формы
    // ловил бы fail-closed «no image» вместо целевого «diverge».
    name: 'версия образа разошлась с каталогом',
    steps: 'visual-image',
    failedStep: 'visual-image',
    expect: /v0\.0\.0-noble/,
    apply: (root) => {
      const path = join(root, '.github/workflows/ci.yml');
      const source = readFileSync(path, 'utf8');
      const drifted = source.replace(
        /image:\s*mcr\.microsoft\.com\/playwright:v[\d.]+-noble/,
        'image: mcr.microsoft.com/playwright:v0.0.0-noble',
      );
      if (drifted === source) {
        throw new Error('canary anchor not found: ci.yml has no Playwright image line');
      }
      writeFileSync(path, drifted);
    },
  },
];
// Вывод портов (З9, A5 PR-3) канарейки шага не имеет: рантайм читает записанный
// reports/ports.json (read-first — иначе зонд после старта серверов уезжал на
// чужой порт), сломанный выбор — мёртвый код для рантайма. Инвариант
// «web и api не совпадают» канареечен юнит-тестом pickPorts (tools/test/
// ports.test.ts), реальная коллизия красит e2e натурально (EADDRINUSE).
