import { readFileSync } from 'node:fs';
import { matchesGlob } from 'node:path';

export type Protection = 'deny' | 'review' | null;

export interface ProtectedPaths {
  deny: string[];
  review: string[];
}

/**
 * Ручная валидация вместо zod: этот модуль импортируют хуки агента, которым нельзя
 * зависеть от node_modules (З4). Битый конфиг — throw: импортирующий хук упадёт
 * закрытым (exit 2), а не промолчит.
 */
export function parseProtectedPaths(raw: unknown): ProtectedPaths {
  if (!isRecord(raw)) {
    throw new Error(
      'tools/protected-paths.json: expected an object with "deny" and "review" arrays',
    );
  }
  return { deny: stringArray(raw['deny']), review: stringArray(raw['review']) };
}

/** Валидирует и возвращает список строк; на нарушении — throw (fail-closed). */
function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error('tools/protected-paths.json: "deny" and "review" must be arrays of strings');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const config = parseProtectedPaths(
  JSON.parse(readFileSync(new URL('protected-paths.json', import.meta.url), 'utf8')),
);

/** Снимает ведущие точки с сегментов-каталогов: `.claude/.b/x.md` → `claude/b/x.md`. */
function undotDirectories(value: string): string {
  const segments = value.split('/');
  const last = segments.length - 1;
  return segments
    .map((segment, index) => (index === last ? segment : segment.replace(/^\.+/, '')))
    .join('/');
}

/** Сегмент-каталог, начинающийся с точки (точка в имени файла в конце — не в счёт). */
const dotDirectory = /(^|\/)\.[^/]+\//;

const undotted = {
  deny: config.deny.map(undotDirectories),
  review: config.review.map(undotDirectories),
};

function protectionFor(path: string, deny: string[], review: string[]): Protection {
  const candidates = [path, `${path}/__child__`];
  const matches = (patterns: string[]) =>
    patterns.some((pattern) => candidates.some((candidate) => matchesGlob(candidate, pattern)));
  if (matches(deny)) {
    return 'deny';
  }
  if (matches(review)) {
    return 'review';
  }
  return null;
}

/**
 * Уровень защиты для пути относительно корня репозитория. Каталог, внутри
 * которого лежат защищённые файлы (например, `e2e/__screenshots__`), защищён так же.
 *
 * `**` и ведущий `*` в `path.matchesGlob` не пересекают сегменты-каталоги,
 * начинающиеся с точки: шаблон «`**` + `/.gitignore`» не покрывает
 * `.vite/.gitignore`, шаблон «`**` + `/.oxlintrc.json`» — `.claude/.oxlintrc.json`.
 * Поэтому путь с таким каталогом сверяется второй раз — без точек у
 * сегментов-каталогов, с обеих сторон (путь и паттерны). Путь без dot-каталога и
 * путь, у которого первая сверка дала deny, второй раз не проверяются; класс
 * второй сверки не бывает ниже первой.
 */
export function protectionOf(relativePath: string): Protection {
  const path = relativePath.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  const exact = protectionFor(path, config.deny, config.review);
  if (exact === 'deny' || !dotDirectory.test(path)) {
    return exact;
  }
  return protectionFor(undotDirectories(path), undotted.deny, undotted.review) ?? exact;
}
