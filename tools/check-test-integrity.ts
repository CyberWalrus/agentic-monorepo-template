/**
 * Гейт целостности тестов: в коде нет сфокусированных, пропущенных и «залеченных» тестов.
 * Ловит то, что линтер может не увидеть: test.fixme/test.fail из Playwright (их добавляет
 * штатный Healer, когда не справляется), describe.only/skip, it.todo и т.п.
 */
import { glob, readFile } from 'node:fs/promises';

const FORBIDDEN =
  /\b(?:test|it|describe)(?:\.(?:describe|serial|parallel))?\.(only|skip|fixme|fail|todo)\s*\(/g;
const IGNORE = /(^|\/)(node_modules|dist|\.output|reports|test-results)\//;

const findings: string[] = [];
const patterns = [
  'apps/**/*.{ts,tsx}',
  'packages/**/*.{ts,tsx}',
  'e2e/**/*.ts',
  'tools/**/*.test.ts',
];
// withFileTypes: каталоги скриншотов называются как тест-файлы (tasks.visual.ts/).
for await (const entry of glob(patterns, { withFileTypes: true })) {
  const file = `${entry.parentPath}/${entry.name}`;
  if (!entry.isFile() || IGNORE.test(file)) {
    continue;
  }
  const lines = (await readFile(file, 'utf8')).split('\n');
  lines.forEach((line, index) => {
    for (const match of line.matchAll(FORBIDDEN)) {
      findings.push(`${file}:${index + 1}: .${match[1]}( is not allowed`);
    }
  });
}

if (findings.length > 0) {
  console.error(findings.join('\n'));
  console.error(
    '\nFocused, skipped or "healed" tests hide regressions. Fix the test or the code; if the app is wrong, report the bug.',
  );
  process.exit(1);
}
console.log('test integrity: ok');
