/**
 * Гейт окружения (C3.1): `process.env` и `import.meta.env` читаются только в
 * модулях окружения приложения (C3.0 — server-config.ts, web/src/lib/env.ts) и
 * в явно перечисленных исключениях (конфиги сборки, тесты). Прямое чтение в
 * любом другом месте продукта — красный. Исключение документировано в задаче:
 * версия oxlint каталога не имеет no-process-env/no-restricted-syntax, поэтому
 * гейт — tools-чекер с тем же эффектом (условие возврата в журнале C3.1).
 * Значения переменных в вывод не попадают: среди них есть секреты.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// Явные исключения (задача C3.1): env-модули — единственное место чтения
// окружения; конфиги сборки/запуска тестов сами собирают окружение; тесты
// получают окружение инъекцией (loadServerEnv(source)) и читают его только
// в фиксации окружения запуска.
const ALLOWED = new Set([
  join('apps', 'api', 'src', 'server-config.ts'),
  join('apps', 'web', 'src', 'lib', 'env.ts'),
  join('apps', 'api', 'vite.config.ts'),
  join('apps', 'web', 'vite.config.ts'),
  join('apps', 'api', 'vitest.config.ts'),
  join('apps', 'web', 'vitest.config.ts'),
  // Тест-инфраструктура: конфигурация testcontainers читает DATABASE_URL
  // окружения запуска тестов (C1.2/C1.4) — fixture-конфиг, не продуктовый код.
  join('apps', 'api', 'test', 'test-database.ts'),
]);

const SKIP_DIRS = new Set(['node_modules', 'dist', '.output', 'coverage', 'reports']);
const USAGE = /\bprocess\.env\b|\bimport\.meta\.env\b/;

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) yield* sources(path);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    // Тесты — явное исключение задачи; генерируемый роутер Vite не продукт.
    if (/\.test\.tsx?$/.test(entry) || entry === 'routeTree.gen.ts') continue;
    yield path;
  }
}

const problems: string[] = [];
for (const app of ['apps/api', 'apps/web']) {
  for (const path of sources(app)) {
    if (ALLOWED.has(relative('.', path).split(sep).join('/')) || ALLOWED.has(path)) continue;
    const lines = readFileSync(path, 'utf8').split('\n');
    for (const [index, line] of lines.entries()) {
      if (USAGE.test(line)) {
        problems.push(`${path}:${index + 1}: чтение окружения вне модуля окружения`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error(
    `env: чтение окружения вне модулей окружения (C3.1):\n- ${problems.join('\n- ')}\n` +
      'Читай окружение только через env-модуль приложения (C3.0); исключения — в tools/check-env-usage.ts.',
  );
  process.exit(1);
}
console.log('env: process.env/import.meta.env только в модулях окружения и исключениях');
