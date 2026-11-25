/**
 * Тесты гейта нейминга путей (b17, tools/check-naming.ts).
 *
 * Ядро чистое: дерево подаётся списком путей (синтетическое дерево), git не
 * нужно. Проводка проверяется инвариантами по образцу
 * tools/test/check-action-pins.test.ts (раздел «проводка»). Интеграционные
 * кейсы спавнят чекер: на реальном дереве (зелёный) и во временном
 * git-репозитории (untracked вне .gitignore красит, ignored — нет).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DOC_ANCHOR,
  DOC_SOURCES,
  EXCEPTION_NAMES,
  checkPath,
  docExceptions,
  exceptionDrift,
  findNamingViolations,
  isException,
} from '../check-naming.ts';
import { fast } from '../verify-steps.ts';

const repoDir = resolve(import.meta.dirname, '..', '..');
const checker = join(repoDir, 'tools', 'check-naming.ts');

/** Все проблемы синтетического дерева — «путь — причина», по одной на сегмент. */
const problemsOf = (paths: string[]): string[] =>
  findNamingViolations(paths).map((item) => `${item.path} — ${item.reason}`);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson(...path: string[]): unknown {
  return JSON.parse(readFileSync(join(repoDir, ...path), 'utf8'));
}

function runChecker(root: string): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, [checker, root], { cwd: repoDir, encoding: 'utf8' });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

describe('синтетическое дерево: сегменты пути', () => {
  it('строчные буквы, цифры, дефис, точка и подчёркивание — зелёные', () => {
    expect(
      problemsOf([
        'packages/ui/src/task-item/task-item.tsx',
        'apps/web/src/routes/index.tsx',
        'e2e/features/a11y/route-states.e2e.ts',
        'docs/adr/0001-initial-stack.md',
        'pnpm-lock.yaml',
        // точка или подчёркивание первыми — имена, которые инструменты требуют дословно
        '.gitignore',
        '.github/workflows/ci.yml',
        '.claude-plugin/marketplace.json',
        'apps/web/src/routes/__root.tsx',
        'apps/api/src/tasks/migrations/meta/_journal.json',
        // каталог скриншотов зеркалит имя визуального теста — с точками
        'packages/ui/src/__screenshots__/button.visual.test.tsx/button-default-linux.webp',
      ]),
    ).toEqual([]);
  });

  it('PascalCase-имя файла — красное, названы путь и сегмент', () => {
    expect(problemsOf(['packages/foo/bar.tsx', 'packages/foo/Bar.tsx'])).toEqual([
      'packages/foo/Bar.tsx — файл: заглавные буквы в «Bar.tsx»',
    ]);
  });

  it('заглавные в каталоге — то же нарушение, что и в файле', () => {
    expect(
      problemsOf(['packages/Foo/bar.tsx', 'apps/web/src/features/Tasks/tasks-page.tsx']),
    ).toEqual([
      'apps/web/src/features/Tasks/tasks-page.tsx — каталог: заглавные буквы в «Tasks»',
      'packages/Foo/bar.tsx — каталог: заглавные буквы в «Foo»',
    ]);
  });

  it('пробелы и символы вне [a-z0-9._-] — красные, назван чужой символ', () => {
    const problems = problemsOf([
      'packages/foo/my file.ts',
      'packages/foo/a$b.ts',
      'packages/foo/приложение.ts',
    ]);
    expect(problems).toEqual([
      'packages/foo/a$b.ts — файл: символы вне [a-z0-9._-] в «a$b.ts»: «$»',
      'packages/foo/my file.ts — файл: пробелы в имени «my file.ts»',
      expect.stringContaining('файл: символы вне [a-z0-9._-] в «приложение.ts»: «п»'),
    ]);
  });

  it('имя не с буквы или цифры — красное', () => {
    expect(problemsOf(['packages/foo/-flag.ts', 'packages/foo/__/.keep'])).toEqual([
      'packages/foo/-flag.ts — файл: имя «-flag.ts» не начинается с буквы или цифры',
      'packages/foo/__/.keep — каталог: имя «__» не начинается с буквы или цифры',
    ]);
  });

  it('плохи и каталог, и файл одного пути — по причине на сегмент', () => {
    expect(problemsOf(['Foo/Bar Baz.tsx'])).toEqual([
      'Foo/Bar Baz.tsx — каталог: заглавные буквы в «Foo»',
      'Foo/Bar Baz.tsx — файл: заглавные буквы в «Bar Baz.tsx»',
    ]);
  });

  it('повторяющийся путь считается один раз, порядок вывода — по пути', () => {
    expect(problemsOf(['b/B.tsx', 'a/A.tsx', 'b/B.tsx']).map((line) => line.slice(0, 8))).toEqual([
      'a/A.tsx ',
      'b/B.tsx ',
    ]);
  });
});

describe('синтетическое дерево: исключения', () => {
  it('файлы из списка исключений проходят в любом каталоге', () => {
    // Инвентарь b16: `git ls-files | grep -E '[A-Z]'` — ровно эти 19 путей.
    expect(
      problemsOf([
        '.claude/skills/api-contract-change/SKILL.md',
        '.claude/skills/feature-workflow/SKILL.md',
        '.claude/skills/perf-regression/SKILL.md',
        '.claude/skills/task-board/SKILL.md',
        '.claude/skills/visual-diff-triage/SKILL.md',
        '.claude/skills/writing-tests/SKILL.md',
        '.github/CODEOWNERS.jinja',
        'AGENTS.md',
        'CLAUDE.md',
        'LICENSE',
        'README.md',
        'apps/api/Dockerfile',
        'apps/api/src/tasks/migrations/README.md',
        'apps/web/Dockerfile',
        'apps/web/src/routeTree.gen.ts',
        'docs/CODEOWNERS',
        'e2e/specs/README.md',
        'tools/visual.Dockerfile',
        'tools/zcode-plugin/README.md',
        // Dockerfile с приставкой — то же имя для сборщика образа
        'deploy/prod.Dockerfile',
      ]),
    ).toEqual([]);
  });

  it('похожее имя, которого нет в списке, — нарушение, а не новое исключение', () => {
    const problems = problemsOf([
      'docs/README.mdx',
      'x/MySKILL.md',
      // приставка Dockerfile сама вне стандарта — не исключение
      'tools/Visual.Dockerfile',
      'x/routeTree.gen.tsx',
      'x/AGENTS.mdx',
      // исключение смотрит на имя файла, не каталога
      'Dockerfile/bar.tsx',
    ]);
    expect(problems).toHaveLength(6);
    for (const line of problems) {
      expect(line).toContain('заглавные буквы в «');
    }
    // порядок вывода — по пути: заглавная D раньше строчных
    expect(problems[0]).toContain('каталог: заглавные буквы в «Dockerfile»');
  });

  it('isException: точное имя или .Dockerfile со стандартной приставкой', () => {
    for (const name of EXCEPTION_NAMES) {
      expect(isException(name)).toBe(true);
    }
    expect(isException('visual.Dockerfile')).toBe(true);
    expect(isException('Visual.Dockerfile')).toBe(false);
    expect(isException('.Dockerfile')).toBe(false);
    expect(isException('README.mdx')).toBe(false);
    expect(isException('xSKILL.md')).toBe(false);
    expect(checkPath('a/b/SKILL.md')).toEqual([]);
  });
});

describe('один источник исключений с документацией', () => {
  const paragraph = [
    '**Нейминг путей (b16).** Каталоги и имена файлов — строчными буквами.',
    `${DOC_ANCHOR} \`SKILL.md\` (заголовок скилов), \`AGENTS.md\` и \`CLAUDE.md\` (импорт \`@AGENTS.md\`), \`README.md\` и \`LICENSE\` (GitHub), \`Dockerfile\` (сборка образа, включая \`tools/visual.Dockerfile\`), \`CODEOWNERS\` и \`CODEOWNERS.jinja\` (GitHub), \`routeTree.gen.ts\` (пишет генератор маршрутов при сборке).`,
    "Инвентарь стандарта: `git ls-files | grep -E '[A-Z]'` — ровно эти 19 путей.",
  ].join('\n');

  it('абзац разбирается до конца предложения; скобки и следующее предложение — не имена', () => {
    expect(docExceptions(paragraph)).toEqual([
      'SKILL.md',
      'AGENTS.md',
      'CLAUDE.md',
      'README.md',
      'LICENSE',
      'Dockerfile',
      'CODEOWNERS',
      'CODEOWNERS.jinja',
      'routeTree.gen.ts',
    ]);
  });

  it('нет фразы-якоря — null, а не пустой список', () => {
    expect(docExceptions('Исключения — другие имена: `SKILL.md`.')).toBeNull();
    expect(docExceptions('')).toBeNull();
  });

  it('расхождение: лишнее или пропавшее имя; другой порядок — не расхождение', () => {
    expect(exceptionDrift(paragraph, 'x.md')).toBeNull();
    const reordered = paragraph.replace(
      '`SKILL.md` (заголовок скилов), `AGENTS.md`',
      '`AGENTS.md`, `SKILL.md` (заголовок скилов)',
    );
    expect(exceptionDrift(reordered, 'x.md')).toBeNull();
    const extra = exceptionDrift(paragraph.replace('`LICENSE`', '`LICENSE`, `Panel.tsx`'), 'x.md');
    expect(extra).toContain('x.md: список исключений нейминга (');
    expect(extra).toContain('Panel.tsx');
    expect(extra).toContain('разошёлся с tools/check-naming.ts');
    const missing = exceptionDrift(paragraph.replace(' и `LICENSE`', ''), 'x.md');
    expect(missing).toContain('разошёлся с tools/check-naming.ts');
    expect(exceptionDrift('другой текст', 'x.md')).toContain('x.md: нет фразы-якоря');
  });

  it('оба документа стандарта перечисляют список чекера (общий источник с b16)', () => {
    const expected = [...EXCEPTION_NAMES].toSorted();
    for (const file of DOC_SOURCES) {
      const text = readFileSync(join(repoDir, file), 'utf8');
      expect(text.split(DOC_ANCHOR)).toHaveLength(2);
      expect([...(docExceptions(text) ?? [])].toSorted()).toEqual(expected);
      expect(exceptionDrift(text, file)).toBeNull();
    }
  });
});

describe('проводка гейта naming', () => {
  it('verify-steps содержит шаг naming в fast-волне', () => {
    expect(fast.map((step) => step.name)).toContain('naming');
    const step = fast.find((item) => item.name === 'naming');
    expect(step?.command).toBe('pnpm');
    expect(step?.args).toEqual(['naming:check']);
  });

  it('package.json ведёт шаг к гейту', () => {
    const pkg = readJson('package.json');
    const scripts = isRecord(pkg) ? pkg['scripts'] : undefined;
    expect(isRecord(scripts) ? scripts['naming:check'] : undefined).toBe(
      'node tools/check-naming.ts',
    );
  });

  it('CI исполняет шаг в job static, а static входит в needs у gate', () => {
    const ci = readFileSync(join(repoDir, '.github/workflows/ci.yml'), 'utf8');
    const run = ci.indexOf('pnpm naming:check');
    expect(run).toBeGreaterThan(ci.indexOf('\n  static:'));
    expect(run).toBeLessThan(ci.indexOf('\n  unit:'));
    expect(ci).toMatch(/needs: \[static, unit, mutation, e2e, visual, perf\]/);
  });

  it('бюджет шага в verify-budgets.json', () => {
    const budgets = readJson('verify-budgets.json');
    const fastBudgets = isRecord(budgets) ? budgets['fast'] : undefined;
    expect(isRecord(fastBudgets) ? fastBudgets['naming'] : undefined).toBeTypeOf('number');
  });

  it('чекер в deny protected-paths.json и в denyWrite settings.json (пара З10)', () => {
    const paths = readJson('tools', 'protected-paths.json');
    const deny = isRecord(paths) && Array.isArray(paths['deny']) ? paths['deny'] : [];
    expect(deny).toContain('tools/check-naming.ts');
    const settings = readFileSync(join(repoDir, '.claude/settings.json'), 'utf8');
    expect(settings).toContain('"tools/check-naming.ts"');
  });

  it('чекер в KNOWN_GATES check-tool-class (fail-closed-якорь, З4)', () => {
    // tools/check-tool-class.ts: deny-запись внутри tools/ вне KNOWN_GATES красит
    // шаг tool-class — список обязан содержать новый файл.
    const source = readFileSync(join(repoDir, 'tools/check-tool-class.ts'), 'utf8');
    expect(source).toContain("'tools/check-naming.ts'");
  });

  it('оба правила гейта заканареечены (З6): имя вне стандарта и расхождение списка', () => {
    const source = readFileSync(join(repoDir, 'tools/gate-canaries.ts'), 'utf8');
    expect(source.match(/steps:\s*'naming'/g)).toHaveLength(2);
    expect(source).toMatch(/expect: \/заглавные буквы в «Bar\\\.tsx»\//);
    expect(source).toMatch(/expect: \/AGENTS\\\.md: список исключений нейминга /);
  });
});

describe('интеграция', () => {
  it('чекер зелёный на реальном дереве; пути с заглавной буквой — только исключения', () => {
    const run = runChecker(repoDir);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    const listed = spawnSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: repoDir, encoding: 'utf8' },
    );
    const paths = listed.stdout.split('\0').filter(Boolean);
    expect(paths.length).toBeGreaterThan(100);
    expect(run.stdout).toContain(`naming: ${paths.length} файлов — ok`);
    const uppercase = paths.filter((path) => path !== path.toLowerCase());
    expect(uppercase.length).toBeGreaterThan(0);
    expect(uppercase.filter((path) => checkPath(path).length > 0)).toEqual([]);
  });

  it('временный git-репозиторий: tracked и untracked вне .gitignore — в области, ignored — нет', () => {
    const dir = mkdtempSync(join(tmpdir(), 'naming-gate-'));
    try {
      /** Пишет файл во временное дерево, создавая каталоги. */
      const put = (file: string, text = ''): void => {
        mkdirSync(join(dir, file, '..'), { recursive: true });
        writeFileSync(join(dir, file), text);
      };
      const git = (...args: string[]): { status: number | null } =>
        spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
      put('.gitignore', 'junk/\n');
      for (const file of DOC_SOURCES) {
        put(file, readFileSync(join(repoDir, file), 'utf8'));
      }
      put('packages/foo/baz.tsx');
      put('packages/foo/Tracked.tsx');
      put('.claude/skills/x/SKILL.md');
      expect(git('init', '-q').status).toBe(0);
      expect(git('add', '-A').status).toBe(0);
      const committed = git(
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.com',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        'init',
      );
      expect(committed.status).toBe(0);
      // как в канарейке: файл-нарушение пишется в дерево и не коммитится. Имя
      // отличается от tracked-соседа не только регистром: на нечувствительной к
      // регистру файловой системе (macOS) Bar.tsx затёр бы bar.tsx.
      put('packages/foo/Qux.tsx');
      // ignored — вне области, даже с заглавной буквой
      put('junk/Bad.tsx');
      const run = runChecker(dir);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('packages/foo/Qux.tsx — файл: заглавные буквы в «Qux.tsx»');
      expect(run.stderr).toContain('packages/foo/Tracked.tsx');
      expect(run.stderr).not.toContain('junk/Bad.tsx');
      expect(run.stderr).not.toContain('SKILL.md');
      // список исключений во временном репозитории — копия настоящих документов
      expect(run.stderr).not.toContain('разошёлся');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
