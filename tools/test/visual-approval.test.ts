/**
 * Тесты одобрения визуальных базлайнов (b3.1, ADR 0015): логика ядра
 * (visual-approval-core) на чистых функциях, проводка чекера в доверенный
 * workflow и фазы перезаписи в CI — по образцу B4.1 (канарейка gate-canaries
 * ловит срыв привязки, якорь — заголовок wiring-блока). Инвариант e24 — после
 * checkout head PR ничего из PR-дерева не исполняется — пинится структурой
 * самого workflow.
 */
import { readFileSync } from 'node:fs';
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
    }
  }
  // env уровня workflow и job наследует каждый шаг — токен там достался бы и checkout, и commit.
  for (const block of parseEnvBlocks(lines)) {
    if (block.env.has('GH_TOKEN') && (block.depth === 0 || block.depth === job.keyIndent)) {
      const level = block.depth === 0 ? 'workflow' : 'job';
      violations.push({
        invariant: INVARIANT.noToken,
        detail: `GH_TOKEN в env уровня ${level} — наследуется каждым шагом, включая checkout и commit`,
      });
    }
  }
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
});
