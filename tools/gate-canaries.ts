/**
 * Таблица канареек гейтов (З6, B1): каждое «плохое изменение» должно уронить
 * ровно свой шаг verify в worktree, запущенный реальной командой
 * `pnpm verify --json --only <steps>`. Логика чекеров канареечна на уровне
 * чекеров (tools/test/*), здесь проверяется ПРОВОДКА: шаг существует, команда
 * резолвит конфиг от корня, правило в конфиге живо. Ослабление любого
 * заканареченного правила делает шаг зелёным и роняет канарейку.
 *
 * Исключения (документированы в architecture.md З6): test-count — warning-only,
 * exit 0 по контракту; e2e-report — тяжёлый, его время покрывают бюджеты.
 * e2e канареечится начиная с ADR 0005 (прокси /rpc): удаление прокси —
 * детерминированный bad-change, уроняющий e2e. Изменение защищённого файла как
 * таковое ловят контуры L0 (хуки) и L3 (gate-integrity); локально канареечится
 * одностороннее ослабление З10-пары (канарейка sandbox).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/**
 * Регистрации `/rpc` в server-app.ts — якорь двух канареек ниже. Якорятся сами
 * маршруты вместе с тем, что стоит перед `proxyRpc` (e55 поставила перед ним
 * проверку формы запроса): точная строка `app.all('/rpc', proxyRpc)` исчезла с
 * той правкой, а сам PR e55 канарейки не запускал (canaries.yml идёт по фильтру
 * путей) — краснить стало на всех следующих PR, где эти пути есть. null —
 * регистрации нет, канарейка бросает «якорь не найден».
 */
type RpcRoute = {
  /** Вся строка регистрации, с отступом. */
  text: string;
  indent: string;
  /** Что стоит между путём и `proxyRpc` (например, middleware), с запятой. */
  before: string;
};

function rpcRoutes(source: string): { main: RpcRoute; sub: RpcRoute } | null {
  // Якорь — строка кода от начала строки: вхождение в комментарии не считается.
  const route = (pattern: RegExp): RpcRoute | null => {
    const match = pattern.exec(source);
    return match === null
      ? null
      : { text: match[0], indent: match[1] ?? '', before: match[2] ?? '' };
  };
  const main = route(/^([ \t]*)app\.all\('\/rpc', ([^;\n]*?)proxyRpc\);/m);
  const sub = route(/^([ \t]*)app\.all\('\/rpc\/\*', ([^;\n]*?)proxyRpc\);/m);
  return main === null || sub === null ? null : { main, sub };
}

/** Та же регистрация под другим путём: `proxyRpc` и его middleware на месте. */
function rpcRouteAs(route: RpcRoute, path: string): string {
  return `${route.indent}app.all('${path}', ${route.before}proxyRpc);`;
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
    // e15: devDependency в production-entry (server.ts — корень пакета,
    // слот TanStack ADR 0012): гейт раньше не покрывал корень пакета.
    name: 'dev-dep в production-entry',
    steps: 'boundaries',
    failedStep: 'boundaries',
    expect: /not-to-dev-dep/,
    apply: (root) => {
      const path = join(root, 'apps', 'web', 'server.ts');
      const source = readFileSync(path, 'utf8');
      if (!source.includes('createServer') && !source.includes('serve')) {
        throw new Error('canary anchor not found: apps/web/server.ts');
      }
      writeFileSync(path, `${source}\nimport 'vitest/config';\n`);
    },
  },
  {
    // e15: общий слой web не импортирует фичи (lib — дно зависимостей).
    name: 'lib импортирует фичу',
    steps: 'boundaries',
    failedStep: 'boundaries',
    expect: /web-lib-not-to-features/,
    apply: (root) =>
      write(
        root,
        'apps/web/src/lib/evil-feature-probe.ts',
        "import '../features/tasks/task-cache.ts';\n\nexport const evil = () => 0;\n",
      ),
  },
  {
    // e15: домен не знает пограничные адаптеры транспорта (authorization и др.).
    name: 'домен импортирует адаптер транспорта',
    steps: 'boundaries',
    failedStep: 'boundaries',
    expect: /api-domain-independent-of-transport/,
    apply: (root) =>
      write(
        root,
        'apps/api/src/tasks/evil-transport-probe.ts',
        "import '../authorization.ts';\n\nexport const evil = () => 0;\n",
      ),
  },
  {
    // e47: expect — имя правила, а не зонда: паттерн /evil/ матчил путь пробного
    // файла и не отличал no-cross-feature-imports от любого другого падения на нём.
    name: 'межфичевый импорт',
    steps: 'boundaries',
    failedStep: 'boundaries',
    expect: /no-cross-feature-imports/,
    apply: (root) =>
      write(
        root,
        'apps/web/src/features/evil/index.ts',
        "import { useTasks } from '../tasks/use-tasks';\n\nexport const evil = () => useTasks();\n",
      ),
  },
  {
    // e44: devDependency с entry в dist/ (vitest) из production-кода пакета.
    // Пока exclude резал любой dist/ — и node_modules/*/dist — ребро к такому
    // пакету выпадало из графа, и not-to-dev-dep его не видел.
    name: 'dev-dep с entry в dist',
    steps: 'boundaries',
    failedStep: 'boundaries',
    expect: /not-to-dev-dep/,
    apply: (root) =>
      write(
        root,
        'packages/contracts/src/evil-vitest-probe.ts',
        "import { describe } from 'vitest';\n\nexport const evil = describe;\n",
      ),
  },
  {
    // e44: контракты тянут транспорт (@orpc/server, entry в dist/) как
    // production-зависимость. Пакет переносится из devDependencies в
    // dependencies: иначе импорт ловит not-to-dev-dep, а не contracts-are-pure
    // (правило смотрит только на npm- и core-зависимости).
    name: 'контракты тянут @orpc/server',
    steps: 'boundaries',
    failedStep: 'boundaries',
    expect: /contracts-are-pure/,
    apply: (root) => {
      const path = join(root, 'packages', 'contracts', 'package.json');
      const pkg: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (
        !isRecord(pkg) ||
        !isRecord(pkg['dependencies']) ||
        !isRecord(pkg['devDependencies']) ||
        typeof pkg['devDependencies']['@orpc/server'] !== 'string'
      ) {
        throw new Error(
          'canary anchor not found: @orpc/server в devDependencies packages/contracts/package.json',
        );
      }
      pkg['dependencies']['@orpc/server'] = pkg['devDependencies']['@orpc/server'];
      delete pkg['devDependencies']['@orpc/server'];
      writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
      write(
        root,
        'packages/contracts/src/evil-orpc-server-probe.ts',
        "import { ORPCError } from '@orpc/server';\n\nexport const evil = ORPCError;\n",
      );
    },
  },
  {
    // e44: ui тянет транспорт (hono, entry в dist/). Из packages/ui hono не
    // резолвится по bare-спецификатору (изолированные node_modules pnpm), а
    // канарейка не делает install — зонд идёт относительным путём в хоист-каталог
    // pnpm: тот же realpath, что получил бы резолвер после добавления зависимости.
    name: 'ui тянет hono из dist',
    steps: 'boundaries',
    failedStep: 'boundaries',
    expect: /ui-is-presentational/,
    apply: (root) =>
      write(
        root,
        'packages/ui/src/evil-hono-probe.ts',
        "import { Hono } from '../../../node_modules/.pnpm/node_modules/hono/dist/index.js';\n\nexport const evil = () => new Hono();\n",
      ),
  },
  // e47: канарейки остальных правил границ — покрытие по правилам, а не по шагу
  // (инвариант «правило → канарейка» — в tools/test/gates-canary.test.ts).
  {
    // Оба модуля лежат в корне apps/api/src: правило
    // api-domain-independent-of-transport смотрит только на подкаталоги src/.
    name: 'цикл импортов',
    steps: 'boundaries',
    failedStep: 'boundaries',
    expect: /no-circular/,
    apply: (root) => {
      write(
        root,
        'apps/api/src/evil-cycle-a.ts',
        "import { evilB } from './evil-cycle-b.ts';\n\nexport const evilA = (): number => evilB;\n",
      );
      write(
        root,
        'apps/api/src/evil-cycle-b.ts',
        "import { evilA } from './evil-cycle-a.ts';\n\nexport const evilB = (): number => evilA;\n",
      );
    },
  },
  {
    name: 'пакет импортирует приложение',
    steps: 'boundaries',
    failedStep: 'boundaries',
    expect: /packages-not-to-apps/,
    apply: (root) =>
      write(
        root,
        'packages/ui/src/evil-apps-probe.ts',
        "import { apiBaseUrl } from '../../../apps/web/src/lib/env.ts';\n\nexport const evil = apiBaseUrl;\n",
      ),
  },
  {
    // Приложения общаются только через @repo/contracts.
    name: 'приложение импортирует приложение',
    steps: 'boundaries',
    failedStep: 'boundaries',
    expect: /no-app-to-app/,
    apply: (root) =>
      write(
        root,
        'apps/api/src/evil-app-probe.ts',
        "import { apiBaseUrl } from '../../web/src/lib/env.ts';\n\nexport const evil = apiBaseUrl;\n",
      ),
  },
  {
    name: 'e2e импортирует код приложения',
    steps: 'boundaries',
    failedStep: 'boundaries',
    expect: /e2e-black-box/,
    apply: (root) =>
      write(
        root,
        'e2e/evil-black-box-probe.spec.ts',
        "import { apiBaseUrl } from '../apps/web/src/lib/env.ts';\n\nexport const evil = apiBaseUrl;\n",
      ),
  },
  {
    // Опечатка в пути, переименованный или удалённый файл.
    name: 'неразрешимый импорт',
    steps: 'boundaries',
    failedStep: 'boundaries',
    expect: /not-to-unresolvable/,
    apply: (root) =>
      write(
        root,
        'apps/api/src/evil-unresolvable-probe.ts',
        "import { evil } from './evil-does-not-exist.ts';\n\nexport const probe = evil;\n",
      ),
  },
  {
    // Пакет импортируется в обход exports (architecture.md, 2.1). Ожидание —
    // not-to-unresolvable, а не no-deep-package-imports: то правило на текущем
    // дереве недостижимо (причина — BOUNDARIES_RULE_CANARY_EXEMPT в
    // gates-canary.test) — подпуть вне exports-карты не разрешается.
    // Канарейка страхует закон: открой в exports подстановку подпутей — импорт
    // разрешится без нарушений, шаг останется зелёным, и канарейка скажет «НЕ
    // УПАЛ». Поэтому зонд ведёт на существующий внутренний модуль пакета:
    // несуществующий путь неразрешим при любой exports-карте и повторял бы
    // «неразрешимый импорт». Якорь проверяется — модуль исчезнет, и прогон
    // упадёт здесь, а не пройдёт впустую.
    name: 'глубокий импорт пакета',
    steps: 'boundaries',
    failedStep: 'boundaries',
    expect: /not-to-unresolvable/,
    apply: (root) => {
      if (!existsSync(join(root, 'packages', 'contracts', 'src', 'tasks.ts'))) {
        throw new Error('canary anchor not found: packages/contracts/src/tasks.ts');
      }
      write(
        root,
        'apps/api/src/evil-deep-probe.ts',
        "import { TaskSchema } from '@repo/contracts/src/tasks';\n\nexport const evil = TaskSchema;\n",
      );
    },
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
    // Хардненинг strict-флагов (b13): соседние канарейки «type-ошибка» вставляют
    // ошибку, видимую и без strict, — ослабление noUncheckedIndexedAccess/
    // strict в tsconfig остаётся зелёным. Проба ловит ошибку TS2532
    // («Object is possibly 'undefined'») ТОЛЬКО при noUncheckedIndexedAccess
    // (проверено: `tsc --strict` на той же пробе зелёный). Ослабление флага в
    // tsconfig.base.json или пакетном tsconfig делает пробу компилируемой,
    // шаг typecheck зелёным — и канарейка красная (защита в глубину: код
    // tsconfig покрыт CODEOWNERS, инвариант пробы — в gates-canary.test.ts).
    name: 'strict-флаг tsconfig ослаблен',
    steps: 'typecheck',
    failedStep: 'typecheck',
    expect: /evil-strict-probe/,
    apply: (root) =>
      write(
        root,
        'apps/api/src/evil-strict-probe.ts',
        'export const evilStrictProbe = (([] as string[])[0]).length;\n',
      ),
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
    // b14: build до этой канарейки жил только в union соседей («build,bundle»):
    // инвариант таблицы проходил формально, а красный сам build (fail-open дрейф
    // шага — скрипт, раннер, тихий пропуск задачи) не детектировал никто:
    // удаление шага ловит gates-canary.test, исчезновение turbo-задачи —
    // required-tasks, прогон сломанной сборки — никто. Проба — битый ассет-импорт
    // в клиентском модуле import-графа index-роута (orphan-модули tree-shaken,
    // не годятся): резолвер Vite не находит файл ([UNRESOLVED_IMPORT]), сборка
    // краснеет детерминированно и offline.
    name: 'битый ассет в клиентском модуле',
    steps: 'build',
    full: true,
    failedStep: 'build',
    expect: /evil-build-probe/,
    apply: (root) => {
      const path = join(root, 'apps', 'web', 'src', 'features', 'tasks', 'use-tasks.ts');
      const source = readFileSync(path, 'utf8');
      if (!source.includes("from '../../lib/api-client.ts'")) {
        throw new Error('canary anchor not found: use-tasks.ts has no lib import');
      }
      writeFileSync(path, `${source}\nimport './evil-build-probe.png';\n`);
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
    // канарейку от одиночного флака (ADR 0005). Прокси, который под тестом,
    // — production (C3.4: e2e webServer стартует `node server.ts`), поэтому
    // якорь — регистрация роутов в server-app.ts; vite-прокси dev/preview
    // e2e больше не красит (роут /rpc перекрыт до '*' -обработчиков).
    name: 'прокси /rpc удалён',
    steps: 'e2e',
    full: true,
    failedStep: 'e2e',
    expect: /([2-9]|\d{2,})\s+failed/,
    apply: (root) => {
      const path = join(root, 'apps/web/src/server-app.ts');
      const source = readFileSync(path, 'utf8');
      const routes = rpcRoutes(source);
      if (routes === null) {
        throw new Error(
          'canary anchor not found: apps/web/src/server-app.ts has no /rpc route registration',
        );
      }
      // Роуты переименовываются, а не удаляются: proxyRpc остаётся занятым,
      // файл остаётся линт-чистым, а /rpc уходит в '*' -обработчики (SSR) —
      // тот же режим массового падения, что у удаления vite-прокси.
      const stripped = source
        .replace(routes.main.text, rpcRouteAs(routes.main, '/__canary_no_rpc__'))
        .replace(routes.sub.text, rpcRouteAs(routes.sub, '/__canary_no_rpc__/*'));
      writeFileSync(path, stripped);
    },
  },
  {
    // Правило «через web-origin доступен только /rpc» (ADR 0005) закреплено
    // e2e-тестом api-origin; канарейка гарантирует, что тест не перестанет
    // ловить: добавленный в прокси production-сервера (server-app.ts, C3.4 —
    // e2e webServer стартует `node server.ts`) /__test__ красит e2e его
    // тестом: путь уходит на API, тест видит его ответ вместо 404 web.
    // Якорь — заголовок теста: он остаётся в хвосте вывода Playwright, текст
    // ассерта вылетает из 60 строк (наблюдалось в первом прогоне канарейки).
    name: '/__test__ добавлен в прокси',
    steps: 'e2e',
    full: true,
    failedStep: 'e2e',
    expect: /test API is not reachable through the web origin/,
    apply: (root) => {
      const path = join(root, 'apps/web/src/server-app.ts');
      const source = readFileSync(path, 'utf8');
      const routes = rpcRoutes(source);
      if (routes === null) {
        throw new Error(
          'canary anchor not found: apps/web/src/server-app.ts has no /rpc route registration',
        );
      }
      const leaked = source.replace(
        routes.main.text,
        [
          routes.main.text,
          rpcRouteAs(routes.main, '/__test__'),
          rpcRouteAs(routes.sub, '/__test__/*'),
        ].join('\n'),
      );
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
    // Дифф вне touches задачи (D7, З6): шаг verify → pnpm branch-scope:check.
    // Плохое изменение — посторонний файл в рабочем дереве ветки task/*: гейт
    // красит «файлы вне touches задачи». Раннер канареек создаёт worktree от
    // HEAD (detached — гейт пропустил бы ветку), поэтому apply переключает
    // пробную ветку task/evil-touches-probe, как канарейка замыкания выше.
    // Fail-closed «файла задачи probe нет в main» выводится тем же прогоном,
    // но expect матчит именно посторонний файл: ослабление проверки файлов
    // (при живом fail-closed) делает канарейку громкой. Ветка probe переживает
    // прогон (образец task/evil-probe), файлы откатывает checkout+clean.
    name: 'дифф вне touches задачи',
    steps: 'branch-scope',
    failedStep: 'branch-scope',
    expect: /docs\/evil-touches-probe\.md/,
    apply: (root) => {
      write(root, 'docs/evil-touches-probe.md', '# вне touches\n');
      const result = spawnSync('git', ['switch', '-C', 'task/evil-touches-probe'], {
        cwd: root,
        encoding: 'utf8',
      });
      if (result.status !== 0) {
        throw new Error(
          `canary setup failed: cannot create task/evil-touches-probe: ${result.stderr}`,
        );
      }
    },
  },
  {
    // Проводка branch-scope (D7, З5): script → гейт. Плохое изменение —
    // branch-scope:check удалён из package.json: шаг ломается, дифф ветки
    // перестаёт сверяться с touches, wiring-тест в
    // tools/test/check-branch-scope краснеет. Образец — канарейка tool-class:
    // срывается именно скрипт, а не шаг verify-steps (шум соседних
    // инвариант-тестов вытесняет якорь из хвоста отчёта).
    name: 'branch-scope:check отвязан от package.json',
    steps: 'test:hooks',
    failedStep: 'test:hooks',
    expect: /проводка: шаг branch-scope в verify/,
    apply: (root) => {
      const path = join(root, 'package.json');
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!isRecord(parsed) || !isRecord(parsed['scripts'])) {
        throw new Error('canary anchor not found: package.json scripts');
      }
      const scripts = parsed['scripts'];
      if (scripts['branch-scope:check'] !== 'node tools/check-branch-scope.ts') {
        throw new Error('canary anchor not found: no branch-scope:check script');
      }
      delete scripts['branch-scope:check'];
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
    // E1: turbo.json обязан соответствовать каноническому списку входов
    // //#test:hooks (tools/test-hooks-inputs.ts): пропущенный input — тихо
    // устаревший зелёный результат (З6). Красит тест синхронизации в test:hooks.
    // Плохое изменение — пополнение канонического списка без turbo.json: mutation
    // в tools/** гарантированно меняет хеш задачи (turbo свой конфиг в хеш
    // задачи с явными inputs не включает — проверено первым прогоном канарейки:
    // правка turbo.json реплеила кэш и канарейка не срабатывала).
    name: 'test:hooks inputs разошлись с каноническим списком',
    steps: 'test:hooks',
    failedStep: 'test:hooks',
    // Основа слова: имя теста стоит в творительном падеже («каноническим
    // списком») — номинатив в expect не матчился и канарейка не засчитывалась
    // при красном гейте (первый прогон).
    expect: /каноническ/,
    apply: (root) => {
      const path = join(root, 'tools', 'test-hooks-inputs.ts');
      const source = readFileSync(path, 'utf8');
      if (!source.includes("'pnpm-lock.yaml',")) {
        throw new Error('canary anchor not found: TEST_HOOKS_INPUTS');
      }
      writeFileSync(path, source.replace("'pnpm-lock.yaml',", "'pnpm-lock.yaml',\n  'docs/**',"));
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
  {
    // b7: реестры держат одну строку на домен по алфавиту — конфликты
    // слияния тривиальны. Плохое изменение — перестановка строк в UI-реестре;
    // красит шаг registries (tools/check-registries.ts).
    name: 'порядок реестров нарушен',
    steps: 'registries',
    failedStep: 'registries',
    expect: /не в алфавитном порядке/,
    apply: (root) => {
      const path = join(root, 'packages', 'ui', 'src', 'index.ts');
      const source = readFileSync(path, 'utf8');
      const button =
        "export { Button, type ButtonProps, type ButtonVariant } from './button/button.tsx';";
      const errorState =
        "export { ErrorState, type ErrorStateProps } from './error-state/error-state.tsx';";
      if (!source.includes(button) || !source.includes(errorState)) {
        throw new Error('canary anchor not found: ui registry exports');
      }
      writeFileSync(
        path,
        source
          .replace(button, '__SWAP__')
          .replace(errorState, button)
          .replace('__SWAP__', errorState),
      );
    },
  },
  {
    // Состав workspace (e20): turbo-прогон без носителей обязательной задачи
    // завершается exit 0, поэтому последний носитель mutation может исчезнуть
    // тихо. Плохое изменение — все три пакета-носителя (apps/api, apps/web,
    // packages/contracts) теряют скрипт: шаг required-tasks краснеет сообщением
    // чекера. Призраки <NONEXISTENT> (@repo/e2e, @repo/preflight, @repo/ui —
    // задача из глобального определения turbo.json без скрипта) носителями не
    // считаются — тот же фильтр, что в чекере.
    name: 'последний носитель mutation потерял задачу',
    steps: 'required-tasks',
    failedStep: 'required-tasks',
    expect: /mutation: ни одного пакета/,
    apply: (root) => {
      for (const pkg of ['apps/api', 'apps/web', 'packages/contracts']) {
        const path = join(root, ...pkg.split('/'), 'package.json');
        const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
        if (!isRecord(parsed) || !isRecord(parsed['scripts'])) {
          throw new Error(`canary anchor not found: ${pkg}/package.json scripts`);
        }
        const scripts = parsed['scripts'];
        if (typeof scripts['mutation'] !== 'string') {
          throw new Error(`canary anchor not found: ${pkg} has no mutation script`);
        }
        delete scripts['mutation'];
        writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
      }
    },
  },
  {
    // Частичное выключение (b13): удаление скрипта mutation из ОДНОГО носителя
    // при живых остальных раньше оставало гейт зелёным — мутационный гейт
    // пакета выключался тихо (test-count warning-only, отчёту test-report
    // нечего требовать у исчезнувшего скрипта). Гейт b13 красит носителей
    // меньше MIN_CARRIERS: проба удаляет mutation у apps/api — остаются два
    // носителя при минимуме 3.
    name: 'носитель mutation потерял скрипт',
    steps: 'required-tasks',
    failedStep: 'required-tasks',
    expect: /mutation: носителей 2, минимум 3/,
    apply: (root) => {
      const path = join(root, 'apps', 'api', 'package.json');
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!isRecord(parsed) || !isRecord(parsed['scripts'])) {
        throw new Error('canary anchor not found: apps/api/package.json scripts');
      }
      const scripts = parsed['scripts'];
      if (typeof scripts['mutation'] !== 'string') {
        throw new Error('canary anchor not found: apps/api has no mutation script');
      }
      delete scripts['mutation'];
      writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
    },
  },
  {
    // Гейт дрейфа routeTree.gen.ts (b7.1, З10): committed-файл обязан
    // совпадать со свежей генерацией без сборки. Плохое изменение — ручная
    // правка производного файла (то, для чего гейт сделан): шаг routetree
    // краснеет сообщением с `pnpm regen`. routeTree.gen.ts не защищён —
    // правка канарейки легальна, файл возвращает checkout+clean (образец —
    // канарейка реестров b7).
    name: 'ручная правка routeTree.gen.ts',
    steps: 'routetree',
    failedStep: 'routetree',
    expect: /отличается от свежей генерации/,
    apply: (root) => {
      const path = join(root, 'apps', 'web', 'src', 'routeTree.gen.ts');
      const source = readFileSync(path, 'utf8');
      if (!source.includes("declare module '@tanstack/react-start'")) {
        throw new Error('canary anchor not found: routeTree.gen.ts has no Start footer');
      }
      writeFileSync(path, `${source}\n// evil routetree drift probe\n`);
    },
  },
  {
    // Табличный тест доступа «чужой ресурс — отказ» (C2.3, C2.4): owner-процедуры
    // перебираются из реального роутера (collectProcedures + accessPolicyFromMeta),
    // целостность генерации красит набор. Плохое изменение — owner-процедура
    // с валидной meta, добавленная в копии контракта и роутера: перебор C2.0 её
    // пропускает (политика объявлена), router-divergence зелёный (контракт ≡
    // роутер) — её замечает только генерация таблицы (тест «no empty rows» и
    // ячейки it.each через scenarioOf). Красит гейт зонд, а не сужение: тихое
    // сужение генерации (фильтр перебора, хардкод списка) сделало бы зонд
    // невидимым и шаг зелёным — тогда канарейка красная, и обезвреживание
    // таблицы становится громким (З6). Граница: держится проводка генерации
    // (перебор → integrity-тесты → it.each), не тела строк сценария. Якоря:
    // первая `\n};` — закрывающая скобка contract-объекта tasks.ts (образец —
    // канарейка «процедура контракта без политики доступа»); `\n  },\n});` —
    // закрытие объекта tasks и os.router (единственное `\n});` в файле).
    // Вставлять перед `\n});` нельзя: зонд оказался бы рядом с tasks, а не
    // внутри, путь терял бы префикс (наблюдение первого dry-run: перебор видел
    // «evilOwnerProbe» вместо «tasks.evilOwnerProbe»). Вторая правка
    // обязательна: роутер содержит только объявленные handler'ы, контрактный
    // зонд без handler'а до перебора не доходит и шаг остаётся зелёным.
    name: 'owner-процедура без строки сценария таблицы',
    steps: 'test',
    failedStep: 'test',
    expect: /access scenario row for tasks\.evilOwnerProbe/,
    apply: (root) => {
      const contractPath = join(root, 'packages', 'contracts', 'src', 'tasks.ts');
      const contract = readFileSync(contractPath, 'utf8');
      const withProbe = contract.replace(
        /\n};/,
        `\n  evilOwnerProbe: ocAccess
    .route({ method: 'DELETE', path: '/tasks/evil-owner-probe', summary: 'Evil owner probe' })
    .meta({ access: { type: 'owner' } })
    .input(TaskIdInputSchema)
    .output(z.void()),
};`,
      );
      if (withProbe === contract) {
        throw new Error('canary anchor not found: contracts/src/tasks.ts has no closing brace');
      }
      writeFileSync(contractPath, withProbe);
      const routerPath = join(root, 'apps', 'api', 'src', 'router.ts');
      const router = readFileSync(routerPath, 'utf8');
      const withHandler = router.replace(
        /\n  },\n}\);/,
        `\n    evilOwnerProbe: os.tasks.evilOwnerProbe.handler(async () => {}),\n  },\n});`,
      );
      if (withHandler === router) {
        throw new Error('canary anchor not found: apps/api/src/router.ts has no tasks closing');
      }
      writeFileSync(routerPath, withHandler);
    },
  },
];
// Вывод портов (З9, A5 PR-3) канарейки шага не имеет: рантайм читает записанный
// reports/ports.json (read-first — иначе зонд после старта серверов уезжал на
// чужой порт), сломанный выбор — мёртвый код для рантайма. Инвариант
// «web и api не совпадают» канареечен юнит-тестом pickPorts (tools/test/
// ports.test.ts), реальная коллизия красит e2e натурально (EADDRINUSE).
