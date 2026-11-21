/**
 * Гейт порядка реестров (b7): файлы-реестры, которые правит каждая фича,
 * держат одну строку на домен в алфавитном порядке — тогда конфликты слияния
 * тривиальны (строка к строке), а порядок проверяется здесь. Перестановка
 * строк красит verify; канарейка — в gate-canaries (З6).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Registry {
  file: string;
  /** Комментарий-заголовок проверки для сообщений. */
  label: string;
  /** Строки-вхождения реестра (после trim). */
  match: RegExp;
  /** Ключ сортировки из строки-вхождения. */
  sortKey: (line: string) => string;
  /** Контекстные якоря: блок проверяется только между этими маркерами. */
  between: [string, string];
}

const REGISTRIES: Registry[] = [
  {
    file: 'packages/contracts/src/index.ts',
    label: 'реестр контрактов (export const contract)',
    match: /^\s{2}(\w+): (\w+Contract),$/,
    sortKey: (line) => line.trim(),
    between: ['export const contract = {', '};'],
  },
  {
    file: 'apps/api/src/router.ts',
    label: 'реестр роутера (export const router)',
    match: /^\s{2}(\w+): \w+,$/,
    sortKey: (line) => line.trim(),
    between: ['export const router = os.router({', '});'],
  },
  {
    file: 'packages/ui/src/index.ts',
    label: 'реестр UI-компонентов',
    match: /^export \{[^}]*\} from '\.\//,
    sortKey: (line) => line,
    between: ['', ''],
  },
];

const problems: string[] = [];

for (const registry of REGISTRIES) {
  const path = join(registry.file);
  const lines = readFileSync(path, 'utf8').split('\n');
  const start =
    registry.between[0] === '' ? 0 : lines.findIndex((line) => line.includes(registry.between[0]));
  const end =
    registry.between[1] === ''
      ? lines.length
      : lines.findIndex((line, index) => index > start && line.includes(registry.between[1]));
  if (start < 0 || end < 0) {
    problems.push(`${registry.file}: якоря реестра не найдены (${registry.label})`);
    continue;
  }
  const entries = lines
    .slice(start, end)
    .map((line) => line.trim())
    .filter((line) => registry.match.test(line));
  const sorted = entries.toSorted((a, b) => registry.sortKey(a).localeCompare(registry.sortKey(b)));
  if (JSON.stringify(entries) !== JSON.stringify(sorted)) {
    problems.push(
      `${registry.file}: ${registry.label} не в алфавитном порядке — держи одну строку на домен, отсортированно (b7)`,
    );
  }
}

if (problems.length > 0) {
  console.error(`registries:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('registries: реестры держат одну строку на домен в алфавитном порядке');
