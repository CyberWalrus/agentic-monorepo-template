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

/**
 * Уровень защиты для пути относительно корня репозитория. Каталог, внутри
 * которого лежат защищённые файлы (например, `e2e/__screenshots__`), защищён так же.
 */
export function protectionOf(relativePath: string): Protection {
  const path = relativePath.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  const candidates = [path, `${path}/__child__`];
  const matches = (patterns: string[]) =>
    patterns.some((pattern) => candidates.some((candidate) => matchesGlob(candidate, pattern)));
  if (matches(config.deny)) {
    return 'deny';
  }
  if (matches(config.review)) {
    return 'review';
  }
  return null;
}
