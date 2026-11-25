/**
 * Тесты одобрения визуальных базлайнов (b3.1, ADR 0015): логика ядра
 * (visual-approval-core) на чистых функциях, проводка чекера в доверенный
 * workflow и фазы перезаписи в CI — по образцу B4.1 (канарейка gate-canaries
 * ловит срыв привязки, якорь — заголовок wiring-блока). Инвариант e24 — после
 * checkout head PR ничего из PR-дерева не исполняется — пинится структурой
 * самого workflow. Инвариант e67 — токен события не попадает в argv git-команд
 * — пинится структурой workflow, храповиком по всем workflow и живым прогоном
 * блоков fetch/push против git-сервера, требующего авторизацию.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { evaluateVisualApproval, type CommentEvent } from '../visual-approval-core.ts';

const MAINTAINERS = new Set(['CyberWalrus']);
const HEAD = 'a'.repeat(40);
const pull = { headSha: HEAD, pushedAt: '2026-11-19T17:00:00Z' };

const comment = (overrides: Partial<CommentEvent> = {}): CommentEvent => ({
  author: 'CyberWalrus',
  createdAt: '2026-11-19T17:10:00Z',
  body: `/approve-visual ${HEAD}`,
  ...overrides,
});

describe('evaluateVisualApproval', () => {
  it('валидная команда владельца CODEOWNERS на текущий head после push — одобрено', () => {
    const verdict = evaluateVisualApproval({ comment: comment(), pull, maintainers: MAINTAINERS });
    expect(verdict.approved).toBe(true);
  });

  it('не-команда (обычный комментарий) — не одобрено', () => {
    const verdict = evaluateVisualApproval({
      comment: comment({ body: 'смотрю дифф' }),
      pull,
      maintainers: MAINTAINERS,
    });
    expect(verdict.approved).toBe(false);
  });

  it('лишний текст в команде — не одобрено (форма строгая)', () => {
    const verdict = evaluateVisualApproval({
      comment: comment({ body: `/approve-visual ${HEAD}\nсмотрел, ок` }),
      pull,
      maintainers: MAINTAINERS,
    });
    expect(verdict.approved).toBe(false);
    expect(verdict.reason).toMatch(/не распознана/);
  });

  it('короткий SHA — не одобрено (подмена префиксом невозможна)', () => {
    const verdict = evaluateVisualApproval({
      comment: comment({ body: `/approve-visual ${HEAD.slice(0, 12)}` }),
      pull,
      maintainers: MAINTAINERS,
    });
    expect(verdict.approved).toBe(false);
  });

  it('SHA не совпадает с head PR (push после просмотра) — не одобрено', () => {
    const verdict = evaluateVisualApproval({
      comment: comment({ body: `/approve-visual ${'b'.repeat(40)}` }),
      pull,
      maintainers: MAINTAINERS,
    });
    expect(verdict.approved).toBe(false);
    expect(verdict.reason).toMatch(/не совпадает с head/);
  });

  it('комментарий старше последнего push — не одобрено', () => {
    const verdict = evaluateVisualApproval({
      comment: comment({ createdAt: '2026-11-19T16:59:00Z' }),
      pull,
      maintainers: MAINTAINERS,
    });
    expect(verdict.approved).toBe(false);
    expect(verdict.reason).toMatch(/до последнего push/);
  });

  it('автор не из глобальных владельцев CODEOWNERS — не одобрено', () => {
    const verdict = evaluateVisualApproval({
      comment: comment({ author: 'random-contributor' }),
      pull,
      maintainers: MAINTAINERS,
    });
    expect(verdict.approved).toBe(false);
    expect(verdict.reason).toMatch(/не входит в глобальные владельцы/);
  });

  it('нет владельцев CODEOWNERS — не одобрено (fail-closed)', () => {
    const verdict = evaluateVisualApproval({ comment: comment(), pull, maintainers: new Set() });
    expect(verdict.approved).toBe(false);
  });

  it('комментарий не прочитан из API — не одобрено (fail-closed)', () => {
    const verdict = evaluateVisualApproval({ comment: undefined, pull, maintainers: MAINTAINERS });
    expect(verdict.approved).toBe(false);
  });
});

// Инвариант e24 (docs/escaped-defects.md, строка b3.1): после checkout head PR
// не исполняется ничего из PR-дерева. Ассерты читают сам workflow по отступам —
// YAML-парсера в зависимостях нет; форма, непонятная разбору (потеря шага-якоря,
// flow-стиль env), даёт нарушение, а не пропуск — сбой только в красную сторону.

interface WorkflowStep {
  readonly name: string;
  /** Некомментарные строки шага — YAML-ключи и тело run. */
  readonly code: readonly string[];
  /** env шага: ключ → значение без кавычек. */
  readonly env: ReadonlyMap<string, string>;
}

interface EnvBlock {
  /** Отступ ключа `env:`: 0 — уровень workflow, отступ ключей job — уровень job. */
  readonly depth: number;
  readonly env: ReadonlyMap<string, string>;
}

interface WorkflowJob {
  /** Отступ ключей job (`steps:`, `if:`, `env:`). */
  readonly keyIndent: number;
  readonly steps: readonly WorkflowStep[];
}

interface Violation {
  /** Имя инварианта — попадает в заголовок падения. */
  readonly invariant: string;
  readonly detail: string;
}

const CHECKOUT_STEP = 'Checkout PR head without executing it';
const COMMIT_STEP = 'Commit baselines to the PR branch';
const PUSH_STEP = 'Push baselines to the PR branch';

const INVARIANT = {
  noExec: 'после checkout head PR не запускаются node-инструменты и локальные actions',
  hooksOff: 'git commit и git push базлайнов идут с LEFTHOOK=0',
  noToken: 'шаги checkout и commit не получают GH_TOKEN',
  noArgvToken: 'токен не попадает в argv git-команд и в env шага',
} as const;

/** Вызов по имени — целое слово (`pnpm install`, `/usr/bin/node`) — или бинарь из node_modules. */
const NODE_LAUNCH =
  /\b(?:node|nodejs|npm|npx|pnpm|pnpx|yarn|yarnpkg|corepack|bun|deno)\b|node_modules\//;
/** `uses: ./…` — action.yml читается из рабочего дерева, после checkout это PR-дерево. */
const LOCAL_ACTION = /^-\s*uses:\s*\.?[\\/]/;

/**
 * Саботажи — копия текста workflow с одним нарушением; ассерты должны его
 * узнать. Якорь замены потерян (workflow переформатирован) — саботаж не
 * применён, тест красный: чувствительность доказана только на живом якоре.
 */
const SABOTAGE = [
  {
    name: 'pnpm install после checkout',
    invariant: INVARIANT.noExec,
    apply: (text: string): string =>
      text.replace(/^([ \t]*)git checkout "\$HEAD_SHA"\n/m, '$&$1pnpm install --frozen-lockfile\n'),
  },
  {
    name: 'pnpm install внутри составной строки после checkout',
    invariant: INVARIANT.noExec,
    apply: (text: string): string =>
      text.replace('git checkout "$HEAD_SHA"\n', 'git checkout "$HEAD_SHA" && pnpm install\n'),
  },
  {
    name: 'локальная action после checkout',
    invariant: INVARIANT.noExec,
    apply: (text: string): string =>
      text.replace(
        /^([ \t]*)- name: Download and verify visual-actuals artifact\n/m,
        '$1- uses: ./.github/actions/setup\n$&',
      ),
  },
  {
    name: 'LEFTHOOK=0 убран у шага commit',
    invariant: INVARIANT.hooksOff,
    apply: (text: string): string =>
      text.replace(
        /(- name: Commit baselines to the PR branch\n[^\n]*\n[ \t]*env:\n)[ \t]*LEFTHOOK: '0'\n/,
        '$1',
      ),
  },
  {
    name: 'LEFTHOOK=0 убран у шага push',
    invariant: INVARIANT.hooksOff,
    apply: (text: string): string =>
      text.replace(
        /(- name: Push baselines to the PR branch\n[^\n]*\n[ \t]*env:\n[ \t]*GH_TOKEN:[^\n]*\n)[ \t]*LEFTHOOK: '0'\n/,
        '$1',
      ),
  },
  {
    name: 'GH_TOKEN добавлен в env шага commit',
    invariant: INVARIANT.noToken,
    apply: (text: string): string =>
      text.replace(
        /( {10}LEFTHOOK: '0'\n)( {8}run: \|\n {10}HEAD_SHA=\$\(jq -r \.headRefOid pr\.json\)\n {10}LOGIN=)/,
        '$1          GH_TOKEN: sabotage\n$2',
      ),
  },
  {
    name: 'GH_TOKEN объявлен в env уровня job',
    invariant: INVARIANT.noToken,
    apply: (text: string): string =>
      text.replace(/^([ \t]*)steps:\n/m, '$1env:\n$1  GH_TOKEN: sabotage\n$&'),
  },
  {
    name: 'GH_TOKEN объявлен в env уровня workflow',
    invariant: INVARIANT.noToken,
    apply: (text: string): string =>
      text.replace(/^env:\n {2}REPO: /m, 'env:\n  GH_TOKEN: sabotage\n  REPO: '),
  },
] as const;

/**
 * Блок авторизации e67: заголовок `http.<url>.extraheader` собран из токена
 * внутри под-оболочки и живёт только в конфиг-окружении этой git-команды
 * (GIT_CONFIG_*) — ни в argv, ни в env шага, ни в `.git/config`.
 */
const AUTH_BLOCK =
  /\(\n[ \t]*export GIT_CONFIG_COUNT=1\n[ \t]*export GIT_CONFIG_KEY_0=http\.https:\/\/github\.com\/\.extraheader\n[ \t]*CREDENTIAL="x-access-token:(?:\$\{\{ github\.token \}\}|\$\{GH_TOKEN\})"\n[ \t]*export GIT_CONFIG_VALUE_0="AUTHORIZATION: basic \$\(printf '%s' "\$CREDENTIAL" \| base64 \| tr -d '\\n'\)"\n[ \t]*git -c credential\.helper= (?:fetch|push) [^\n]*\n[ \t]*\)\n/g;
/**
 * Источник токена в тексте workflow: выражение события, переменная шага, пара
 * для заголовка, конфиг-окружение git.
 */
const TOKEN_SOURCE =
  /x-access-token:|\$\{\{ github\.token \}\}|\$\{?GH_TOKEN\}?|GIT_CONFIG_|extraheader/i;
/** Команда git с токеном в URL — токен в argv (ps) на время команды. */
const GIT_WITH_TOKEN_URL =
  /\bgit\s+(?:-c\s+\S+\s+)*(?:fetch|push|pull|clone)\b[^\n]*x-access-token:/;
/**
 * Известный остаток e67 вне touches задачи — `nightly.yml`, ровно пять команд
 * (`:214-215`, `:314-315`, `:532`). Рост или новый файл — красный: токен в argv
 * запрещён, переноси на блок авторизации. После перевода nightly.yml запись
 * убрать: храповик сверяется с фактом в обе стороны.
 */
const TOKEN_URL_RESIDUAL: Readonly<Record<string, number>> = { 'nightly.yml': 5 };

/** Токен в env под любым именем: GH_TOKEN, `github.token` в значении, конфиг-окружение git. */
const tokenCarrier = (env: ReadonlyMap<string, string>): string | undefined =>
  [...env].find(([key, value]) => TOKEN_SOURCE.test(`${key} ${value}`))?.[0];

const TOKEN_SABOTAGE = [
  {
    name: 'токен возвращён в URL fetch',
    invariant: INVARIANT.noArgvToken,
    apply: (text: string): string =>
      text.replace(
        'git -c credential.helper= fetch --depth=1 "https://github.com/${REPO}.git"',
        'git fetch --depth=1 "https://x-access-token:${{ github.token }}@github.com/${REPO}.git"',
      ),
  },
  {
    name: 'токен возвращён в URL push',
    invariant: INVARIANT.noArgvToken,
    apply: (text: string): string =>
      text.replace(
        'git -c credential.helper= push "https://github.com/${REPO}.git"',
        'git push "https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git"',
      ),
  },
  {
    name: 'под-оболочка снята у fetch — конфиг-окружение с токеном переживает команду',
    invariant: INVARIANT.noArgvToken,
    apply: (text: string): string =>
      text.replace(
        /^([ \t]*)\(\n(([ \t]*export GIT_CONFIG_COUNT=1\n[ \t]*export GIT_CONFIG_KEY_0=[^\n]*\n[ \t]*CREDENTIAL=[^\n]*\n[ \t]*export GIT_CONFIG_VALUE_0=[^\n]*\n[ \t]*git -c credential\.helper= fetch [^\n]*\n))[ \t]*\)\n/m,
        '$2',
      ),
  },
  {
    name: 'GIT_CONFIG_VALUE_0 объявлен в env шага checkout — токен под другим именем',
    invariant: INVARIANT.noToken,
    apply: (text: string): string =>
      text.replace(
        /(- name: Checkout PR head without executing it\n[^\n]*\n)( {8}run: \|\n)/,
        '$1        env:\n          GIT_CONFIG_VALUE_0: AUTHORIZATION: basic x-access-token\n$2',
      ),
  },
] as const;

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** Комментарий — YAML или shell: строка пустая или начинается с `#`. */
const isComment = (line: string): boolean => /^[ \t]*(?:$|#)/.test(line);

/** Скаляр YAML без парных кавычек: `'0'` → `0`, `"Имя шага"` → `Имя шага`. */
const unquote = (scalar: string): string =>
  /^(['"])(.*)\1$/.exec(scalar.trim())?.[2] ?? scalar.trim();

/**
 * Блоки `env:` с отступом их ключа: пары `KEY: value`, пока отступ глубже
 * ключа. Уровень узнаётся по отступу.
 */
const parseEnvBlocks = (lines: readonly string[]): readonly EnvBlock[] => {
  const blocks: EnvBlock[] = [];
  let open: { depth: number; env: Map<string, string> } | undefined;
  for (const line of lines) {
    const body = line.trim();
    if (isComment(line)) continue;
    const depth = indentOf(line);
    if (open !== undefined && depth <= open.depth) open = undefined;
    if (body === 'env:') {
      open = { depth, env: new Map<string, string>() };
      blocks.push(open);
      continue;
    }
    const [, key = '', value = ''] = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(body) ?? [];
    if (open !== undefined && key !== '') open.env.set(key, unquote(value));
  }
  return blocks;
};

const toStep = (lines: readonly string[]): WorkflowStep => {
  const [, name = ''] = /^- name:\s*(.*)$/.exec(lines[0]?.trimStart() ?? '') ?? [];
  return {
    name: unquote(name),
    code: lines.filter((line) => !isComment(line)),
    env: parseEnvBlocks(lines).at(0)?.env ?? new Map<string, string>(),
  };
};

/** Job с их шагами — по отступам: переформатирование YAML отступы сохраняет. */
const parseJobs = (lines: readonly string[]): WorkflowJob[] => {
  const jobs: WorkflowJob[] = [];
  for (const [start, key] of lines.entries()) {
    // Ключ `steps:` job узнаётся по первому некомментарию за ним — пункту списка шагов.
    const first = lines.slice(start + 1).find((line) => !isComment(line));
    if (
      key.trim() !== 'steps:' ||
      first === undefined ||
      !/^-\s+(name|uses):/.test(first.trimStart())
    ) {
      continue;
    }
    const keyIndent = indentOf(key);
    const itemIndent = indentOf(first);
    const items: string[][] = [];
    for (const line of lines.slice(start + 1)) {
      if (line.trim() === '') continue;
      if (indentOf(line) <= keyIndent) break;
      if (indentOf(line) === itemIndent && /^-\s/.test(line.trimStart())) items.push([]);
      items.at(-1)?.push(line);
    }
    jobs.push({ keyIndent, steps: items.map((item) => toStep(item)) });
  }
  return jobs;
};

const lostAnchor = (invariant: string, name: string): Violation => ({
  invariant,
  detail: `нет шага «${name}» — якорь инварианта потерян`,
});

/**
 * Нарушения инварианта e24 в тексте workflow. Проверка принимает текст, а не
 * путь: саботажи применяются к копии, защищённый workflow не трогается.
 */
const wiringViolations = (text: string): Violation[] => {
  const lines = text.split('\n');
  const job = parseJobs(lines).find((candidate) =>
    candidate.steps.some((step) => step.name === CHECKOUT_STEP),
  );
  if (job === undefined) {
    return Object.values(INVARIANT).map((invariant) => lostAnchor(invariant, CHECKOUT_STEP));
  }

  const violations: Violation[] = [];
  const named = (name: string): WorkflowStep | undefined =>
    job.steps.find((step) => step.name === name);
  const checkoutAt = job.steps.findIndex((step) => step.name === CHECKOUT_STEP);
  // Включая сам шаг checkout: `git checkout` стоит в середине его тела.
  for (const step of job.steps.slice(checkoutAt)) {
    for (const line of step.code) {
      if (NODE_LAUNCH.test(line)) {
        violations.push({ invariant: INVARIANT.noExec, detail: `«${step.name}»: ${line.trim()}` });
      }
      if (LOCAL_ACTION.test(line.trimStart())) {
        violations.push({
          invariant: INVARIANT.noExec,
          detail: `«${step.name}»: локальная action ${line.trim()}`,
        });
      }
    }
  }
  for (const [name, hook] of [
    [COMMIT_STEP, 'pre-commit'],
    [PUSH_STEP, 'pre-push'],
  ] as const) {
    const step = named(name);
    if (step === undefined) violations.push(lostAnchor(INVARIANT.hooksOff, name));
    else if (step.env.get('LEFTHOOK') !== '0') {
      violations.push({
        invariant: INVARIANT.hooksOff,
        detail: `«${name}» без LEFTHOOK=0 в env: ${hook} запустился бы из PR-дерева`,
      });
    }
  }
  for (const name of [CHECKOUT_STEP, COMMIT_STEP]) {
    const step = named(name);
    if (step === undefined) violations.push(lostAnchor(INVARIANT.noToken, name));
    else if (step.env.has('GH_TOKEN')) {
      violations.push({ invariant: INVARIANT.noToken, detail: `«${name}»: GH_TOKEN в env шага` });
    } else {
      // e67: токен под другим именем (конфиг-окружение git) — тот же доступ, по имени не обходить.
      const carrier = tokenCarrier(step.env);
      if (carrier !== undefined) {
        violations.push({
          invariant: INVARIANT.noToken,
          detail: `«${name}»: ${carrier} в env шага несёт токен`,
        });
      }
    }
  }
  // env уровня workflow и job наследует каждый шаг — токен там достался бы и checkout, и commit.
  for (const block of parseEnvBlocks(lines)) {
    const carrier = block.env.has('GH_TOKEN') ? 'GH_TOKEN' : tokenCarrier(block.env);
    if (carrier !== undefined && (block.depth === 0 || block.depth === job.keyIndent)) {
      const level = block.depth === 0 ? 'workflow' : 'job';
      violations.push({
        invariant: INVARIANT.noToken,
        detail: `${carrier} в env уровня ${level} — наследуется каждым шагом, включая checkout и commit`,
      });
    }
  }
  violations.push(...tokenArgvViolations(text));
  return violations;
};

/** Где именно нарушен инвариант: падение остаётся компактным — заголовок теста не вытесняется из хвоста verify. */
const invariantDetails = (text: string, invariant: string): string[] =>
  wiringViolations(text)
    .filter((violation) => violation.invariant === invariant)
    .map((violation) => violation.detail);

/**
 * Нарушения, появившиеся в `after` относительно `before`. Саботаж обязан
 * добавить ровно ожидаемое: потеря шага-якоря даёт одинаковые «якорь
 * потерян» в обоих текстах — пустую разницу, красный тест.
 */
const newViolations = (before: string, after: string): string[] => {
  const known = new Set(
    wiringViolations(before).map((violation) => `${violation.invariant} ${violation.detail}`),
  );
  return wiringViolations(after)
    .filter((violation) => !known.has(`${violation.invariant} ${violation.detail}`))
    .map((violation) => violation.invariant);
};

/** Имена новых нарушений без повторов: один саботаж бьёт и по строке, и по якорю. */
const newInvariantNames = (before: string, after: string): string[] => [
  ...new Set(newViolations(before, after)),
];

const tokenUrlCommands = (text: string): number =>
  text.split('\n').filter((line) => !isComment(line) && GIT_WITH_TOKEN_URL.test(line)).length;

/**
 * Нарушения инварианта e67 в тексте workflow: источник токена вне блока
 * авторизации (argv команды, export, переживший команду) или потеря самих
 * блоков — их ровно два, fetch и push.
 */
const tokenArgvViolations = (text: string): Violation[] => {
  const blocks = [...text.matchAll(AUTH_BLOCK)];
  const spans = blocks.map((match) => [match.index, match.index + match[0].length] as const);
  const inBlock = (offset: number): boolean =>
    spans.some(([start, end]) => start <= offset && offset < end);
  const violations: Violation[] = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    const at = offset;
    offset += line.length + 1;
    // YAML-ключ — не команда; env шагов держит инвариант e24 (GH_TOKEN).
    if (isComment(line) || /^[\w.-]+:\s/.test(line.trimStart())) continue;
    if (!inBlock(at) && TOKEN_SOURCE.test(line)) {
      violations.push({ invariant: INVARIANT.noArgvToken, detail: line.trim() });
    }
  }
  const verbs = blocks.map(
    (match) => /\n[ \t]*git -c credential\.helper= (\w+) /.exec(match[0])?.[1],
  );
  if (verbs.join() !== 'fetch,push') {
    violations.push({
      invariant: INVARIANT.noArgvToken,
      detail: `блоки авторизации: ожидались fetch и push, найдено ${verbs.join(', ') || 'ничего'} — якорь инварианта потерян`,
    });
  }
  return violations;
};

describe('проводка: визуальное одобрение в доверенном workflow и CI', () => {
  const repoRoot = resolve(import.meta.dirname, '../..');
  const workflow = readFileSync(join(repoRoot, '.github/workflows/visual-approve.yml'), 'utf8');
  const ci = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');

  it('workflow вызывает чекер одобрения на тех же кандидатах CODEOWNERS', () => {
    // toBe(true), а не toMatch: провал toMatch печатает весь файл и вытесняет
    // заголовок теста из 60-строчного хвоста verify — канарейка не засчитывается.
    expect(workflow.includes('node tools/check-visual-approval.ts')).toBe(true);
    expect(workflow.includes('.github/CODEOWNERS CODEOWNERS docs/CODEOWNERS')).toBe(true);
  });

  it('CI собирает артефакт visual-actuals, workflow его потребляет', () => {
    expect(ci).toMatch(/bash tools\/visual-ci\.sh/);
    expect(ci).toMatch(/name: visual-actuals/);
    expect(workflow).toMatch(/"visual-actuals"/);
  });

  it('workflow диспатчит CI на новый head SHA (push токеном события не триггерит)', () => {
    expect(workflow).toMatch(/ci\.yml\/dispatches/);
    expect(ci).toMatch(/workflow_dispatch:/);
  });

  it('fork-PR отвергается: гвардия в workflow и в валидаторе (defense-in-depth)', () => {
    expect(workflow).toMatch(/isCrossRepository/);
    const validator = readFileSync(join(repoRoot, 'tools/check-visual-approval.ts'), 'utf8');
    expect(validator.includes('isCrossRepository')).toBe(true);
  });

  describe('инвариант e24: после checkout head PR ничего из PR-дерева не исполняется', () => {
    it('после checkout head PR не запускаются node-инструменты и локальные actions', () => {
      expect(invariantDetails(workflow, INVARIANT.noExec)).toEqual([]);
    });

    it('git commit и git push базлайнов идут с LEFTHOOK=0', () => {
      expect(invariantDetails(workflow, INVARIANT.hooksOff)).toEqual([]);
    });

    it('шаги checkout и commit не получают GH_TOKEN', () => {
      expect(invariantDetails(workflow, INVARIANT.noToken)).toEqual([]);
    });

    it('комментарий с pnpm после checkout — не нарушение', () => {
      const commented = workflow.replace(
        /^([ \t]*)git checkout "\$HEAD_SHA"\n/m,
        '$&$1# pnpm install после checkout запрещён\n',
      );

      expect(commented !== workflow).toBe(true);
      expect(newViolations(workflow, commented)).toEqual([]);
    });

    it.each(SABOTAGE)('саботаж «$name» распознан', ({ invariant, apply }) => {
      const sabotaged = apply(workflow);

      expect(sabotaged !== workflow).toBe(true);
      expect(newViolations(workflow, sabotaged)).toEqual([invariant]);
    });
  });

  describe('инвариант e67: токен события не попадает в argv git-команд', () => {
    const workflowsDir = join(repoRoot, '.github/workflows');
    const tokenUrlLine =
      '          git push "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" "$BRANCH"\n';

    it('токен живёт только в конфиг-окружении git внутри под-оболочки fetch и push', () => {
      expect(invariantDetails(workflow, INVARIANT.noArgvToken)).toEqual([]);
    });

    it.each(TOKEN_SABOTAGE)('саботаж «$name» распознан', ({ invariant, apply }) => {
      const sabotaged = apply(workflow);

      expect(sabotaged !== workflow).toBe(true);
      expect(newInvariantNames(workflow, sabotaged)).toEqual([invariant]);
    });

    it('храповик: токен в URL git-команд — только известный остаток nightly.yml', () => {
      const actual = Object.fromEntries(
        readdirSync(workflowsDir)
          .filter((name) => /\.ya?ml$/.test(name))
          .flatMap((name) => {
            const commands = tokenUrlCommands(readFileSync(join(workflowsDir, name), 'utf8'));
            return commands === 0 ? [] : [[name, commands] as const];
          }),
      );

      expect(actual).toEqual(TOKEN_URL_RESIDUAL);
    });

    it('саботаж храповика «токен в URL в другом workflow» распознан', () => {
      expect(tokenUrlCommands(ci)).toBe(0);
      expect(tokenUrlCommands(`${ci}${tokenUrlLine}`)).toBe(1);
    });

    it('саботаж храповика «шестая команда с токеном в nightly.yml» распознан', () => {
      const nightly = readFileSync(join(workflowsDir, 'nightly.yml'), 'utf8');

      expect(tokenUrlCommands(nightly)).toBe(5);
      expect(tokenUrlCommands(`${nightly}${tokenUrlLine}`)).toBe(6);
    });
  });

  describe('живой прогон блоков fetch и push против git-сервера, требующего авторизацию', () => {
    const FAKE_TOKEN = 'e67-fake-token-0123456789abcdef';
    // Ответ задержан: git-процессы с их argv живут достаточно долго для выборки `ps`.
    const AUTH_DELAY_MS = 1_000;
    const REMOTE_PATH = 'e67.git';
    const BRANCH = 'task/e67-sim';
    const authBlocks = [...workflow.matchAll(AUTH_BLOCK)].map(([block]) => block);
    type Env = Readonly<Record<string, string | undefined>>;
    interface Remote {
      readonly root: string;
      readonly origin: string;
      readonly work: string;
      readonly headSha: string;
      readonly port: number;
      readonly env: Env;
      readonly seen: { authorized: number; rejected: number };
      readonly server: Server;
      readonly life: { stopped: boolean };
    }

    const git = (cwd: string, args: readonly string[], env: Env): string => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8', env });
      if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
      return result.stdout.trim();
    };

    /** `git http-backend` как CGI — то, что github.com делает с fetch и push по HTTP. */
    const serveGit = (
      request: IncomingMessage,
      response: ServerResponse,
      projectRoot: string,
      env: Env,
    ): void => {
      const url = new URL(request.url ?? '', 'http://localhost');
      const backend = spawn('git', ['http-backend'], {
        env: {
          ...env,
          GIT_PROJECT_ROOT: projectRoot,
          GIT_HTTP_EXPORT_ALL: '1',
          PATH_INFO: url.pathname,
          REQUEST_METHOD: request.method,
          QUERY_STRING: url.search.slice(1),
          CONTENT_TYPE: request.headers['content-type'] ?? '',
          CONTENT_LENGTH: request.headers['content-length'] ?? '',
          REMOTE_ADDR: '127.0.0.1',
          REMOTE_USER: 'x-access-token',
        },
        stdio: ['pipe', 'pipe', 'inherit'],
      });
      const { stdin, stdout } = backend;
      if (stdin === null || stdout === null) throw new Error('у http-backend нет каналов stdio');
      const chunks: Buffer[] = [];
      stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      backend.on('close', () => {
        const output = Buffer.concat(chunks);
        const split = output.indexOf('\r\n\r\n');
        const headers: Record<string, string> = {};
        let status = 200;
        for (const line of output.subarray(0, split).toString('utf8').split('\r\n')) {
          const colon = line.indexOf(':');
          const key = line.slice(0, colon);
          const value = line.slice(colon + 1).trim();
          if (key.toLowerCase() === 'status') status = Number(value.split(' ')[0]);
          else headers[key] = value;
        }
        response.writeHead(status, headers);
        response.end(output.subarray(split + 4));
      });
      request.pipe(stdin);
    };

    /** Репозиторий-«github.com» с авторизацией и рабочее дерево «дефолтной ветки». */
    const startGitRemote = async (): Promise<Remote> => {
      const root = mkdtempSync(join(tmpdir(), 'e67-visual-approve-'));
      const origin = join(root, REMOTE_PATH);
      const seed = join(root, 'seed');
      const work = join(root, 'work');
      // Изоляция от глобального конфига и хелперов учётных данных машины, где идёт тест.
      const env: Env = {
        ...process.env,
        HOME: root,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        GIT_AUTHOR_NAME: 'visual-approve-test',
        GIT_AUTHOR_EMAIL: 'visual-approve@example.invalid',
        GIT_COMMITTER_NAME: 'visual-approve-test',
        GIT_COMMITTER_EMAIL: 'visual-approve@example.invalid',
      };
      const expectedAuth = `Basic ${Buffer.from(`x-access-token:${FAKE_TOKEN}`).toString('base64')}`;
      const seen = { authorized: 0, rejected: 0 };
      const life = { stopped: false };
      const server = createServer((request, response) => {
        // Схема авторизации нечувствительна к регистру (RFC 9110, 11.1).
        if (request.headers.authorization?.toLowerCase() !== expectedAuth.toLowerCase()) {
          seen.rejected += 1;
          response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="e67"' });
          response.end();
          return;
        }
        seen.authorized += 1;
        setTimeout(() => {
          if (!life.stopped) serveGit(request, response, root, env);
        }, AUTH_DELAY_MS);
      });
      try {
        git(root, ['init', '--bare', '--quiet', origin], env);
        git(origin, ['config', 'http.receivepack', 'true'], env);
        git(origin, ['config', 'uploadpack.allowAnySHA1InWant', 'true'], env);
        git(root, ['clone', '--quiet', origin, seed], env);
        writeFileSync(join(seed, 'base.txt'), 'base\n');
        git(seed, ['add', '.'], env);
        git(seed, ['commit', '--quiet', '-m', 'base'], env);
        git(seed, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main'], env);
        git(seed, ['checkout', '--quiet', '-b', BRANCH], env);
        writeFileSync(join(seed, 'pr.txt'), 'pr\n');
        git(seed, ['add', '.'], env);
        git(seed, ['commit', '--quiet', '-m', 'pr head'], env);
        const headSha = git(seed, ['rev-parse', 'HEAD'], env);
        git(seed, ['push', '--quiet', 'origin', BRANCH], env);
        // Рабочее дерево дефолтной ветки — как после первого шага checkout на раннере.
        git(root, ['clone', '--quiet', '--branch', 'main', origin, work], env);
        await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
        const address = server.address();
        if (address === null || typeof address === 'string') {
          throw new Error('сервер не слушает порт');
        }
        return { root, origin, work, headSha, port: address.port, env, seen, server, life };
      } catch (error) {
        life.stopped = true;
        server.close();
        rmSync(root, { recursive: true, force: true });
        throw error;
      }
    };

    const withGitRemote = async (run: (remote: Remote) => Promise<void>): Promise<void> => {
      const remote = await startGitRemote();
      try {
        await run(remote);
      } finally {
        remote.server.close();
        remote.life.stopped = true;
        rmSync(remote.root, { recursive: true, force: true });
      }
    };

    interface SampledRun {
      readonly code: number | null;
      readonly stderr: string;
      /** argv процессов, работавших с remote, — по одному снимку `ps` на строку. */
      readonly argv: readonly string[];
    }

    /** Код выхода блока — 0; иначе падение теста называет stderr шага. */
    const exitOk = (run: SampledRun): void => {
      if (run.code !== 0) throw new Error(`блок завершился с кодом ${run.code}:\n${run.stderr}`);
    };

    /** Скрипт — файл, как его пишет раннер: у bash в argv только путь. */
    const runSampled = (remote: Remote, env: Env, script: string): Promise<SampledRun> =>
      new Promise((resolveRun) => {
        const { root, work, port } = remote;
        const scriptPath = join(root, 'step.sh');
        writeFileSync(scriptPath, script);
        const argv: string[] = [];
        const child = spawn('bash', ['-e', scriptPath], { cwd: work, env });
        let stderr = '';
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk;
        });
        let settled = false;
        const done = new Promise<void>((resolveDone) => {
          child.on('close', (code) => {
            settled = true;
            resolveDone();
            resolveRun({ code, stderr, argv });
          });
        });
        const sample = async (): Promise<void> => {
          // Цикл останавливается извне — закрытием дочернего процесса, не условием.
          for (;;) {
            const listing = spawnSync('ps', ['-e', '-o', 'command='], { encoding: 'utf8' });
            argv.push(
              ...listing.stdout
                .split('\n')
                .filter((line) => line.includes(`:${port}/${REMOTE_PATH}`)),
            );
            await Promise.race([new Promise((resolveTick) => setTimeout(resolveTick, 25)), done]);
            if (settled) break;
          }
        };
        void sample();
      });

    it(
      'fetch и push проходят авторизацию заголовком из конфиг-окружения — токена нет ни в argv, ни в конфиге',
      { timeout: 30_000 },
      async () => {
        await withGitRemote(async (remote) => {
          // Remote — локальный сервер вместо github.com: схема и хост меняются и в ключе
          // конфига, и в URL; остальной текст блоков — из workflow байт-в-байт.
          const [fetchBlock, pushBlock] = authBlocks.map((block) =>
            block
              .replaceAll('https://github.com', `http://127.0.0.1:${remote.port}`)
              .replace('${{ github.token }}', FAKE_TOKEN),
          );
          if (fetchBlock === undefined || pushBlock === undefined) {
            throw new Error('в workflow не два блока авторизации — структурный тест e67 красный');
          }
          const stepEnv = {
            ...remote.env,
            REPO: 'e67',
            HEAD_SHA: remote.headSha,
            GH_TOKEN: FAKE_TOKEN,
            BRANCH,
          };

          const fetched = await runSampled(remote, stepEnv, fetchBlock);

          exitOk(fetched);
          expect(remote.seen.rejected).toBe(0);
          expect(remote.seen.authorized).toBeGreaterThanOrEqual(2);
          // Выборка действительно смотрела на живые git-процессы — иначе «токена нет» ничего не стоит.
          expect(fetched.argv.length).toBeGreaterThan(0);
          expect(fetched.argv.some((line) => line.includes(FAKE_TOKEN))).toBe(false);
          expect(git(remote.work, ['rev-parse', 'FETCH_HEAD'], remote.env)).toBe(remote.headSha);

          // Как шаг «Commit baselines»: коммит в PR-дереве, который push отнесёт в ветку PR.
          git(remote.work, ['checkout', '--quiet', remote.headSha], remote.env);
          writeFileSync(join(remote.work, 'baseline.webp'), 'baseline\n');
          git(remote.work, ['add', '.'], remote.env);
          git(remote.work, ['commit', '--quiet', '-m', 'visual baselines from CI'], remote.env);

          const pushed = await runSampled(remote, stepEnv, pushBlock);

          exitOk(pushed);
          expect(remote.seen.rejected).toBe(0);
          expect(remote.seen.authorized).toBeGreaterThanOrEqual(4);
          expect(pushed.argv.some((line) => line.includes(FAKE_TOKEN))).toBe(false);
          const pushedHead = git(remote.origin, ['rev-parse', `refs/heads/${BRANCH}`], remote.env);
          expect(pushedHead).toBe(git(remote.work, ['rev-parse', 'HEAD'], remote.env));
          const config = git(remote.work, ['config', '--list', '--show-origin'], remote.env);
          expect(config.includes(FAKE_TOKEN)).toBe(false);
          expect(config.includes('extraheader')).toBe(false);
        });
      },
    );

    it(
      'детектор видит токен в argv: контроль со старой формой URL',
      { timeout: 30_000 },
      async () => {
        await withGitRemote(async (remote) => {
          const legacy = `git fetch --depth=1 "http://x-access-token:${FAKE_TOKEN}@127.0.0.1:${remote.port}/${REMOTE_PATH}" "$HEAD_SHA"`;

          const fetched = await runSampled(
            remote,
            { ...remote.env, HEAD_SHA: remote.headSha },
            legacy,
          );

          exitOk(fetched);
          expect(remote.seen.authorized).toBeGreaterThanOrEqual(2);
          expect(fetched.argv.length).toBeGreaterThan(0);
          expect(fetched.argv.some((line) => line.includes(FAKE_TOKEN))).toBe(true);
        });
      },
    );

    it('ключ из блока матчит URL github.com: заголовок придёт и на настоящем remote', () => {
      const keys = [...workflow.matchAll(/export GIT_CONFIG_KEY_0=(\S+)\n/g)].map(
        (match) => match[1],
      );
      const key = keys[0] ?? '';

      expect(keys).toEqual([
        'http.https://github.com/.extraheader',
        'http.https://github.com/.extraheader',
      ]);
      expect(
        git(tmpdir(), ['config', '--get-urlmatch', 'http', 'https://github.com/owner/repo.git'], {
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: key,
          GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic eA==',
        }),
      ).toBe('http.extraheader AUTHORIZATION: basic eA==');
    });
  });
});
