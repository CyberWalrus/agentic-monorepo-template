import { readFileSync } from 'node:fs';
import { matchesGlob } from 'node:path';

import * as z from 'zod';

const ProtectedPathsSchema = z.object({
  deny: z.array(z.string()),
  review: z.array(z.string()),
});

export type Protection = 'deny' | 'review' | null;

const raw: unknown = JSON.parse(
  readFileSync(new URL('protected-paths.json', import.meta.url), 'utf8'),
);
const config = ProtectedPathsSchema.parse(raw);

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
