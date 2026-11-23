/**
 * Гейт «дифф ветки лежит внутри touches» (D7, З2; ADR 0007, ADR 0014).
 *
 * Задача объявляет touches (литеральный путь или «каталог/**», грамматика
 * invalidTouch в backlog-board.ts); ветка task/<id> обязана не выходить за них:
 * проверяется и закоммиченный дифф (merge-base с main..HEAD), и незакоммиченное
 * состояние рабочего дерева (git status --porcelain без ignored). touches
 * читаются из ссылки main ?? origin/main, не из ветки (З2): правка touches в
 * ветке себе не помогает. Bare-каталог без «/**» покрывает только точный путь.
 * Собственные пути файла задачи (backlog/<id>.md и backlog/done/<id>.md,
 * перенос между ними и правки журнала) разрешены всегда — их перенос требует
 * гейт замыкания docs (канарейка «файл задачи не перенесён в done/»). Общие
 * пути (SHARED_PATHS в backlog-board.ts — docs/escaped-defects.md) разрешены
 * любой задаче независимо от touches: строку реестра несёт каждый
 * PR-исправление (AGENTS.md), и файл, который правит каждая задача, не строит
 * задачи в очередь (d7tail, З9).
 *
 * Ветке вне task/* гейт зелёный skip: работа вне доски по прямому поручению
 * легальна (ADR 0007, «Работа вне доски»), граница остаётся приёмке человека
 * (З3) — осознанное решение в журнале d7. Fail-closed (З4/З11): ссылка main
 * (main ?? origin/main) не резолвится — красный; файла задачи нет на ней ни в
 * backlog/, ни в backlog/done/ — красный; ветка task/<id> указывает на закрытую
 * задачу — красный (брошенный/рукотворный клейм, класс leftover doctor). Все
 * проблемы выводятся разом: красный повод обязан называться конкретно (З11),
 * а канарейка «дифф вне touches» матчила бы именно посторонний файл, не
 * fail-closed поводы.
 *
 * Резолвнутый ref используется для ВСЕХ чтений доски (ревью d7, 2026-11-22):
 * checkout PR в CI — detached merge-ref, локальной ветки main нет
 * (actions/checkout кладёт только refs/remotes/origin/*) — литеральный
 * `git show main:` в job static ложнокраснил бы «файла задачи нет» при
 * живом origin/main. Прецедент — loadBoard (tools/backlog-doctor.ts:117-124):
 * ls-tree/show по резолвнутому ref.
 *
 * Ветка в CI: GITHUB_HEAD_REF (checkout PR — detached merge-ref, локальной
 * ветки нет), локально — git branch --show-current; base — merge-base с main
 * (fetch-depth: 0 в ci.yml; прецедент — bundle-delta). Push в main без
 * task-контекста — skip.
 *
 * Проводка (З5, ADR 0014): шаг branch-scope в fast-волне verify-steps.ts,
 * скрипт branch-scope:check, run в job static ci.yml, бюджет в
 * verify-budgets.json, файл тем же PR в deny protected-paths.json и в
 * KNOWN_GATES check-tool-class.ts.
 */
import { SHARED_PATHS, fileInTouches, parseTask } from './backlog-board.ts';
import { tryGit } from './backlog-doctor.ts';

const problems: string[] = [];
const die = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const branch = process.env['GITHUB_HEAD_REF'] || tryGit('branch', '--show-current') || '';
if (!branch.startsWith('task/')) {
  console.log(
    `branch-scope: вне task/* (${branch || 'detached HEAD'}) — проверка пропущена: работа вне доски по поручению человека (ADR 0007), граница — приёмка человека.`,
  );
  process.exit(0);
}
const id = branch.slice('task/'.length);

const boardRefResolved: string =
  tryGit('rev-parse', '--verify', 'main') ??
  tryGit('rev-parse', '--verify', 'origin/main') ??
  die(
    `branch-scope: ссылка main не резолвится (git fetch?) — touches задачи нечитаемы, fail-closed (З4): проверка не выполнялась, а не пройдена.`,
  );

const openRaw = tryGit('show', `${boardRefResolved}:backlog/${id}.md`);
const doneRaw = tryGit('show', `${boardRefResolved}:backlog/done/${id}.md`);
const raw = openRaw ?? doneRaw;
let touches: string[] = [];
// Проект из шаблона доски не имеет (backlog/ в _exclude copier.yml): гейт в
// verify-steps едет в копию и на чистой копии файла задачи нет. База без
// каталога backlog/ — это не монорепо-шаблон, шаг пропускается (наблюдение
// 2026-11-22: копийная канарейка красила pnpm verify в копии).
// «Файла нет, а доска есть» остаётся красным — fail-closed (З4) не сужается.
const boardExistsOnBase = tryGit('cat-file', '-e', `${boardRefResolved}:backlog`) !== null;
if (raw === null && !boardExistsOnBase) {
  console.log(
    'branch-scope: на базе нет каталога backlog/ — проект из шаблона без доски, шаг пропущен (гейт применим только к монорепо-шаблону).',
  );
  process.exit(0);
}
if (raw === null) {
  problems.push(
    `файла задачи ${id} нет на базе (main ?? origin/main) ни в backlog/${id}.md, ни в backlog/done/${id}.md — ветка task/${id} вне доски; задачу заводят PR-ом в main, вне-досковая работа идёт в ветке, не начинающейся с task/ (ADR 0007)`,
  );
} else {
  const task = parseTask(id, raw, doneRaw !== null);
  touches = task.touches;
  if (task.done) {
    problems.push(
      `задача ${id} закрыта в main (backlog/done/${id}.md), а ветка task/${id} существует — брошенный или рукотворный клейм; освобождает человек: pnpm backlog release ${id} (doctor ловит тот же leftover)`,
    );
  }
}

const mergeBase = tryGit('merge-base', boardRefResolved, 'HEAD');
if (mergeBase === null) {
  die(
    `branch-scope: merge-base ${boardRefResolved}..HEAD не найден — ветка не происходит от main, дифф не ограничить. Fail-closed (З4): перебазируй ветку на main.`,
  );
}

const changed = new Set<string>();
const collectFromTokens = (tokens: string[]): void => {
  for (let index = 0; index < tokens.length; index += 1) {
    const status = tokens[index];
    if (status === undefined || status === '') {
      continue;
    }
    const first = tokens[index + 1];
    if (first === undefined || first === '') {
      break;
    }
    changed.add(first);
    // R/C статусы несут второй путь (rename/copy): за status-токеном два пути.
    if (status.startsWith('R') || status.startsWith('C')) {
      const second = tokens[index + 2];
      if (second !== undefined && second !== '') {
        changed.add(second);
      }
      index += 2;
    } else {
      index += 1;
    }
  }
};
collectFromTokens((tryGit('diff', '--name-status', '-z', `${mergeBase}..HEAD`) ?? '').split('\0'));
// Рабочее дерево: незакоммиченные правки и untracked (без ignored) — тот же
// запрет; это же делает apply канарейки естественным (раннер канареек правит
// файлы, не коммитя; negative control на чистом дереве остаётся зелёным).
// --untracked-files=all: untracked-каталог разворачивается до файлов, иначе
// красным назывался бы каталог, а не нарушающий путь. Формат porcelain -z:
// «XY путь» в одном токене, rename несёт старый путь следующим токеном.
const porcelain = (tryGit('status', '--porcelain', '-z', '--untracked-files=all') ?? '')
  .split('\0')
  .filter(Boolean);
for (let index = 0; index < porcelain.length; index += 1) {
  const entry = porcelain[index];
  if (entry === undefined || entry.length < 3) {
    continue;
  }
  changed.add(entry.slice(3));
  const x = entry[0] ?? '';
  if (x === 'R' || x === 'C') {
    const movedFrom = porcelain[index + 1];
    if (movedFrom !== undefined) {
      changed.add(movedFrom);
      index += 1;
    }
  }
}

const ownPaths = new Set([`backlog/${id}.md`, `backlog/done/${id}.md`]);
const violations = [...changed].filter(
  (file) => !ownPaths.has(file) && !fileInTouches(file, touches),
);
if (violations.length > 0) {
  problems.push(
    `файлы вне touches задачи: ${violations.join(', ')} — touches (из main): ${touches.join(', ') || 'пусто'}`,
  );
}

if (problems.length > 0) {
  die(
    `branch-scope: дифф ветки task/${id} не укладывается в touches задачи (D7):\n` +
      problems.map((problem) => `  - ${problem}`).join('\n') +
      `\nВсегда разрешены: собственные файлы задачи (${[...ownPaths].join(', ')}) — их перенос делает pnpm backlog close; общие пути (${SHARED_PATHS.join(', ')}) — SHARED_PATHS в tools/backlog-board.ts.\n` +
      `Выход: расширь touches задачи PR-ом в main (доска читается из main — правка touches в ветке не видна, З2) или убери файлы из диффа.`,
  );
}
console.log(
  `branch-scope: дифф task/${id} внутри touches — ok (${changed.size} файлов; touches: ${touches.join(', ') || 'пусто'}).`,
);
