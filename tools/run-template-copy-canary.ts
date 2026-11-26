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
 * Гоняют CI (canaries.yml — по изменению copier.yml, .github/rulesets/**,
 * пары CODEOWNERS и tools/copier-version.txt — и nightly) и человек. Из
 * песочницы агента не запускается — copier ставится из PyPI, вне allowlist
 * доменов (ADR 0004, З5-исключение в architecture.md): без copier раннер
 * громко уходит в skip, в CI (CI=true) отсутствие copier красит прогон.
 *
 *   pnpm canaries
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
// Шаги раздела 8 «в копии» — дословно: каждая командная строка блока уходит
// оболочке как есть (с подставленными плейсхолдерами), в каталоге копии.
// Среда исполнителя, не команды рецепта: identity коммита (раздел 8 требует
// user.name и user.email в git — у раннера их нет), телеметрия turbo
// выключена, шагу с `pnpm verify` — CI=1: тот же режим, что у гейта в CI.
function runRecipeStep(step: string): { status: number | null; output: string } {
  const command = step
    .replaceAll(COPY_DIR_PLACEHOLDER, copyDir)
    .replaceAll(PROJECT_REMOTE_PLACEHOLDER, originDir);
  const attempt = spawnSync('sh', ['-c', command], {
    encoding: 'utf8',
    cwd: copyDir,
    timeout: 600_000,
    env: {
      ...process.env,
      TURBO_TELEMETRY_DISABLED: '1',
      GIT_AUTHOR_NAME: 'copy-canary',
      GIT_AUTHOR_EMAIL: 'copy-canary@example.invalid',
      GIT_COMMITTER_NAME: 'copy-canary',
      GIT_COMMITTER_EMAIL: 'copy-canary@example.invalid',
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

  const copyFailures = checkCopySide(repoRoot, copyDir);
  for (const failure of copyFailures) {
    console.error(`✗ [${failure.check}] ${failure.detail}`);
  }
  contentOk = copyFailures.length === 0;
  if (contentOk) {
    console.log('содержимое копии — ok');
  }

  console.log(`рецепт раздела 8 в копии — ${COPY_STEPS.length} шагов дословно…`);
  for (const [index, step] of COPY_STEPS.entries()) {
    let done = runRecipeStep(step);
    for (let retry = 1; retry <= 2 && done.status !== 0 && coldBrowserStart(done.output);) {
      console.error(
        `тестер browser-режима не уложился в 60 с на холодном transform копии — повтор ${retry}/2 на тёплых кэшах`,
      );
      done = runRecipeStep(step);
      retry += 1;
    }
    if (done.status !== 0) {
      throw new CanaryFailure(
        `шаг ${index + 1}/${COPY_STEPS.length} раздела 8 failed (${step}):\n${done.output.slice(-3000)}`,
      );
    }
    console.log(`  ✓ ${index + 1}/${COPY_STEPS.length} ${step}`);
    if (step === PUBLISH_STEP) {
      // После пуша база сравнения контракта есть по документированному каналу
      // (origin/main) — без OPENAPI_COMPAT_ALLOW_HEAD_BASE.
      const published = run(['git', 'rev-parse', 'HEAD', 'origin/main'], copyDir);
      const [head, originMain] = published.status === 0 ? published.output.trim().split('\n') : [];
      if (published.status !== 0 || head === undefined || head !== originMain) {
        throw new CanaryFailure(
          `пуш по рецепту не создал origin/main — базе сравнения контракта взяться неоткуда:\n${published.output.slice(-1500)}`,
        );
      }
    }
  }
  if (contentOk) {
    console.log(
      `канарейка копии — ok (copier ${pinnedVersion}, рецепт раздела 8 — ${COPY_STEPS.length} шагов дословно, ${copyDir})`,
    );
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
if (contentOk) {
  console.log('all done');
} else {
  console.error('канарейка копии: содержимое копии красное (детали выше)');
  process.exit(1);
}
