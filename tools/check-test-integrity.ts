/**
 * Гейт целостности тестов (синтаксический слой A3): в коде нет сфокусированных,
 * пропущенных и «залеченных» тестов и подавляющих комментариев мутаций/покрытия.
 * Регулярное выражение держит то, чего JSON-отчёт раннера не видит (их проверяет
 * гейт test-report по З3): expected failure в Vitest — `fails` (в отчёте статус
 * "passed" без маркера, эмпирика 2026-11-13), его цепочки с .each/.skipIf/.runIf,
 * test.fail из Playwright (его добавляет штатный Healer, когда не справляется),
 * describe.only/skip, it.todo и комментарии Stryker disable / v8 / istanbul / c8
 * ignore — выключенные мутации и покрытие видит только их текст. Пропуски
 * skipIf/runIf здесь не флагуются: они исполняются и видны отчёту.
 */
import { glob, readFile } from 'node:fs/promises';

const FORBIDDEN =
  /\b(?:test|it|describe)(?:\.(?:describe|serial|parallel))?\.(only|skip|fixme|todo|fails?)(\.(?:each|skipIf|runIf))?\s*\(/g;
const SUPPRESSION = /(?:Stryker\s+disable|v8\s+ignore|istanbul\s+ignore|c8\s+ignore)/g;
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
      findings.push(`${file}:${index + 1}: .${match[1]}${match[2] ?? ''}( is not allowed`);
    }
    for (const match of line.matchAll(SUPPRESSION)) {
      findings.push(
        `${file}:${index + 1}: suppression comment "${match[0]}" — move the exclusion to the config (stryker/coverage) with a reason, so it is visible in review`,
      );
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
