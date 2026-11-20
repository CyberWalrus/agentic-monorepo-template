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
import { spawnSync } from 'node:child_process';
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

/** ~0.75 байта энтропии на символ: bloat(10_000) — это ~7.3 КБ gzip. */
export function bloat(length: number): string {
  return Array.from({ length }, () => CHARSET[Math.floor(Math.random() * CHARSET.length)]).join('');
}

export const BLOAT = bloat(40_000);
// Дельта-канарейке (A6 PR-2, ADR 0013) хватает ~7.3 КБ: больше порога
// maxPrGrowthKb (5 КБ) и меньше запаса абсолютных потолков (см. инвариант
// порогов в тесте gates-canary).
export const BLOAT_DELTA = bloat(10_000);

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
    // Политика доступа объявляется метаданными процедуры (ADR 0011, C2.0),
    // наличие политики проверяет тест перебора в пакете контрактов. Плохое
    // изменение — процедура без meta, добавленная в копию контракта: её
    // замечает только перебор по объекту — тест, сведённый к списку имён,
    // новую процедуру пропустит и останется зелёным (п.3 C2.1). Якорь —
    // закрывающая скобка contract-объекта: переживает смену типа политики
    // и появление параметров в её вариантах.
    name: 'процедура контракта без политики доступа',
    steps: 'test',
    failedStep: 'test',
    expect: /every contract procedure declares a valid access policy/,
    apply: (root) => {
      const path = join(root, 'packages/contracts/src/tasks.ts');
      const source = readFileSync(path, 'utf8');
      const withEvilProcedure = source.replace(
        /\n};/,
        `\n  evilProbe: ocAccess
    .route({ method: 'GET', path: '/tasks/evil-probe', summary: 'Evil probe' })
    .output(z.array(TaskSchema)),
};`,
      );
      if (withEvilProcedure === source) {
        throw new Error('canary anchor not found: contracts/src/tasks.ts has no closing brace');
      }
      writeFileSync(path, withEvilProcedure);
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
    // Дельта-гейт (A6 PR-2, ADR 0013): рост ниже абсолютных потолков (их запас
    // больше дельта-порога — инвариант порогов тестируется в gates-canary),
    // поэтому первым и единственным срабатывает bundle-delta: +~7 КБ gzip
    // больше maxPrGrowthKb (5 КБ). Правильная причина красноты — подсказка про
    // label: любой другой текст означает сломанный чекер.
    name: 'рост бандла в пределах абсолютов',
    steps: 'build,bundle-delta',
    full: true,
    failedStep: 'bundle-delta',
    expect: /bundle-growth-approved/,
    apply: (root) => {
      // Тот же import-graph, что у 30-КБ канарейки: use-tasks.ts живёт в
      // самом большом чанке. atob(btoa()) не сворачивается минификатором.
      const path = join(root, 'apps/web/src/features/tasks/use-tasks.ts');
      const source = readFileSync(path, 'utf8');
      const content = `${source}\nconst evilGrowthProbe = '${BLOAT_DELTA}';\nconsole.log(atob(btoa(evilGrowthProbe)).length);\n`;
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
    // Доска задач — инструкция, которой агент доверяет вслепую (ADR 0007, D3).
    // Плохое изменение — ссылка depends_on на несуществующую задачу: шаг docs
    // краснеет сообщением чекера доски в tools/check-docs.ts.
    name: 'доска ссылается на несуществующую задачу',
    steps: 'docs',
    failedStep: 'docs',
    expect: /depends_on/,
    apply: (root) => {
      const dir = join(root, 'backlog');
      mkdirSync(dir, { recursive: true });
      write(
        root,
        'backlog/evil-probe.md',
        `---\ntitle: probe\ntype: change\npriority: low\ndepends_on: nonexistent-task\n---\n# probe\n\n## Журнал\n`,
      );
    },
  },
  {
    // Замыкание задачи (ADR 0007, «Замыкание задачи»): на ветке task/<id> файл
    // задачи обязан лежать в backlog/done/. Плохое состояние — файл открыт на
    // ветке задачи: шаг docs краснеет правилом closureRule в tools/check-docs.ts.
    // Ветка создаётся прямо в worktree канарейки: правило смотрит на текущую
    // ветку (или GITHUB_HEAD_REF в CI), а не на дифф. switch -C, а не -c: раннер
    // между канарейками возвращает файлы (checkout+clean), но не ветки — ветка
    // task/evil-probe остаётся от прошлого прогона и просто переуказывается.
    // Сама ветка переживает прогон: git branch -d task/evil-probe, либо она
    // переуказывается при следующем запуске.
    name: 'файл задачи не перенесён в done/',
    steps: 'docs',
    failedStep: 'docs',
    expect: /backlog\/done\//,
    apply: (root) => {
      write(
        root,
        'backlog/evil-probe.md',
        `---\ntitle: probe\ntype: change\npriority: low\ndepends_on:\n---\n# probe\n\n## Журнал\n`,
      );
      const result = spawnSync('git', ['switch', '-C', 'task/evil-probe'], {
        cwd: root,
        encoding: 'utf8',
      });
      if (result.status !== 0) {
        throw new Error(`canary setup failed: cannot create task/evil-probe: ${result.stderr}`);
      }
    },
  },
  {
    // Поля needs_human (ADR 0009): непустое значение начинается с «оператор:»,
    // «отложено:» или «человек:» — иначе агент не отличает делегируемое от
    // неделегируемого. Плохое изменение — произвольный текст: шаг docs краснеет
    // invalidNeedsHuman в tools/check-docs.ts (правило для открытых задач).
    name: 'needs_human без допустимого префикса',
    steps: 'docs',
    failedStep: 'docs',
    expect: /needs_human/,
    apply: (root) => {
      write(
        root,
        'backlog/evil-human-probe.md',
        `---\ntitle: probe\ntype: change\npriority: low\ndepends_on:\nneeds_human: выбери вариант сам и продолжай\n---\n# probe\n\n## Журнал\n`,
      );
    },
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
    // Детерминированная метрика «число /rpc-запросов на сценарий» (З8, A6 PR-1):
    // лишний запрос к API в сценарии роняет шаг perf своим порогом
    // maxApiRequests. Плохое изменение — второй фетч списка на каждый create:
    // оптимистичный UI не ломается, но счётчик запросов растёт.
    name: 'лишний запрос к API',
    steps: 'perf',
    full: true,
    failedStep: 'perf',
    expect: /create-task/,
    apply: (root) => {
      const path = join(root, 'apps/web/src/features/tasks/use-tasks.ts');
      const source = readFileSync(path, 'utf8');
      // Сырой POST мимо React Query: fetchQuery вернул бы свежий кэш без сети
      // (staleTime orpc), а здесь лишний запрос на проводе гарантирован.
      const patched = source.replace(
        '  return async (title: string) => {\n    await mutation.mutateAsync({ title });',
        "  return async (title: string) => {\n    void fetch('/rpc/__canary__', { method: 'POST' });\n    await mutation.mutateAsync({ title });",
      );
      if (patched === source) {
        throw new Error('canary anchor not found: useCreateTask body in use-tasks.ts');
      }
      writeFileSync(path, patched);
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
  {
    // Выбор E2E по фичам (B4.1): env E2E_FEATURES → testIgnore проекта
    // functional в e2e/playwright.config.ts. Плохое изменение — срыв привязки
    // (импорт чекера и testIgnore удалены): конфиг снова гоняет всё молча и
    // шаг e2e зелёный, а wiring-тест в tools/test/e2e-select.test.ts краснеет.
    // Проводка живёт в test:hooks, потому что выбор исполняет CI поверх обычной
    // команды e2e — отдельного шага verify у него нет (З6: логика чекера
    // канареечится тестами, проводка — здесь).
    name: 'выбор E2E по фичам удалён из конфига',
    steps: 'test:hooks',
    failedStep: 'test:hooks',
    expect: /проводка: конфиг Playwright держит выбор E2E/,
    apply: (root) => {
      const path = join(root, 'e2e/playwright.config.ts');
      const source = readFileSync(path, 'utf8');
      const stripped = source
        .replaceAll(
          "import { e2eFeatureDirs, functionalTestIgnore, parseE2eFeaturesEnv } from '../tools/e2e-select.ts';\n",
          '',
        )
        .replace('      testIgnore: e2eIgnore,\n', '\n');
      if (stripped === source) {
        throw new Error(
          'canary anchor not found: e2e/playwright.config.ts has no e2e-select wiring',
        );
      }
      writeFileSync(path, stripped);
    },
  },
  {
    // Канарейка копии шаблона (d8.3): раннер живёт в хвосте скрипта canaries,
    // а не в этой таблице — он позитивная проверка (копия собирается и зелёная),
    // а не негативный контроль шага verify; без copier он уходит в громкий skip
    // (З5-исключение: PyPI вне allowlist песочницы, ADR 0004). Плохое изменение —
    // отвязать раннер от pnpm canaries: wiring-тест в tools/test/template-copy
    // краснеет, шаг test:hooks с ним падает. Якорь — заголовок wiring-теста
    // (хвост вывода режет текст ассерта).
    name: 'канарейка копии отвязана от canaries',
    steps: 'test:hooks',
    failedStep: 'test:hooks',
    expect: /канарейка копии/,
    apply: (root) => {
      const path = join(root, 'package.json');
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!isRecord(parsed)) {
        throw new Error('canary anchor not found: package.json is not an object');
      }
      const scripts = parsed['scripts'];
      if (!isRecord(scripts) || typeof scripts['canaries'] !== 'string') {
        throw new Error('canary anchor not found: no canaries script');
      }
      const stripped = scripts['canaries'].replace(
        ' && node tools/run-template-copy-canary.ts',
        '',
      );
      if (stripped === scripts['canaries']) {
        throw new Error('canary anchor not found: canaries script has no copy canary');
      }
      scripts['canaries'] = stripped;
      writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
    },
  },
  {
    // Одобрение визуальных базлайнов (b3.1, ADR 0015): доверенный workflow
    // visual-approve обязан валидировать команду мейнтейнера чекером
    // tools/check-visual-approval.ts (автор из CODEOWNERS + SHA + свежесть).
    // Плохое изменение — срыв привязки (вызов чекера удалён из workflow):
    // команда одобрялась бы без проверки автора/SHA, а wiring-тест в
    // tools/test/visual-approval краснеет. Проводка живёт в test:hooks:
    // issue_comment workflow исполняется только на main и не является шагом
    // verify. Якорь — заголовок wiring-блока.
    name: 'одобрение базлайнов отвязано от чекера',
    steps: 'test:hooks',
    failedStep: 'test:hooks',
    expect: /проводка: визуальное одобрение в доверенном workflow и CI/,
    apply: (root) => {
      const path = join(root, '.github/workflows/visual-approve.yml');
      const source = readFileSync(path, 'utf8');
      const stripped = source.replace(
        '\n' +
          '      - name: Validate approve-visual command\n' +
          '        id: approval\n' +
          "        if: success() && steps.facts.outputs.approved != 'false'\n" +
          '        run: |\n' +
          '          node tools/check-visual-approval.ts comment.json pr.json pushed-check-runs.json .github/CODEOWNERS CODEOWNERS docs/CODEOWNERS\n',
        '\n',
      );
      if (stripped === source) {
        throw new Error('canary anchor not found: visual-approve.yml has no approval validator');
      }
      writeFileSync(path, stripped);
    },
  },
  {
    // Классы защиты tools/ (ADR 0014, e9): шаг verify → pnpm tool-class:check.
    // Плохое изменение — срыв проводки script→гейт (tool-class:check удалён из
    // package.json): шаг verify ломается, замыкание tools/ перестаёт
    // проверяться, wiring-тест в tools/test/check-tool-class краснеет.
    // Проводка живёт в test:hooks по образцу B4.1: логика чекера канареечится
    // фикстурами того же файла, здесь — только её подключение. Срывается
    // именно скрипт, а не шаг verify-steps: удаление шага роняет соседние
    // инвариант-тесты (verify-budgets, gates-canary), их шум вытесняет якорь
    // из 60-строчного хвоста отчёта — канарейка не засчитывается (наблюдение
    // первого прогона e9).
    name: 'tool-class:check отвязан от package.json',
    steps: 'test:hooks',
    failedStep: 'test:hooks',
    expect: /проводка: шаг tool-class в verify/,
    apply: (root) => {
      const path = join(root, 'package.json');
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!isRecord(parsed) || !isRecord(parsed['scripts'])) {
        throw new Error('canary anchor not found: package.json scripts');
      }
      const scripts = parsed['scripts'];
      if (scripts['tool-class:check'] !== 'node tools/check-tool-class.ts') {
        throw new Error('canary anchor not found: no tool-class:check script');
      }
      delete scripts['tool-class:check'];
      writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
    },
  },
  {
    // C3.1: чтение окружения только в модулях окружения (server-config.ts,
    // web/src/lib/env.ts). Плохое изменение — прямое чтение process.env в
    // продуктовом коде приложения; красит шаг env (tools/check-env-usage.ts).
    name: 'process.env вне env-модуля',
    steps: 'env',
    failedStep: 'env',
    expect: /чтение окружения вне модуля окружения/,
    apply: (root) => {
      const path = join(root, 'apps', 'api', 'src', 'server.ts');
      const source = readFileSync(path, 'utf8');
      if (!source.includes('loadServerEnv')) {
        throw new Error('canary anchor not found in apps/api/src/server.ts');
      }
      writeFileSync(path, `${source}\nconst c31EnvLeak = process.env.PORT;\n`);
    },
  },
  {
    // C3.1, второе направление: env.example полон относительно схемы. Плохое
    // изменение — удалённая переменная; красит тест полноты (apps/api) в шаге
    // test. Формат файла канареечится тем же тестом при пустом файле.
    name: 'env.example неполный',
    steps: 'test',
    failedStep: 'test',
    expect: /env\.example api/,
    apply: (root) => {
      const path = join(root, 'apps', 'api', 'env.example');
      const source = readFileSync(path, 'utf8');
      if (!source.includes('DATABASE_URL=')) {
        throw new Error('canary anchor not found in apps/api/env.example');
      }
      const withoutKey = source
        .split('\n')
        .filter((line) => !line.startsWith('DATABASE_URL='))
        .join('\n');
      writeFileSync(path, withoutKey);
    },
  },
  {
    // b4.4: карантин не узаконенный .skip — @critical в карантин запрещён
    // (максимум 3 записи, срок обязателен; остальное валидирует тот же чекер).
    // Красит шаг quarantine (tools/check-flaky-rate.ts --validate-quarantine).
    name: 'quarantine: @critical в карантине',
    steps: 'quarantine',
    failedStep: 'quarantine',
    expect: /@critical/,
    apply: (root) => {
      const path = join(root, 'tools', 'flaky-quarantine.json');
      const source = readFileSync(path, 'utf8');
      if (!source.includes('"quarantine": []')) {
        throw new Error('canary anchor not found: quarantine array');
      }
      writeFileSync(
        path,
        source.replace(
          '"quarantine": []',
          '"quarantine": [{ "test": "smoke.spec.ts :: @critical вход", "until": "2099-01-01T00:00:00Z", "issue": "#1" }]',
        ),
      );
    },
  },
];
// Вывод портов (З9, A5 PR-3) канарейки шага не имеет: рантайм читает записанный
// reports/ports.json (read-first — иначе зонд после старта серверов уезжал на
// чужой порт), сломанный выбор — мёртвый код для рантайма. Инвариант
// «web и api не совпадают» канареечен юнит-тестом pickPorts (tools/test/
// ports.test.ts), реальная коллизия красит e2e натурально (EADDRINUSE).
