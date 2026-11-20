import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { generateDrizzleJson, generateMigration, type DrizzleSnapshotJSON } from 'drizzle-kit/api';

/**
 * Гейт «схема совпадает с миграциями» (c1.3, ADR 0018): постоянное хранилище —
 * второй источник правды о форме данных, и без проверки он разъезжается с
 * миграциями (колонку, удалённую из схемы, но живую в базе, typecheck не видит:
 * drizzle читает только объявленные колонки). Отчёт собирает
 * `collectSchemaSyncReport`, запуск — `pnpm --filter @repo/api db:check`
 * (schema-sync-cli.ts). Файловая проверка не требует базы; сверка применения
 * миграций с нуля со схемой кода — integration-тест на Postgres
 * (test/schema-sync.postgres.test.ts, `pushSchema`).
 *
 * Списки отчёта: `errors` красят гейт (правка schema.ts без миграции, битая
 * цепочка журнала), `warnings` не красят (data-only миграция expand/contract —
 * журнал задачи c1.3). Подключение выделенным шагом verify и review-класс
 * каталога миграций — операторский PR (ADR 0014, правило декомпозиции); до
 * него enforcement держит шаг `test` fast-волны (vitest).
 */

export interface SchemaSyncReport {
  /** Красят гейт: гейт падает, пока список непуст. */
  errors: string[];
  /** Не красят: то, что человек должен увидеть глазами (data-only миграции). */
  warnings: string[];
}

interface JournalEntry {
  idx: number;
  tag: string;
}

interface LoadedSnapshot {
  id: string;
  prevId: string;
  /** Содержимое JSON, суженное валидацией до формы снапшота drizzle-kit. */
  content: DrizzleSnapshotJSON;
}

interface LoadedMigration {
  idx: number;
  tag: string;
  sqlExists: boolean;
  snapshot?: LoadedSnapshot;
}

const JOURNAL_RELPATH = 'meta/_journal.json';
/** prevId первого снапшота: договорённость drizzle-kit о корне цепочки. */
const ZERO_SNAPSHOT_ID = '00000000-0000-0000-0000-000000000000';
/**
 * drizzle-kit 0.31 называет снапшоты `<idx>_snapshot.json` (с padStart 4),
 * а SQL-файлы — `<idx>_<tag>.sql`: имя снапшота выводится из idx, не из тега.
 */
function snapshotRelPath(idx: number): string {
  return `meta/${String(idx).padStart(4, '0')}_snapshot.json`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Форма снапшота, достаточная для запуска диффа: объект с таблицами. Глубину
 * полей здесь не проверяем — её при диффе проверяет zod самого drizzle-kit,
 * и кривой снапшот попадает в catch как ошибка гейта (fail-closed), поэтому
 * `as` не нужен.
 */
function isDrizzleSnapshot(value: unknown): value is DrizzleSnapshotJSON {
  return isRecord(value) && isRecord(value['tables']);
}

/**
 * Сравнение содержимого снапшотов без зависимости от порядка ключей JSON:
 * id/prevId срезаются — их смена есть и у data-only миграции
 * (`drizzle-kit generate --custom` пишет новый id и тот же prevId-хвост).
 */
function stableStringify(value: unknown): string {
  if (isRecord(value)) {
    const keys = Object.keys(value).toSorted();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Содержимое снапшота без id/prevId — то, что сравнивается между соседями. */
function stripSnapshotIdentity(snapshot: LoadedSnapshot): string {
  const withoutIdentity: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(snapshot.content)) {
    if (key !== 'id' && key !== 'prevId') {
      withoutIdentity[key] = value;
    }
  }
  return stableStringify(withoutIdentity);
}

function readJournal(migrationsFolder: string, problems: string[]): JournalEntry[] {
  const journalPath = join(migrationsFolder, JOURNAL_RELPATH);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(journalPath, 'utf8'));
  } catch (error) {
    problems.push(`журнал миграций ${journalPath} не прочитан: ${messageOf(error)}`);
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed['entries'])) {
    problems.push(`журнал миграций ${journalPath}: нет массива entries`);
    return [];
  }
  const entries: JournalEntry[] = [];
  for (const raw of parsed['entries']) {
    if (!isRecord(raw) || typeof raw['idx'] !== 'number' || typeof raw['tag'] !== 'string') {
      problems.push(`журнал миграций ${journalPath}: запись без числового idx или строкового tag`);
      continue;
    }
    entries.push({ idx: raw['idx'], tag: raw['tag'] });
  }
  entries.sort((first, second) => first.idx - second.idx);
  for (const [expected, entry] of entries.entries()) {
    if (entry.idx !== expected) {
      problems.push(
        `журнал миграций ${journalPath}: idx непоследователен — ожидался ${expected}, у записи ${entry.tag} стоит ${entry.idx}`,
      );
      break;
    }
  }
  return entries;
}

/**
 * SQL-файлы каталога, на которые не ссылается журнал: мигратор применяет
 * только записи журнала, поэтому такой файл — мусор или оборвавшийся
 * `generate`; он должен быть либо убран, либо возвращён в журнал.
 */
function addUnjournaledSqlProblems(
  migrationsFolder: string,
  entries: JournalEntry[],
  problems: string[],
): void {
  const journaledTags = new Set(entries.map((entry) => entry.tag));
  for (const name of readdirSync(migrationsFolder).toSorted()) {
    if (!name.endsWith('.sql')) {
      continue;
    }
    const tag = name.slice(0, -'.sql'.length);
    if (!journaledTags.has(tag)) {
      problems.push(
        `SQL-файл ${name} вне журнала миграций: мигратор его не применит — убери файл или верни запись в журнал`,
      );
    }
  }
}

function parseSnapshot(text: string, snapshotPath: string): LoadedSnapshot | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return `снапшот ${snapshotPath} не прочитан: ${messageOf(error)}`;
  }
  if (
    !isRecord(parsed) ||
    typeof parsed['id'] !== 'string' ||
    typeof parsed['prevId'] !== 'string'
  ) {
    return `снапшот ${snapshotPath}: нет строковых id/prevId — журнал миграций неполон`;
  }
  if (!isDrizzleSnapshot(parsed)) {
    return `снапшот ${snapshotPath}: нет таблиц — журнал миграций неполон`;
  }
  return { id: parsed['id'], prevId: parsed['prevId'], content: parsed };
}

/**
 * Журнал и снапшоты каталога миграций. Найденные повреждения копятся в
 * `problems` (гейт красит списком), но чтение продолжается: отчёт собирает
 * максимум находок за прогон, а не первую ошибку.
 */
function loadMigrationChain(migrationsFolder: string, problems: string[]): LoadedMigration[] {
  const entries = readJournal(migrationsFolder, problems);
  addUnjournaledSqlProblems(migrationsFolder, entries, problems);
  const migrations: LoadedMigration[] = [];
  for (const entry of entries) {
    const sqlPath = join(migrationsFolder, `${entry.tag}.sql`);
    const snapshotPath = join(migrationsFolder, snapshotRelPath(entry.idx));
    const migration: LoadedMigration = {
      idx: entry.idx,
      tag: entry.tag,
      sqlExists: existsSync(sqlPath),
    };
    if (!migration.sqlExists) {
      problems.push(`миграция ${entry.tag}: SQL-файл ${sqlPath} отсутствует`);
    }
    if (!existsSync(snapshotPath)) {
      problems.push(`миграция ${entry.tag}: снапшот ${snapshotPath} отсутствует`);
    } else {
      const parsed = parseSnapshot(readFileSync(snapshotPath, 'utf8'), snapshotPath);
      if (typeof parsed === 'string') {
        problems.push(parsed);
      } else {
        migration.snapshot = parsed;
      }
    }
    migrations.push(migration);
  }
  for (const [position, migration] of migrations.entries()) {
    const snapshot = migration.snapshot;
    if (snapshot === undefined) {
      continue; // своя проблема уже в списке
    }
    const previous = position > 0 ? migrations[position - 1]?.snapshot : undefined;
    if (position === 0 && snapshot.prevId !== ZERO_SNAPSHOT_ID) {
      problems.push(
        `первый снапшот ${migration.tag} ссылается на prevId ${snapshot.prevId} вместо нулевого ${ZERO_SNAPSHOT_ID}`,
      );
    }
    if (previous !== undefined && snapshot.prevId !== previous.id) {
      problems.push(
        `снапшот ${migration.tag} ссылается на prevId ${snapshot.prevId}, а предыдущий снапшот имеет id ${previous.id}`,
      );
    }
  }
  return migrations;
}

/**
 * Теги миграций, не изменивших схему: содержимое снапшота равно
 * predecessor'у (отличаются только id/prevId). Это канонический след
 * `drizzle-kit generate --custom` — data-only миграция expand/contract
 * (журнал задачи c1.3), и человек должен видеть её глазами.
 *
 * Соседи берутся по позиции массива: журнал уже проверен на непрерывность
 * idx (в противном случае гейт красит), поэтому сосед по массиву — сосед
 * по idx. Дыра в снапшотах сравнение прерывает: она уже красит гейт, и
 * сравнение через дыру дало бы ложное предупреждение.
 */
function dataOnlyMigrationTags(migrations: LoadedMigration[]): string[] {
  const tags: string[] = [];
  for (const [position, migration] of migrations.entries()) {
    const previousSnapshot = migrations[position - 1]?.snapshot;
    if (previousSnapshot === undefined || migration.snapshot === undefined) {
      continue;
    }
    if (stripSnapshotIdentity(migration.snapshot) === stripSnapshotIdentity(previousSnapshot)) {
      tags.push(migration.tag);
    }
  }
  return tags;
}

export interface SchemaSyncInput {
  migrationsFolder: string;
  /** Пространство имён модуля схемы (как у `drizzle-kit generate`). */
  schemaImports: Record<string, unknown>;
}

/**
 * Полный отчёт файловой проверки: журнал, цепочка снапшотов, дифф последнего
 * снапшота против схемы кода, data-only миграции. База не нужна.
 */
export async function collectSchemaSyncReport(input: SchemaSyncInput): Promise<SchemaSyncReport> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const migrations = loadMigrationChain(input.migrationsFolder, errors);
  if (migrations.length === 0 && errors.length === 0) {
    errors.push('журнал миграций пуст: схема кода не покрыта ни одной миграцией');
  }
  const latestSnapshot = migrations.at(-1)?.snapshot;
  if (latestSnapshot !== undefined) {
    try {
      // Глубину содержимого проверяет zod внутри generateMigration: кривой
      // снапшот попадает в catch и красит гейт объяснением (fail-closed).
      const statements = await generateMigration(
        latestSnapshot.content,
        generateDrizzleJson(input.schemaImports),
      );
      if (statements.length > 0) {
        errors.push(
          `схема кода расходится с миграциями (нужна \`pnpm --filter @repo/api db:generate\`): ${statements.join('; ')}`,
        );
      }
    } catch (error) {
      errors.push(
        `последний снапшот ${migrations.at(-1)?.tag} не сверён со схемой кода: ${messageOf(error)}`,
      );
    }
  }
  for (const tag of dataOnlyMigrationTags(migrations)) {
    warnings.push(
      `миграция ${tag} не меняет схему (data-only): по правилу expand/contract сжатие — отдельный шаг после выката кода, проверь её SQL глазами`,
    );
  }
  return { errors, warnings };
}
