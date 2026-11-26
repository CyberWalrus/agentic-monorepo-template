/**
 * Канарейка копии шаблона (d8.3; ADR 0008, «Проверка»): `copier copy` из
 * закоммиченного HEAD (--vcs-ref=HEAD обязателен — без него copier молча
 * создаёт пустую копию и выходит с кодом 0, журнал d8; канарейки проверяют
 * закоммиченное состояние, как и run-gate-canaries), проверка содержимого
 * tools/check-template-copy.ts, затем шаги раздела 8 docs/github-setup.md —
 * дословно теми же командами, что выполняет человек (d8.8): копия становится
 * git-репозиторием с первым коммитом, публикуется в origin (для канарейки —
 * bare-репозиторий во временном каталоге вместо GitHub), в ней
 * `pnpm install && pnpm verify`.
 *
 * Канарейка идёт по документированному рецепту, а не по своему: командные
 * строки блока «в копии» раздела 8 сверяются с COPY_STEPS до запуска copier,
 * любое расхождение красит прогон. Шаг, которого нет в инструкции (до d8.8 —
 * OPENAPI_COMPAT_ALLOW_HEAD_BASE=1), больше не может сделать CI зелёным на
 * красной для потребителя дороге: базу сравнения контракта копии даёт
 * origin/main после пуша. Инверсионная проба (detectorProbe) проверяет сам
 * детектор на мутациях текста раздела.
 *
 * Синтетический потомок (d8.7) — вторая половина прогона, механика
 * обновления: `copier update` переносит разницу версий шаблона в проект,
 * сохраняя правки проекта. Потомок собирается из настоящего copier и
 * настоящих версий: копия из последнего тега `v*` (что человек копирует
 * сегодня) проходит шаги раздела 8 «в копии» без последнего, в неё
 * коммитится правка «проекта» (строка в README), `copier update` до
 * закоммиченного HEAD (то, что станет следующим тегом; на коммите выпуска
 * HEAD и есть следующий тег), проверка дерева, коммит и пуш в origin копии
 * (база сравнения контракта — документированный канал раздела 8, без
 * OPENAPI_COMPAT_ALLOW_HEAD_BASE), `pnpm install && pnpm verify`.
 *
 * Детектор потомка читает дерево и индекс, а не код выхода: при правке одной
 * строки с двух сторон copier 9.19.1 пишет маркеры `<<<<<<< before updating
 * / >>>>>>> after updating` и выходит с кодом 0 (проба 2026-11-26, журнал
 * d8.7). Живость детектора держат негатив-контроль конфликта (второй потомок
 * правит ту же строку, что и шаблон) и инверсионная проба на дереве
 * обновлённого потомка: потерянная правка, приехавший файл разработки,
 * переживший обновление файл прежней версии, не приехавший файл целевой
 * версии, маркеры конфликта — каждая мутация обязана красить прогон.
 *
 * Гоняют CI (canaries.yml — по изменению copier.yml, .github/rulesets/**,
 * пары CODEOWNERS и tools/copier-version.txt — и nightly) и человек. Из
 * песочницы агента не запускается — copier ставится из PyPI, вне allowlist
 * доменов (ADR 0004, З5-исключение в architecture.md): без copier раннер
 * громко уходит в skip, в CI (CI=true) отсутствие copier красит прогон.
 *
 *   pnpm canaries
 */
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { checkCopySide, checkTemplateSide } from './check-template-copy.ts';

const repoRoot = resolve(import.meta.dirname, '..');
const pinnedVersion = readFileSync(join(repoRoot, 'tools/copier-version.txt'), 'utf8').trim();

function run(
  command: string[],
  cwd: string,
  timeoutMs = 120_000,
): { status: number | null; output: string } {
  const [file, ...args] = command;
  if (file === undefined) {
    return { status: -1, output: 'empty command' };
  }
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    cwd,
    timeout: timeoutMs,
    env: { ...process.env, TURBO_TELEMETRY_DISABLED: '1' },
  });
  if (result.error !== undefined) {
    return { status: -1, output: String(result.error) };
  }
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** Установленная версия copier или null, если бинарника нет. */
function copierVersion(): string | null {
  const result = run(['copier', '--version'], repoRoot);
  if (result.status !== 0) {
    return null;
  }
  return result.output.trim();
}

class CanaryFailure extends Error {}

// --- Рецепт раздела 8: сверка канарейки с текстом инструкции ----------------
//
// Документ — источник шагов: командные строки блока «в копии» раздела 8
// обязаны совпадать с COPY_STEPS дословно (recipeDrift). Плейсхолдеры
// документа при исполнении заменяются значениями канарейки.

const RECIPE_DOCUMENT = join('docs', 'github-setup.md');
const RECIPE_START = '## 8. ';
const RECIPE_END = '## 9. ';
/** Каталог копии в команде `cd`. */
const COPY_DIR_PLACEHOLDER = 'путь/до/проекта';
/** Репозиторий проекта на GitHub — канарейка подставляет bare-репозиторий. */
const PROJECT_REMOTE_PLACEHOLDER = 'https://github.com/<владелец-проекта>/<проект>.git';
/** Источник тега в блоке копирования: последний `v*` по номеру версии. */
const TAG_SOURCE = 'tag=$(git ls-remote --tags --refs ';
/** Вид --vcs-ref в блоке копирования: пример не пришпилен к номеру. */
const TAG_REF = '--vcs-ref="$tag"';
/** Шаги раздела 8 «в копии» — дословно командные строки блока документа. */
const COPY_STEPS: readonly string[] = [
  `cd ${COPY_DIR_PLACEHOLDER}`,
  'git init -b main',
  'git add -A',
  'git commit -m "Проект из шаблона"',
  `git remote add origin ${PROJECT_REMOTE_PLACEHOLDER}`,
  'git push -u origin main',
  'pnpm install && pnpm verify',
];
/** Последний шаг раздела 8 «в копии» — у потомка исполняется после обновления. */
const VERIFY_STEP = 'pnpm install && pnpm verify';
/** Шаги раздела 8 до проверки — превращают копию в опубликованный проект. */
const PROJECT_STEPS: readonly string[] = COPY_STEPS.filter((step) => step !== VERIFY_STEP);
/** Шаг, после которого в копии есть origin/main — база сравнения контракта. */
const PUBLISH_STEP = 'git push -u origin main';
/** Ответвлённая команда для мутаций пробы: в инструкции её быть не должно. */
const ALIEN_STEP = 'OPENAPI_COMPAT_ALLOW_HEAD_BASE=1 pnpm install && pnpm verify';

/** Раздел 8 документа тремя частями — мутации пробы применяются к разделу. */
function splitSection(document: string): { before: string; section: string; after: string } {
  const start = document.indexOf(`\n${RECIPE_START}`);
  const end = document.indexOf(`\n${RECIPE_END}`, start + 1);
  if (start === -1 || end === -1) {
    throw new CanaryFailure(
      `${RECIPE_DOCUMENT}: нет раздела «${RECIPE_START}…» до «${RECIPE_END}…» — канарейке не с чем сверять шаги`,
    );
  }
  return {
    before: document.slice(0, start + 1),
    section: document.slice(start + 1, end + 1),
    after: document.slice(end + 1),
  };
}

/** Блок копирования — тот, где есть `copier copy`. */
function isCopySource(block: readonly string[]): boolean {
  return block.some((line) => line.includes('copier copy'));
}

/** Командные строки fenced-блоков раздела: без пустых строк и комментариев, продолжения `\` склеены. */
function commandsOfSection(section: string): {
  copySource: readonly string[];
  inCopy: readonly string[];
} {
  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (const raw of section.split('\n')) {
    if (raw.startsWith('```')) {
      if (current === null) {
        current = [];
      } else {
        blocks.push(current);
        current = null;
      }
      continue;
    }
    if (current === null) {
      continue;
    }
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const previous = current.at(-1);
    if (previous?.endsWith('\\') === true) {
      current[current.length - 1] = `${previous.slice(0, -1).trimEnd()} ${line}`;
    } else {
      current.push(line);
    }
  }
  if (current !== null) {
    throw new CanaryFailure(`${RECIPE_DOCUMENT}: незакрытый блок кода в разделе 8`);
  }
  const commands = blocks.filter((block) => block.length > 0);
  const commandsWhere = (wanted: boolean): string[] =>
    commands.filter((block) => isCopySource(block) === wanted).flat();
  const recipe = { copySource: commandsWhere(true), inCopy: commandsWhere(false) };
  if (recipe.copySource.length === 0 || recipe.inCopy.length === 0) {
    throw new CanaryFailure(
      `${RECIPE_DOCUMENT}: в разделе 8 нет блока копирования (copier copy) или блока команд в копии`,
    );
  }
  return recipe;
}

/** Расхождения раздела 8 с шагами канарейки; пусто — рецепт и канарейка совпадают. */
function recipeDrift(document: string): string[] {
  const { copySource, inCopy } = commandsOfSection(splitSection(document).section);
  const drift: string[] = [];
  const refs = copySource.flatMap((line) =>
    [...line.matchAll(/--vcs-ref=(\S+)/g)].map((match) => match[1] ?? ''),
  );
  if (refs.length === 0) {
    drift.push('раздел 8: в блоке копирования нет --vcs-ref');
  }
  for (const ref of refs) {
    if (ref !== '"$tag"') {
      drift.push(
        `раздел 8: --vcs-ref=${ref} — пример пришпилен к номеру или ведёт не на актуальный тег (ожидается ${TAG_REF})`,
      );
    }
  }
  if (!copySource.some((line) => line.startsWith(TAG_SOURCE))) {
    drift.push(`раздел 8: тег не берётся из тегов шаблона — нет строки «${TAG_SOURCE}…»`);
  }
  for (const step of COPY_STEPS) {
    if (!inCopy.includes(step)) {
      drift.push(`шаг канарейки отсутствует в разделе 8: ${step}`);
    }
  }
  for (const command of inCopy) {
    if (!COPY_STEPS.includes(command)) {
      drift.push(`команда раздела 8 не выполняется канарейкой: ${command}`);
    }
  }
  if (drift.length === 0 && inCopy.join('\n') !== COPY_STEPS.join('\n')) {
    drift.push('раздел 8: порядок шагов в копии расходится с порядком канарейки');
  }
  return drift;
}

/**
 * Инверсионная проба детектора (критерий d8.8): шаг, убранный из инструкции,
 * посторонняя или изменённая команда и пришпиленный --vcs-ref обязаны давать
 * расхождение. Детектор, пропустивший мутацию, слеп — прогон красный.
 * Возвращает описания пропущенных мутаций; пусто — детектор видит все.
 */
function detectorProbe(document: string): string[] {
  const { before, section, after } = splitSection(document);
  const mutate = (from: string, to: string): string => before + section.replace(from, to) + after;
  const blind: string[] = [];
  const expectDrift = (label: string, mutated: string, expected: string): void => {
    if (mutated === document) {
      blind.push(`${label}: якорь мутации не найден в разделе 8`);
      return;
    }
    if (!recipeDrift(mutated).some((line) => line.includes(expected))) {
      blind.push(`${label}: детектор не увидел расхождение`);
    }
  };
  // 1. Каждый шаг по очереди убран из инструкции.
  for (const step of COPY_STEPS) {
    expectDrift(`из раздела 8 убран шаг «${step}»`, mutate(`${step}\n`, ''), step);
  }
  // 2. Посторонняя команда в инструкции — так канарейка до d8.8 обходила
  //    красную для потребителя дорогу.
  expectDrift(
    'в раздел 8 добавлена команда вне канарейки',
    mutate('pnpm install && pnpm verify\n', `${ALIEN_STEP}\n`),
    ALIEN_STEP,
  );
  // 3. Команда изменена.
  const changed = 'git push origin develop';
  expectDrift('команда раздела 8 изменена', mutate(PUBLISH_STEP, changed), changed);
  // 4. Пример пришпилен к номеру тега.
  const pinned = '--vcs-ref=v0.0.0';
  expectDrift('--vcs-ref пришпилен к номеру', mutate(TAG_REF, pinned), pinned);
  return blind;
}

// Сверка рецепта — до проверки copier: расхождение не зависит от того, есть ли
// copier в окружении, и красит прогон в песочнице агента тоже.
const recipeDocument = readFileSync(join(repoRoot, RECIPE_DOCUMENT), 'utf8');
const drift = recipeDrift(recipeDocument);
if (drift.length > 0) {
  for (const line of drift) {
    console.error(`✗ ${line}`);
  }
  console.error(
    'канарейка копии: раздел 8 docs/github-setup.md и шаги канарейки разошлись — ' +
      'канарейка идёт не по документированному рецепту',
  );
  process.exit(1);
}
console.log(
  `рецепт раздела 8: ${COPY_STEPS.length} шагов в копии — дословно совпадают с канарейкой`,
);
const blind = detectorProbe(recipeDocument);
if (blind.length > 0) {
  for (const line of blind) {
    console.error(`✗ ${line}`);
  }
  console.error('канарейка копии: инверсионная проба — детектор расхождений слеп');
  process.exit(1);
}
console.log(
  `инверсионная проба детектора — ok (${COPY_STEPS.length + 3} мутаций раздела 8 красят прогон)`,
);

const isCI = process.env['CI'] === '1' || process.env['CI'] === 'true';
const foundVersion = copierVersion();
if (foundVersion === null) {
  // В CI copier ставится шагом workflow: отсутствие — сломанная проводка,
  // а не окружение агента, поэтому fail-closed (З6); локально — громкий skip.
  const reason =
    `копир (copier) не найден — канарейка копии ставит его из PyPI, вне allowlist ` +
    `доменов песочницы (ADR 0004, З5-исключение). Её гоняют CI (canaries.yml, nightly) и ` +
    `человек: pipx install --force copier==${pinnedVersion}`;
  if (isCI) {
    console.error(`FAILED: ${reason}`);
    process.exit(1);
  }
  console.error(`SKIPPED: ${reason}`);
  process.exit(0);
}
// Точное равенство семантической версии, не подстрока: пин «9.1» не должен
// проходить при установленной «9.19.1» (ревью security/sanity).
const foundSemver = /\d+\.\d+\.\d+/.exec(foundVersion)?.[0];
if (foundSemver !== pinnedVersion) {
  console.error(
    `версия copier (${foundVersion}) расходится с tools/copier-version.txt (${pinnedVersion}) — ` +
      `обновите установку: pipx install --force copier==${pinnedVersion}`,
  );
  process.exit(1);
}

// Шаблонная сторона — до copier copy: детект раньше исполнения (ревью
// security/sanity). В CI чекаут — закоммиченный HEAD PR; локально раннер
// читает рабочее дерево — работу сначала commit (как у run-gate-canaries).
const templateFailures = checkTemplateSide(repoRoot);
if (templateFailures.length > 0) {
  for (const failure of templateFailures) {
    console.error(`✗ [${failure.check}] ${failure.detail}`);
  }
  console.error('канарейка копии: шаблон красный до копирования (детали выше)');
  process.exit(1);
}

// Копия и её origin — во временном каталоге: origin у человека — репозиторий
// проекта на GitHub, у канарейки — bare-репозиторий рядом с копией. Подмена
// только URL (PROJECT_REMOTE_PLACEHOLDER), команды — те же, что в разделе 8.
const workDir = mkdtempSync(join(tmpdir(), 'd88-copy-canary-'));
const copyDir = join(workDir, 'copy');
const originDir = join(workDir, 'origin.git');
/** Снимок свежей копии до шагов рецепта — целевой рендер для потомка (d8.7). */
const headRenderDir = join(workDir, 'head-render');
/** Identity коммита исполнителя: раздел 8 требует user.name и user.email в git — у раннера их нет. */
const PROJECT_IDENTITY = {
  GIT_AUTHOR_NAME: 'copy-canary',
  GIT_AUTHOR_EMAIL: 'copy-canary@example.invalid',
  GIT_COMMITTER_NAME: 'copy-canary',
  GIT_COMMITTER_EMAIL: 'copy-canary@example.invalid',
} as const;
/** Итог потомка (d8.7): not-run — свежая копия красная, обновлять не во что. */
let descendantState: 'not-run' | 'ok' | 'skipped' | 'red' = 'not-run';
// Шаги раздела 8 «в копии» — дословно: каждая командная строка блока уходит
// оболочке как есть (с подставленными плейсхолдерами), в каталоге копии.
// Среда исполнителя, не команды рецепта: identity коммита (раздел 8 требует
// user.name и user.email в git — у раннера их нет), телеметрия turbo
// выключена, шагу с `pnpm verify` — CI=1: тот же режим, что у гейта в CI.
function runRecipeStep(
  step: string,
  dir: string,
  origin: string,
): { status: number | null; output: string } {
  const command = step
    .replaceAll(COPY_DIR_PLACEHOLDER, dir)
    .replaceAll(PROJECT_REMOTE_PLACEHOLDER, origin);
  const attempt = spawnSync('sh', ['-c', command], {
    encoding: 'utf8',
    cwd: dir,
    timeout: 600_000,
    env: {
      ...process.env,
      TURBO_TELEMETRY_DISABLED: '1',
      ...PROJECT_IDENTITY,
      ...(step.includes('pnpm verify') ? { CI: '1' } : {}),
    },
  });
  return {
    status: attempt.error !== undefined ? -1 : attempt.status,
    output:
      attempt.error !== undefined ? String(attempt.error) : `${attempt.stdout}${attempt.stderr}`,
  };
}
// Первый прогон копии — холодный transform vite: тестер browser-режима может
// не уложиться в дефолтные 60 с готовности iframe (browser.connectTimeout)
// либо уронить первый динамический импорт тест-файла (Failed to fetch
// dynamically imported module — тот же холодный transform, наблюдение на
// TasksPage.test.tsx/CreateTaskForm.test.tsx в копии; на загруженном CI
// второй старт тоже может оказаться холодным — поэтому до двух повторов).
// По образцу retry-по-сигналу в run-gate-canaries: латентность холодного
// старта — не вердикт гейта, а ошибка кода копии (падающий импорт в браузере)
// остаётся красной и на тёплых прогонах.
function coldBrowserStart(output: string): boolean {
  return (
    output.includes('did not become ready within') ||
    output.includes('Failed to fetch dynamically imported module')
  );
}

/**
 * Команда канарейки в каталоге проекта (копии или потомка): та же среда
 * исполнителя, что у шагов рецепта; stdin закрыт — copier не ждёт ответов.
 */
function runInProject(
  dir: string,
  command: string[],
  timeoutMs = 120_000,
): { status: number | null; output: string } {
  const [file, ...args] = command;
  if (file === undefined) {
    return { status: -1, output: 'empty command' };
  }
  const attempt = spawnSync(file, args, {
    encoding: 'utf8',
    cwd: dir,
    timeout: timeoutMs,
    input: '',
    env: { ...process.env, TURBO_TELEMETRY_DISABLED: '1', ...PROJECT_IDENTITY },
  });
  return {
    status: attempt.error !== undefined ? -1 : attempt.status,
    output:
      attempt.error !== undefined ? String(attempt.error) : `${attempt.stdout}${attempt.stderr}`,
  };
}

/** Пуш обязан создать origin/main — базу сравнения контракта (канал раздела 8). */
function assertOriginMain(dir: string): void {
  const published = run(['git', 'rev-parse', 'HEAD', 'origin/main'], dir);
  const [head, originMain] = published.status === 0 ? published.output.trim().split('\n') : [];
  if (published.status !== 0 || head === undefined || head !== originMain) {
    throw new CanaryFailure(
      `пуш по рецепту не создал origin/main — базе сравнения контракта взяться неоткуда:\n${published.output.slice(-1500)}`,
    );
  }
}

/** Шаги раздела 8 «в копии» — дословно, с повтором на холодном старте browser-тестера. */
function runRecipeSteps(
  steps: readonly string[],
  label: string,
  dir: string,
  origin: string,
): void {
  for (const [index, step] of steps.entries()) {
    let done = runRecipeStep(step, dir, origin);
    for (let retry = 1; retry <= 2 && done.status !== 0 && coldBrowserStart(done.output);) {
      console.error(
        `тестер browser-режима не уложился в 60 с на холодном transform копии — повтор ${retry}/2 на тёплых кэшах`,
      );
      done = runRecipeStep(step, dir, origin);
      retry += 1;
    }
    if (done.status !== 0) {
      throw new CanaryFailure(
        `шаг ${index + 1}/${steps.length} раздела 8 failed (${step}):\n${done.output.slice(-3000)}`,
      );
    }
    console.log(`  ✓ ${label} ${index + 1}/${steps.length} ${step}`);
    if (step === PUBLISH_STEP) {
      // После пуша база сравнения контракта есть по документированному каналу
      // (origin/main) — без OPENAPI_COMPAT_ALLOW_HEAD_BASE.
      assertOriginMain(dir);
    }
  }
}

/** Коммит в потомке; чистое дерево — коммита нет (обновление ничего не поменяло). */
function commitProject(dir: string, message: string): void {
  const status = runInProject(dir, ['git', 'status', '--porcelain']);
  if (status.status !== 0) {
    throw new CanaryFailure(`git status в потомке failed:\n${status.output.slice(-1500)}`);
  }
  if (status.output.trim() === '') {
    return;
  }
  const added = runInProject(dir, ['git', 'add', '-A']);
  const committed = runInProject(dir, ['git', 'commit', '-q', '-m', message]);
  if (added.status !== 0 || committed.status !== 0) {
    throw new CanaryFailure(
      `коммит «${message}» в потомке failed:\n${`${added.output}${committed.output}`.slice(-2000)}`,
    );
  }
}

// --- Синтетический потомок (d8.7): детектор обновлённого дерева ----------------
//
// Обновление судится по дереву: код выхода copier не свидетельствует ни о
// чём (конфликт — exit 0). Обновлённый потомок прав, когда (1) правка
// «проекта» на месте ровно один раз, (2) конфликтных маркеров не прибавилось,
// (3) чекер копии зелёный — файлов разработки нет, каркас и снимки ruleset на
// месте, (4) дерево обновлённого потомка — это дерево целевой версии плюс
// файлы самого проекта: файлы разработки не приехали, демо-домен прежней
// версии не задублировался, ни один файл целевой версии не потерялся.

/** Правка «проекта»: одна строка в README.md (пример задачи d8.7). */
const EDIT_PATH = 'README.md';
const EDIT_LINE = 'Проект: своя строка (синтетический потомок, канарейка d8.7).';
/** Правка негатив-контроля: проект заменяет строку, которую правит и шаблон. */
const CONFLICT_LINE = 'Проект: своя строка там, где правит и шаблон (канарейка d8.7).';
/** Маркер конфликта copier в начале строки: `<<<<<<< before updating`, `>>>>>>> after updating`. */
const CONFLICT_MARKER = /^(?:<{7}|>{7})(?=\s|$)/gm;
const CONFLICT_PREFIX = 'конфликт обеих сторон помечен маркерами';
/** Каталоги, которых нет в рендере шаблона: `.git` проекта и зависимости. */
const NOT_RENDERED = new Set(['.git', 'node_modules']);
/** Проверки детектора потомка — итог печатается по каждой. */
const DESCENDANT_CHECKS = {
  правка: `правка «проекта» пережила обновление (${EDIT_PATH})`,
  конфликт: 'конфликтных маркеров нет',
  копия: 'файлов разработки нет, каркас и снимки ruleset на месте (checkCopySide)',
  дерево: 'дерево обновлённого потомка равно дереву целевой версии — демо-домен не задублирован',
} as const;

interface DescendantFailure {
  check: keyof typeof DESCENDANT_CHECKS;
  detail: string;
}

/** Файлы дерева — относительные пути по алфавиту, без `.git` и `node_modules`. */
function treeFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!NOT_RENDERED.has(entry.name)) {
          visit(full);
        }
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(relative(root, full));
      }
    }
  };
  visit(root);
  return files.toSorted();
}

/** Снимок дерева без `.git`: детектор и его мутации читают каталоги, а не репозиторий. */
function snapshotTree(from: string, to: string): void {
  cpSync(from, to, {
    recursive: true,
    filter: (source) => !NOT_RENDERED.has(basename(source)),
  });
}

/** Текст файла; null — файла нет или он бинарный (NUL в начале). */
function textOf(path: string): string | null {
  if (!existsSync(path)) {
    return null;
  }
  const bytes = readFileSync(path);
  return bytes.subarray(0, 8000).includes(0) ? null : bytes.toString('utf8');
}

/** Файлы совпадают байт в байт (оба на месте). */
function sameFile(left: string, right: string): boolean {
  return existsSync(left) && existsSync(right) && readFileSync(left).equals(readFileSync(right));
}

/** Число конфликтных маркеров в тексте. */
function countMarkers(text: string | null): number {
  return text === null ? 0 : [...text.matchAll(CONFLICT_MARKER)].length;
}

/** Число строк текста: перевод в конце файла строкой не считается. */
function lineCountOf(text: string): number {
  return text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

/** Изменённый участок старой версии файла. */
interface Hunk {
  /** Первая затронутая строка старой версии. */
  start: number;
  /** Удалённые строки старой версии; 0 — чистая вставка после start. */
  removed: number;
}

/** Изменённые участки между двумя версиями текста — `git diff --no-index -U0`. */
function diffHunks(basePath: string, targetPath: string): Hunk[] {
  const diff = run(['git', 'diff', '--no-index', '-U0', '--', basePath, targetPath], repoRoot);
  // 0 — файлы равны, 1 — различаются; остальное — отказ самого git.
  if (diff.status !== 0 && diff.status !== 1) {
    throw new CanaryFailure(
      `git diff --no-index ${basePath} → ${targetPath} failed:\n${diff.output.slice(-1500)}`,
    );
  }
  return [...diff.output.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)].map(
    (match): Hunk => ({
      start: Number(match[1]),
      removed: match[2] === undefined ? 1 : Number(match[2]),
    }),
  );
}

/** Строки старой версии, которые шаблон удалил или переписал. */
function changedLines(hunks: readonly Hunk[]): Set<number> {
  const changed = new Set<number>();
  for (const { start, removed } of hunks) {
    for (let line = start; line < start + removed; line += 1) {
      changed.add(line);
    }
  }
  return changed;
}

/**
 * changedLines плюс их соседи: правка «проекта» вплотную к участку, который
 * правит шаблон, конфликтна при трёхстороннем слиянии — канарейка не должна
 * подстраивать конфликт собственным выбором места.
 */
function unstableLines(hunks: readonly Hunk[], lineCount: number): Set<number> {
  const unstable = new Set<number>();
  for (const { start, removed } of hunks) {
    const first = removed === 0 ? start : start - 1;
    const last = removed === 0 ? start + 1 : start + removed;
    for (let line = Math.max(first, 1); line <= Math.min(last, lineCount); line += 1) {
      unstable.add(line);
    }
  }
  return unstable;
}

/** Вставка после строки k — дальше всего от изменённых шаблоном строк; при равенстве — выше. */
function pickEditLine(unstable: ReadonlySet<number>, lineCount: number): number {
  let best = 1;
  let bestDistance = -1;
  for (let line = 1; line <= lineCount; line += 1) {
    let distance = Number.POSITIVE_INFINITY;
    for (const changed of unstable) {
      distance = Math.min(distance, Math.abs(line - changed), Math.abs(line + 1 - changed));
    }
    if (distance > bestDistance) {
      best = line;
      bestDistance = distance;
    }
  }
  return best;
}

/** Сравнение версий `vX.Y.Z`: отрицательное — left новее (сортировка по убыванию). */
function compareVersions(left: string, right: string): number {
  const leftKey = left.slice(1).split('.').map(Number);
  const rightKey = right.slice(1).split('.').map(Number);
  for (const [index, part] of leftKey.entries()) {
    const other = rightKey[index] ?? 0;
    if (part !== other) {
      return other - part;
    }
  }
  return 0;
}

/** Теги шаблона `vX.Y.Z` — по убыванию версии. */
function versionTags(): string[] {
  const listed = run(['git', 'tag', '-l', 'v*'], repoRoot);
  if (listed.status !== 0) {
    throw new CanaryFailure(`git tag -l failed:\n${listed.output.slice(-1500)}`);
  }
  return listed.output
    .split('\n')
    .map((tag) => tag.trim())
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag))
    .toSorted(compareVersions);
}

/** Обе версии обновления потомка — исходное и целевое дерево. */
interface DescendantBase {
  /** Снимок потомка до правки — рендер предыдущей версии. */
  beforeDir: string;
  /** Снимок свежей копии из HEAD — рендер целевой версии. */
  targetDir: string;
  /** Файлы рендера предыдущей версии. */
  previous: readonly string[];
  /** Файлы проекта до обновления: рендер предыдущей версии плюс файлы проекта. */
  before: readonly string[];
  /** Файлы целевой версии. */
  target: readonly string[];
  /** Ждёт ли детектор строку правки «проекта» (негатив-контроль правит другое). */
  expectEdit: boolean;
}

/**
 * Проверка обновлённого потомка; пусто — обновление перенесло версию шаблона,
 * не потеряв и не продублировав ничего. Нарушения — по проверкам
 * DESCENDANT_CHECKS.
 */
function descendantFailures(dir: string, base: DescendantBase): DescendantFailure[] {
  const failures: DescendantFailure[] = [];
  const fail = (check: DescendantFailure['check'], detail: string): void => {
    failures.push({ check, detail });
  };

  const after = treeFiles(dir);
  const afterSet = new Set(after);
  const targetSet = new Set(base.target);
  const previousSet = new Set(base.previous);
  // Файлы самого проекта — шаблон их не рендерит, обновление их не касается.
  const projectOwned = new Set(base.before.filter((path) => !previousSet.has(path)));

  // 1. Правка «проекта» на месте ровно один раз.
  const readme = textOf(join(dir, EDIT_PATH));
  const occurrences =
    readme === null ? 0 : readme.split('\n').filter((line) => line === EDIT_LINE).length;
  if (base.expectEdit && occurrences === 0) {
    fail(
      'правка',
      `правка «проекта» потеряна при обновлении: в ${EDIT_PATH} нет строки «${EDIT_LINE}»`,
    );
  }
  if (base.expectEdit && occurrences > 1) {
    fail(
      'правка',
      `правка «проекта» продублирована при обновлении: ${occurrences} раза в ${EDIT_PATH}`,
    );
  }

  // 2. Конфликт обеих сторон: маркеров стало больше, чем в обеих родительских
  //    версиях, — маркеры, принесённые самим шаблоном или проектом, не конфликт.
  for (const path of after) {
    const marked = countMarkers(textOf(join(dir, path)));
    if (marked === 0) {
      continue;
    }
    const inherited = Math.max(
      countMarkers(textOf(join(base.beforeDir, path))),
      countMarkers(textOf(join(base.targetDir, path))),
    );
    if (marked > inherited) {
      fail('конфликт', `${CONFLICT_PREFIX}: ${path} — обновление не сведено, разбирать человеку`);
    }
  }

  // 3. Чекер копии — файлы разработки не приехали повторно.
  for (const failure of checkCopySide(repoRoot, dir)) {
    fail('копия', `[${failure.check}] ${failure.detail}`);
  }

  // 4. Дерево обновлённого потомка = дерево целевой версии плюс файлы проекта.
  for (const path of after) {
    if (targetSet.has(path) || projectOwned.has(path)) {
      continue;
    }
    fail(
      'дерево',
      previousSet.has(path)
        ? `файл прежней версии пережил обновление — демо-домен или иной файл шаблона задублирован: ${path}`
        : `при обновлении приехал файл, которого нет в целевой версии шаблона: ${path}`,
    );
  }
  for (const path of base.target) {
    if (afterSet.has(path)) {
      continue;
    }
    const renamed = base.previous.find(
      (old) => old.toLowerCase() === path.toLowerCase() && !targetSet.has(old),
    );
    fail(
      'дерево',
      `файл целевой версии не приехал при обновлении: ${path}${
        renamed === undefined
          ? ''
          : ` — шаблон переименовал ${renamed} только по регистру, на регистронезависимой ФС copier теряет файл (находка d8.7)`
      }`,
    );
  }
  return failures;
}

/**
 * Негатив-контроль конфликта — место, где проект правит то же, что и шаблон:
 * первая переписанная шаблоном непустая строка первого изменённого текстового
 * файла (README предпочитается). null — шаблон между версиями не переписал
 * ни одной текстовой строки, конфликту взяться неоткуда.
 */
function conflictSpot(base: DescendantBase): { path: string; line: number } | null {
  const changed = base.target.filter((path) => {
    const before = join(base.beforeDir, path);
    return (
      base.previous.includes(path) &&
      path !== '.copier-answers.yml' &&
      existsSync(before) &&
      !sameFile(before, join(base.targetDir, path))
    );
  });
  const ordered = [EDIT_PATH, ...changed.filter((path) => path !== EDIT_PATH)];
  for (const path of ordered) {
    const before = textOf(join(base.beforeDir, path));
    if (before === null || textOf(join(base.targetDir, path)) === null) {
      continue;
    }
    const lines = before.split('\n');
    const rewritten = [
      ...changedLines(diffHunks(join(base.beforeDir, path), join(base.targetDir, path))),
    ].toSorted((left, right) => left - right);
    for (const line of rewritten) {
      const text = lines[line - 1];
      if (text !== undefined && text.trim() !== '') {
        return { path, line };
      }
    }
  }
  return null;
}

/**
 * Инверсионная проба детектора потомка: мутации дерева обновлённого потомка
 * (каждая — на свежей копии) обязаны давать нарушение с ожидаемым текстом.
 * Возвращает пропущенные мутации; пусто — детектор видит все.
 */
function descendantProbe(
  afterDir: string,
  base: DescendantBase,
  scratchDir: string,
): { blind: string[]; mutations: number } {
  const missed: string[] = [];
  let mutations = 0;
  const expectFailure = (label: string, expected: string, mutate: (dir: string) => void): void => {
    mutations += 1;
    const mutant = join(scratchDir, `mutant-${mutations}`);
    cpSync(afterDir, mutant, { recursive: true });
    mutate(mutant);
    if (!descendantFailures(mutant, base).some((failure) => failure.detail.includes(expected))) {
      missed.push(`${label}: детектор не увидел`);
    }
  };
  const readmeOf = (dir: string): string => join(dir, EDIT_PATH);

  // 1. Правка стёрта — шаблон перезаписал строку проекта своей версией.
  expectFailure(
    'правка «проекта» стёрта при обновлении',
    'правка «проекта» потеряна при обновлении',
    (dir) => {
      writeFileSync(
        readmeOf(dir),
        readFileSync(readmeOf(dir), 'utf8').replaceAll(`${EDIT_LINE}\n`, ''),
      );
    },
  );
  // 2. Файл проекта целиком заменён версией шаблона.
  expectFailure(
    'файл проекта перезаписан шаблоном',
    'правка «проекта» потеряна при обновлении',
    (dir) => {
      cpSync(readmeOf(base.targetDir), readmeOf(dir));
    },
  );
  // 3. Приехал файл разработки из _exclude.
  expectFailure('приехал файл разработки шаблона', 'файл разработки шаблона: backlog', (dir) => {
    mkdirSync(join(dir, 'backlog', 'done'), { recursive: true });
    writeFileSync(join(dir, 'backlog', 'done', 'evil.md'), '# утечка\n');
  });
  // 4. Файл прежней версии пережил обновление (демо-домен задублирован);
  //    между версиями нет удалённых файлов — рядом с демо-доменом появляется лишний.
  const stale = base.previous.find((path) => !base.target.includes(path));
  const victim = base.target.find((path) => path.startsWith('apps/web/src/'));
  if (stale !== undefined) {
    expectFailure('файл прежней версии пережил обновление', `задублирован: ${stale}`, (dir) => {
      mkdirSync(dirname(join(dir, stale)), { recursive: true });
      writeFileSync(join(dir, stale), 'пережил обновление\n');
    });
  } else if (victim !== undefined) {
    expectFailure(
      'лишний файл рядом с демо-доменом',
      `целевой версии шаблона: ${victim}.duplicate`,
      (dir) => {
        cpSync(join(dir, victim), join(dir, `${victim}.duplicate`));
      },
    );
  }
  // 5. Файл целевой версии не приехал.
  const missing = base.target.find((path) => path.startsWith('apps/api/src/'));
  if (missing !== undefined) {
    expectFailure(
      'файл целевой версии не приехал',
      `не приехал при обновлении: ${missing}`,
      (dir) => {
        rmSync(join(dir, missing));
      },
    );
  }
  // 6. Конфликт обеих сторон помечен маркерами.
  expectFailure('конфликт обеих сторон', `${CONFLICT_PREFIX}: ${EDIT_PATH}`, (dir) => {
    appendFileSync(
      readmeOf(dir),
      `\n<<<<<<< before updating\n${EDIT_LINE}\n=======\nшаблон\n>>>>>>> after updating\n`,
    );
  });
  return { blind: missed, mutations };
}

/**
 * Синтетический потомок (d8.7): копия из предыдущего тега → проект по
 * разделу 8 → правка «проекта» → `copier update` до HEAD → проверка дерева →
 * `pnpm install && pnpm verify` → негатив-контроль конфликта и инверсионная
 * проба. Отказ инфраструктуры (copier, git) бросает CanaryFailure; итог
 * механики обновления — возвращаемое состояние (ok / red).
 */
function runDescendant(previousTag: string): 'ok' | 'red' {
  const descendantDir = join(workDir, 'descendant');
  const descendantOrigin = join(workDir, 'descendant-origin.git');
  const beforeDir = join(workDir, 'descendant-before');
  const afterDir = join(workDir, 'descendant-after');
  const headCommit = run(['git', 'rev-parse', '--short=8', 'HEAD'], repoRoot);
  console.log(
    `потомок (d8.7): копия из ${previousTag} → copier update до HEAD (${headCommit.output.trim()})`,
  );

  // Копия из предыдущего тега — то, что человек копирует сегодня. Снимок до
  // первого шага рецепта — рендер предыдущей версии.
  const originReady = run(['git', 'init', '--bare', '-b', 'main', descendantOrigin], repoRoot);
  if (originReady.status !== 0) {
    throw new CanaryFailure(
      `git init --bare (origin потомка) failed:\n${originReady.output.slice(-1500)}`,
    );
  }
  const copyFromTag = (dir: string): ReturnType<typeof run> =>
    run(
      [
        'copier',
        'copy',
        '-q',
        `--vcs-ref=${previousTag}`,
        '-d',
        'project_name=copy-canary-probe',
        '-d',
        'repo_owner=@copy-canary-owner',
        repoRoot,
        dir,
      ],
      repoRoot,
      300_000,
    );
  const copied = copyFromTag(descendantDir);
  if (copied.status !== 0) {
    throw new CanaryFailure(`copier copy из ${previousTag} failed:\n${copied.output.slice(-3000)}`);
  }
  snapshotTree(descendantDir, beforeDir);
  const base: DescendantBase = {
    beforeDir,
    targetDir: headRenderDir,
    previous: treeFiles(beforeDir),
    before: [],
    target: treeFiles(headRenderDir),
    expectEdit: true,
  };

  // Рецепт раздела 8 «в копии» — дословно, без последнего шага: у потомка
  // `pnpm install && pnpm verify` исполняется после обновления.
  console.log(`потомок до обновления: ${PROJECT_STEPS.length} шагов раздела 8 дословно…`);
  runRecipeSteps(PROJECT_STEPS, 'потомок', descendantDir, descendantOrigin);

  // Правка «проекта»: строка README подальше от того, что правит шаблон, —
  // иначе канарейка подстроила бы конфликт собственным выбором места.
  const readme = textOf(join(beforeDir, EDIT_PATH));
  if (readme === null || !base.target.includes(EDIT_PATH)) {
    throw new CanaryFailure(
      `${EDIT_PATH} нет в одной из версий шаблона или он бинарный — правке «проекта» негде жить`,
    );
  }
  if (readme.includes(EDIT_LINE)) {
    throw new CanaryFailure(
      `${EDIT_PATH} шаблона уже содержит строку правки «${EDIT_LINE}» — детектор не отличит её от правки проекта`,
    );
  }
  const count = lineCountOf(readme);
  const readmeDiff = diffHunks(join(beforeDir, EDIT_PATH), join(headRenderDir, EDIT_PATH));
  const insertAfter = pickEditLine(unstableLines(readmeDiff, count), count);
  const lines = readme.split('\n');
  // Правка — отдельный абзац: пустые строки по сторонам, где их нет. Гейт
  // format шаблона форматирует и markdown: строка, приклеенная к заголовку,
  // красила бы verify копии по вине канарейки, а не обновления (первый прогон
  // d8.7). Формат правки проверяется тем же oxfmt до коммита.
  const previousLine = lines[insertAfter - 1];
  const nextLine = lines[insertAfter];
  if (count === 0) {
    lines.splice(0, lines.length, EDIT_LINE, '');
  } else {
    lines.splice(
      insertAfter,
      0,
      ...(previousLine !== undefined && previousLine.trim() !== '' ? [''] : []),
      EDIT_LINE,
      ...(nextLine === undefined || nextLine.trim() !== '' ? [''] : []),
    );
  }
  writeFileSync(join(descendantDir, EDIT_PATH), lines.join('\n'));
  const formatted = run(
    [join(repoRoot, 'node_modules', '.bin', 'oxfmt'), '--check', EDIT_PATH],
    descendantDir,
  );
  if (formatted.status !== 0) {
    throw new CanaryFailure(
      `синтетическая правка не проходит format шаблона (${EDIT_PATH}, после строки ${insertAfter}) — канарейка сама сделала бы проект красным:\n${formatted.output.slice(-1500)}`,
    );
  }
  commitProject(descendantDir, 'Проект: своя правка');
  base.before = treeFiles(descendantDir);
  console.log(
    `правка «проекта»: ${EDIT_PATH}, строка после ${insertAfter} — дальше всего от правок шаблона; закоммичена`,
  );

  // Обновление до закоммиченного HEAD. Детектор читает дерево; код выхода —
  // только для отказа, не оставившего маркеров.
  const updated = runInProject(
    descendantDir,
    ['copier', 'update', '-q', '--defaults', '--vcs-ref=HEAD'],
    300_000,
  );
  console.log(`copier update — exit ${updated.status}`);
  snapshotTree(descendantDir, afterDir);
  const unmerged = run(['git', 'ls-files', '-u'], descendantDir);
  const found = descendantFailures(afterDir, base);
  const conflicted = found.some((failure) => failure.check === 'конфликт');
  if (updated.status !== 0 && !conflicted) {
    found.push({
      check: 'дерево',
      detail: `copier update вышел с кодом ${updated.status}:\n${updated.output.slice(-2000)}`,
    });
  }
  if (unmerged.status === 0 && unmerged.output.trim() !== '' && !conflicted) {
    found.push({
      check: 'конфликт',
      detail: 'в индексе потомка несведённые записи (git ls-files -u) — обновление не сведено',
    });
  }
  for (const failure of found) {
    console.error(`✗ [${failure.check}] ${failure.detail}`);
  }
  for (const [check, label] of Object.entries(DESCENDANT_CHECKS)) {
    if (!found.some((failure) => failure.check === check)) {
      console.log(`  ✓ ${label}`);
    }
  }
  console.log(
    `дерево обновлённого потомка: ${treeFiles(afterDir).length} файлов, целевая версия: ${base.target.length}`,
  );
  if (found.length > 0) {
    return 'red';
  }

  // Обновление свершилось: коммит и пуш в origin копии — базе сравнения
  // контракта тот же документированный канал, что у первого пуша раздела 8
  // (в обновляемом человеком проекте это состояние после merge обновления).
  commitProject(descendantDir, `Обновление шаблона: ${previousTag} → HEAD`);
  const pushed = runInProject(descendantDir, ['git', 'push', '-q', 'origin', 'main']);
  if (pushed.status !== 0) {
    throw new CanaryFailure(`git push обновлённого потомка failed:\n${pushed.output.slice(-1500)}`);
  }
  assertOriginMain(descendantDir);
  console.log(`потомок после обновления: ${VERIFY_STEP} — дословно…`);
  runRecipeSteps([VERIFY_STEP], 'потомок', descendantDir, descendantOrigin);

  // Негатив-контроль конфликта: настоящий copier, второй потомок. Проект
  // заменяет строку, которую между версиями переписал и шаблон, — в дереве
  // обязаны появиться маркеры и детектор обязан их увидеть.
  const red: DescendantFailure[] = [];
  const spot = conflictSpot(base);
  if (spot === null) {
    console.error(
      `SKIPPED: негатив-контроль конфликта — между ${previousTag} и HEAD шаблон не переписал ни одной текстовой строки, конфликту взяться неоткуда`,
    );
  } else {
    const conflictDir = join(workDir, 'conflict');
    const conflictCopied = copyFromTag(conflictDir);
    if (conflictCopied.status !== 0) {
      throw new CanaryFailure(
        `copier copy из ${previousTag} (негатив-контроль) failed:\n${conflictCopied.output.slice(-3000)}`,
      );
    }
    const init = runInProject(conflictDir, ['git', 'init', '-q', '-b', 'main']);
    if (init.status !== 0) {
      throw new CanaryFailure(`git init негатив-контроля failed:\n${init.output.slice(-1500)}`);
    }
    commitProject(conflictDir, 'Проект из шаблона');
    const spotText = textOf(join(conflictDir, spot.path));
    if (spotText === null) {
      throw new CanaryFailure(`${spot.path} негатив-контроля не читается как текст`);
    }
    const spotLines = spotText.split('\n');
    spotLines.splice(spot.line - 1, 1, CONFLICT_LINE);
    writeFileSync(join(conflictDir, spot.path), spotLines.join('\n'));
    commitProject(conflictDir, 'Проект: правка той же строки, что правит шаблон');
    const conflictedUpdate = runInProject(
      conflictDir,
      ['copier', 'update', '-q', '--defaults', '--vcs-ref=HEAD'],
      300_000,
    );
    const conflictAfterDir = join(workDir, 'conflict-after');
    snapshotTree(conflictDir, conflictAfterDir);
    const seen = descendantFailures(conflictAfterDir, { ...base, expectEdit: false });
    console.log(
      `негатив-контроль конфликта: ${spot.path}:${spot.line}, copier update — exit ${conflictedUpdate.status}`,
    );
    if (seen.some((failure) => failure.detail.startsWith(`${CONFLICT_PREFIX}: ${spot.path} —`))) {
      console.log(`  ✓ ${CONFLICT_PREFIX}, детектор видит (${spot.path})`);
    } else {
      red.push({
        check: 'конфликт',
        detail:
          `негатив-контроль слеп: copier update при правке одной строки с двух сторон ` +
          `(${spot.path}:${spot.line}) не оставил маркеров, либо детектор их не увидел`,
      });
    }
  }

  // Инверсионная проба: мутации дерева счастливого пути детектор обязан замечать.
  const scratchDir = join(workDir, 'mutants');
  mkdirSync(scratchDir, { recursive: true });
  const probe = descendantProbe(afterDir, base, scratchDir);
  for (const line of probe.blind) {
    console.error(`✗ ${line}`);
  }
  if (probe.blind.length > 0) {
    red.push({
      check: 'дерево',
      detail: `инверсионная проба — детектор слеп (${probe.blind.length} из ${probe.mutations} мутаций не замечены)`,
    });
  } else {
    console.log(
      `инверсионная проба детектора потомка — ok (${probe.mutations} мутаций обновлённого дерева красят прогон)`,
    );
  }

  if (red.length > 0) {
    for (const failure of red) {
      console.error(`✗ [${failure.check}] ${failure.detail}`);
    }
    return 'red';
  }
  console.log(
    `канарейка потомка — ok (${previousTag} → HEAD ${headCommit.output.trim()}: правка «проекта» цела, ` +
      'дерево — целевая версия, pnpm verify в обновлённой копии зелёный, конфликт помечен маркерами)',
  );
  return 'ok';
}

let contentOk = false;
try {
  const originReady = run(['git', 'init', '--bare', '-b', 'main', originDir], repoRoot);
  if (originReady.status !== 0) {
    throw new CanaryFailure(
      `git init --bare (origin вместо GitHub) failed:\n${originReady.output.slice(-1500)}`,
    );
  }

  console.log(`copier ${pinnedVersion}: копия из HEAD в ${copyDir}`);
  const copied = run(
    [
      'copier',
      'copy',
      '-q',
      // Копия из закоммиченного состояния: канарейка проверяет HEAD, как и
      // негатив-канарейки run-gate-canaries; локально — сначала commit.
      '--vcs-ref=HEAD',
      // Ответы на вопросы copier (имя проекта и владельца) — человек вводит
      // их руками, раздел 8; неинтерактивному раннеру нужны флаги -d.
      '-d',
      'project_name=copy-canary-probe',
      '-d',
      'repo_owner=@copy-canary-owner',
      repoRoot,
      copyDir,
    ],
    repoRoot,
  );
  if (copied.status !== 0) {
    throw new CanaryFailure(`copier copy failed:\n${copied.output.slice(-3000)}`);
  }

  // Снимок целиком до install: целевой рендер для потомка — дерево без зависимостей.
  snapshotTree(copyDir, headRenderDir);
  const copyFailures = checkCopySide(repoRoot, copyDir);
  for (const failure of copyFailures) {
    console.error(`✗ [${failure.check}] ${failure.detail}`);
  }
  contentOk = copyFailures.length === 0;
  if (contentOk) {
    console.log('содержимое копии — ok');
  }

  console.log(`рецепт раздела 8 в копии — ${COPY_STEPS.length} шагов дословно…`);
  runRecipeSteps(COPY_STEPS, 'копия', copyDir, originDir);
  if (contentOk) {
    console.log(
      `канарейка копии — ok (copier ${pinnedVersion}, рецепт раздела 8 — ${COPY_STEPS.length} шагов дословно, ${copyDir})`,
    );
  }

  // Синтетический потомок (d8.7): обновлять есть во что только при зелёной
  // свежей копии — она и есть целевая версия.
  if (!contentOk) {
    console.error('потомок не запускается: свежая копия красная — обновлять не во что');
  } else {
    const latestTag = versionTags()[0];
    if (latestTag === undefined) {
      const reason = 'в шаблоне нет ни одного тега v* — потомку не из чего обновляться';
      if (isCI) {
        // В CI теги приходят с чекаутом (fetch-depth: 0); их нет — сломана
        // проводка, а не окружение, поэтому fail-closed (З6).
        throw new CanaryFailure(reason);
      }
      console.error(`SKIPPED: канарейка потомка — ${reason}`);
      descendantState = 'skipped';
    } else {
      const ancestor = run(['git', 'merge-base', '--is-ancestor', latestTag, 'HEAD'], repoRoot);
      if (ancestor.status !== 0) {
        throw new CanaryFailure(
          `последний тег ${latestTag} не предок HEAD — из его копии не обновиться до HEAD:\n${ancestor.output.slice(-1500)}`,
        );
      }
      descendantState = runDescendant(latestTag);
    }
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
if (contentOk && descendantState !== 'red') {
  console.log('all done');
} else if (contentOk) {
  console.error('канарейка потомка: обновление красное (детали выше)');
  process.exit(1);
} else {
  console.error('канарейка копии: содержимое копии красное (детали выше)');
  process.exit(1);
}
