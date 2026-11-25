/**
 * Гейт нейминга путей (b17; стандарт — AGENTS.md, абзац «Нейминг путей», и
 * architecture.md 2.7). После b16 стандарт ничем не был enforced: PascalCase-
 * имя или пробел в имени появлялись снова без единого сигнала.
 *
 * Правило: каждый сегмент пути — каталоги и имя файла — состоит из строчных
 * букв, цифр, `.`, `-`, `_` и начинается с буквы или цифры; первой может
 * стоять точка (`.gitignore`, `.github/`) или подчёркивание (`__root.tsx`,
 * `__screenshots__/`, `_journal.json`) — имена, которые инструменты требуют
 * дословно; инвентарь b16 считал только заглавные буквы и их не видел.
 * Каталоги — по тому же правилу, что и файлы: «без точки» из условия задачи
 * опровергается деревом — каталоги скриншотов зеркалят имя визуального теста
 * (`__screenshots__/button.visual.test.tsx/`, решение b16), а `.github/` и
 * `.claude/` требует дословно инструмент. Заглавная буква допустима только в
 * имени из списка исключений — имена, которые внешний инструмент требует
 * дословно; исключение смотрит на имя файла, `tools/visual.Dockerfile`
 * проходит как `Dockerfile` с приставкой, которая сама по стандарту.
 *
 * Один источник исключений (критерий b17): список живёт здесь, в deny
 * (tools/protected-paths.json) — расширить его без label
 * `gate-change-approved` нельзя (ADR 0014: класс файла — его роль в контуре
 * merge), — а чекер читает тот же абзац, что и b16, в обоих документах и
 * сверяет с ним список: другой набор имён или пропавшая фраза-якорь красят
 * шаг. Правка документации без правки чекера — и наоборот — не проходит.
 *
 * Область: всё, что попадёт в следующий коммит, — `git ls-files --cached
 * --others --exclude-standard`: tracked-файлы плюс untracked вне .gitignore.
 * Только tracked нельзя: канарейка (З6) пишет файл-нарушение в worktree, не
 * коммитя (индекс она не трогает — раннер откатывает файл через git clean).
 * Локальный мусор вне .gitignore чекер видит так же, как `git status`.
 *
 * Ядро чистое (findNamingViolations: список путей → проблемы), тесты гоняют
 * его на синтетических деревьях; проводка (шаг verify, job static CI, бюджет,
 * deny, KNOWN_GATES, канарейки) — tools/test/check-naming.test.ts.
 *
 *   pnpm naming:check      шаг verify (fast) и job static CI
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface NamingProblem {
  /** Путь от корня репозитория — как его выводит git. */
  path: string;
  /** Какой сегмент вне стандарта и почему. */
  reason: string;
}

/**
 * Имена, которые внешний инструмент требует дословно (b16): один список с
 * абзацем «Нейминг путей» AGENTS.md и разделом 2.7 architecture.md — сверку
 * держит exceptionDrift. Порядок — как в документации.
 */
export const EXCEPTION_NAMES: readonly string[] = [
  'SKILL.md', // загрузчик скилов
  'AGENTS.md', // импорт @AGENTS.md
  'CLAUDE.md',
  'README.md',
  'LICENSE',
  'Dockerfile', // сборка образа
  'CODEOWNERS',
  'CODEOWNERS.jinja',
  'routeTree.gen.ts', // пишет генератор маршрутов при сборке
];

/** Dockerfile с приставкой (`tools/visual.Dockerfile`) — то же имя для сборщика образа (решение 1 задачи b16). */
export const EXCEPTION_SUFFIXES: readonly string[] = ['.Dockerfile'];

/** Фраза, с которой в обоих документах начинается перечень имён-исключений. */
export const DOC_ANCHOR = 'Исключения — только имена, которые внешний инструмент требует дословно:';

/** Документы стандарта: абзац каждого обязан перечислять тот же список, что и чекер. */
export const DOC_SOURCES: readonly string[] = ['AGENTS.md', 'docs/architecture.md'];

const SEGMENT = /^\.?_*[a-z0-9][a-z0-9._-]*$/;
/** Приставка имени-исключения с суффиксом: сама по стандарту (`visual.`, не `Visual.`). */
const PREFIX = /^[a-z0-9][a-z0-9-]*$/;
const UPPERCASE = /\p{Lu}/u;
const WHITESPACE = /\s/u;
const FOREIGN = /[^a-z0-9._-]/gu;

export function isException(basename: string): boolean {
  if (EXCEPTION_NAMES.includes(basename)) {
    return true;
  }
  return EXCEPTION_SUFFIXES.some((suffix) => {
    const prefix = basename.slice(0, -suffix.length);
    return prefix.length > 0 && PREFIX.test(prefix) && basename.endsWith(suffix);
  });
}

/** Проблема одного сегмента пути или null — сегмент в стандарте. */
export function segmentProblem(segment: string, kind: 'каталог' | 'файл'): string | null {
  if (kind === 'файл' && isException(segment)) {
    return null;
  }
  if (UPPERCASE.test(segment)) {
    return `${kind}: заглавные буквы в «${segment}»`;
  }
  if (WHITESPACE.test(segment)) {
    return `${kind}: пробелы в имени «${segment}»`;
  }
  const foreign = [...new Set(segment.match(FOREIGN) ?? [])];
  if (foreign.length > 0) {
    return `${kind}: символы вне [a-z0-9._-] в «${segment}»: ${foreign.map((char) => `«${char}»`).join(', ')}`;
  }
  if (!SEGMENT.test(segment)) {
    return `${kind}: имя «${segment}» не начинается с буквы или цифры`;
  }
  return null;
}

/** Все сегменты пути вне стандарта — по одной причине на сегмент. */
export function checkPath(path: string): string[] {
  const segments = path.split('/');
  return segments.flatMap((segment, index) => {
    const kind = index === segments.length - 1 ? 'файл' : 'каталог';
    const problem = segmentProblem(segment, kind);
    return problem === null ? [] : [problem];
  });
}

/** Синтетическое дерево списком путей → проблемы, отсортированные по пути. */
export function findNamingViolations(paths: readonly string[]): NamingProblem[] {
  const problems: NamingProblem[] = [];
  for (const path of [...new Set(paths)].toSorted()) {
    for (const reason of checkPath(path)) {
      problems.push({ path, reason });
    }
  }
  return problems;
}

/**
 * Имена-исключения из абзаца стандарта: в обратных кавычках от фразы-якоря до
 * конца предложения. Пояснения в скобках — не имена (`импорт `@AGENTS.md``).
 * null — фразы-якорь в тексте нет.
 */
export function docExceptions(text: string): string[] | null {
  const at = text.indexOf(DOC_ANCHOR);
  if (at < 0) {
    return null;
  }
  const rest = text.slice(at + DOC_ANCHOR.length);
  let depth = 0;
  let inCode = false;
  let end = rest.length;
  // Индекс — в кодовых единицах UTF-16, как и slice ниже: символы вне BMP до точки
  // предложения не сдвигают границу.
  for (let index = 0; index < rest.length; index += 1) {
    const char = rest.charAt(index);
    if (char === '`') {
      inCode = !inCode;
    } else if (!inCode && char === '(') {
      depth += 1;
    } else if (!inCode && char === ')') {
      depth -= 1;
    } else if (!inCode && depth === 0 && char === '.') {
      end = index;
      break;
    }
  }
  const sentence = rest.slice(0, end).replace(/\([^()]*\)/g, '');
  return [...sentence.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '');
}

/**
 * Расхождение абзаца стандарта со списком чекера: другой набор имён или нет
 * фразы-якоря. null — список один. `file` — путь документа для сообщения.
 */
export function exceptionDrift(text: string, file: string): string | null {
  const listed = docExceptions(text);
  if (listed === null) {
    return `${file}: нет фразы-якоря «${DOC_ANCHOR}» — стандарт нейминга и tools/check-naming.ts разошлись: восстанови фразу или обнови список исключений в чекере тем же PR`;
  }
  const expected = [...EXCEPTION_NAMES].toSorted();
  const actual = [...listed].toSorted();
  if (expected.length !== actual.length || expected.some((name, index) => name !== actual[index])) {
    return `${file}: список исключений нейминга (${listed.join(', ')}) разошёлся с tools/check-naming.ts (${EXCEPTION_NAMES.join(', ')}) — список один: правь документацию и чекер тем же PR`;
  }
  return null;
}

function main(): void {
  const root = resolve(process.argv[2] ?? resolve(import.meta.dirname, '..'));
  const listed = spawnSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  if (listed.status !== 0) {
    console.error(
      `naming: git ls-files не удался (exit ${listed.status}) — проверка не выполнена, а не пройдена (З4): ${listed.stderr.trim()}`,
    );
    process.exit(1);
  }
  const paths = listed.stdout.split('\0').filter(Boolean);
  const problems = findNamingViolations(paths).map(
    (problem) => `${problem.path} — ${problem.reason}`,
  );
  if (paths.length === 0) {
    problems.push('git ls-files вернул 0 файлов — чекер слеп (это не репозиторий?)');
  }
  for (const file of DOC_SOURCES) {
    const path = join(root, file);
    if (!existsSync(path)) {
      problems.push(`${file}: документ стандарта отсутствует — список исключений не с чем сверить`);
      continue;
    }
    const drift = exceptionDrift(readFileSync(path, 'utf8'), file);
    if (drift !== null) {
      problems.push(drift);
    }
  }
  if (problems.length > 0) {
    console.error(
      `naming: ${problems.length} проблем — стандарт: AGENTS.md («Нейминг путей»), architecture.md 2.7 (строчные буквы, слова через дефис; исключения — имена, которые внешний инструмент требует дословно):`,
    );
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    process.exit(1);
  }
  const exceptions = paths.filter((path) => isException(path.slice(path.lastIndexOf('/') + 1)));
  console.log(
    `naming: ${paths.length} файлов — ok (вне стандарта 0; исключений по имени: ${exceptions.length})`,
  );
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
