import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { taskMigrationsFolder } from './database.ts';
import { collectSchemaSyncReport, type SchemaSyncReport } from './schema-sync.ts';

/**
 * CLI файловой проверки «схема совпадает с миграциями» (c1.3):
 * `pnpm --filter @repo/api db:check`. Выход 1 красит шаг: правка schema.ts
 * без миграции или битый журнал; data-only миграции печатаются как
 * предупреждения и шаг не красят. Сверка применения миграций с нуля со
 * схемой кода — integration-тест (test/schema-sync.postgres.test.ts).
 * Подключение выделенным шагом verify — операторский PR (ADR 0014), см.
 * ADR 0017.
 */

/** Строки отчёта для человека: одна строка на находку, «ОШИБКА»/«предупреждение». */
export function formatSchemaSyncReport(report: SchemaSyncReport): string[] {
  const lines: string[] = [];
  if (report.errors.length === 0 && report.warnings.length === 0) {
    lines.push('schema-sync: схема кода совпадает с миграциями.');
  }
  for (const error of report.errors) {
    lines.push(`schema-sync: ОШИБКА: ${error}`);
  }
  for (const warning of report.warnings) {
    lines.push(`schema-sync: предупреждение: ${warning}`);
  }
  return lines;
}

export interface SchemaSyncCheckOptions {
  /** Каталог миграций; по умолчанию каталог tasks (единый источник — database.ts). */
  migrationsFolder?: string;
  /** Пространство имён модуля схемы; по умолчанию src/tasks/schema.ts. */
  schemaImports?: Record<string, unknown>;
  /** Куда печатать отчёт; по умолчанию консоль. */
  log?: (line: string) => void;
}

/** Возвращает код выхода: 0 — гейт зелёный, 1 — красный (errors непуст). */
export async function runSchemaSyncCheck(options: SchemaSyncCheckOptions = {}): Promise<number> {
  const migrationsFolder = options.migrationsFolder ?? taskMigrationsFolder;
  const schemaImports = options.schemaImports ?? (await import('./schema.ts'));
  // process.stdout.write, а не console.log: no-console в src/ (правило
  // смягчено только для tools/ и scripts/, .oxlintrc.json защищён).
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const report = await collectSchemaSyncReport({ migrationsFolder, schemaImports });
  for (const line of formatSchemaSyncReport(report)) {
    log(line);
  }
  return report.errors.length === 0 ? 0 : 1;
}

/** Прямой запуск `node …/schema-sync-cli.ts`: экспорт нужен тестам гейта. */
export function isDirectInvocation(moduleUrl: string, argv1: string | undefined): boolean {
  return argv1 !== undefined && moduleUrl === pathToFileURL(resolve(argv1)).href;
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  process.exitCode = await runSchemaSyncCheck();
}
