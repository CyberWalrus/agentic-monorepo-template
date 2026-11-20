import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { generateDrizzleJson } from 'drizzle-kit/api';
import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { collectSchemaSyncReport, type SchemaSyncReport } from './schema-sync.ts';
import {
  formatSchemaSyncReport,
  isDirectInvocation,
  runSchemaSyncCheck,
} from './schema-sync-cli.ts';

// Синтетический домен вместо tasks: дифф считается на модуле схемы, база
// не нужна. «Широкая» таблица — правка schema.ts, которой ещё нет в снапшоте.
const narrowTable = pgTable('fake', {
  id: uuid('id').primaryKey(),
  title: text('title').notNull(),
});
const wideTable = pgTable('fake', {
  id: uuid('id').primaryKey(),
  title: text('title').notNull(),
  note: text('note'),
});
const narrowModule = { narrowTable };
const wideModule = { wideTable };

const ZERO_ID = '00000000-0000-0000-0000-000000000000';
const ID0 = '11111111-1111-4111-8111-111111111111';
const ID1 = '22222222-2222-4222-8222-222222222222';

let catalogRoot: string;

beforeEach(() => {
  catalogRoot = mkdtempSync(join(tmpdir(), 'schema-sync-test-'));
});

afterEach(() => {
  rmSync(catalogRoot, { recursive: true, force: true });
});

/** Снапшот фикстуры: содержимое из drizzle + управляемые id цепочки. */
function snapshotText(schemaModule: Record<string, unknown>, id: string, prevId: string): string {
  const content = generateDrizzleJson(schemaModule);
  return JSON.stringify({ ...content, id, prevId }, null, 2);
}

interface FixtureEntry {
  idx: number;
  tag: string;
  /** Текст снапшота; undefined — файл снапшота не писать (повреждение). */
  snapshot?: string;
  /** Писать ли SQL-файл миграции (по умолчанию да — пустой, как у data-only). */
  withSql?: boolean;
}

/** Имя снапшота в каталоге: drizzle-kit 0.31 — `<idx с pad 4>_snapshot.json`. */
function snapshotFileName(idx: number): string {
  return `${String(idx).padStart(4, '0')}_snapshot.json`;
}

function writeCatalog(entries: FixtureEntry[]): void {
  const migrations = join(catalogRoot, 'migrations');
  mkdirSync(join(migrations, 'meta'), { recursive: true });
  writeFileSync(
    join(migrations, 'meta', '_journal.json'),
    JSON.stringify(
      {
        version: '7',
        dialect: 'postgresql',
        entries: entries.map(({ idx, tag }) => ({
          idx,
          version: '7',
          when: idx + 1,
          tag,
          breakpoints: true,
        })),
      },
      null,
      2,
    ),
  );
  for (const entry of entries) {
    if (entry.withSql === false) {
      continue;
    }
    writeFileSync(join(migrations, `${entry.tag}.sql`), '-- fixture\n');
  }
  for (const entry of entries) {
    if (entry.snapshot === undefined) {
      continue;
    }
    writeFileSync(join(migrations, 'meta', snapshotFileName(entry.idx)), entry.snapshot);
  }
}

async function reportFor(schemaImports: Record<string, unknown>): Promise<SchemaSyncReport> {
  return collectSchemaSyncReport({
    migrationsFolder: join(catalogRoot, 'migrations'),
    schemaImports,
  });
}

describe('collectSchemaSyncReport', () => {
  it('зелёный каталог: одна миграция со снапшотом, равным схеме кода', async () => {
    writeCatalog([
      { idx: 0, tag: '0000_init', snapshot: snapshotText(narrowModule, ID0, ZERO_ID) },
    ]);

    const report = await reportFor(narrowModule);

    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it('история с расширением схемы: миграция сопровождает правку schema.ts — находок нет', async () => {
    writeCatalog([
      { idx: 0, tag: '0000_init', snapshot: snapshotText(narrowModule, ID0, ZERO_ID) },
      { idx: 1, tag: '0001_note', snapshot: snapshotText(wideModule, ID1, ID0) },
    ]);

    const report = await reportFor(wideModule);

    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it('правка схемы без миграции красит гейт оператором недостающей миграции', async () => {
    // Снапшот не знает про колонку note, а schema.ts её уже объявил.
    writeCatalog([
      { idx: 0, tag: '0000_init', snapshot: snapshotText(narrowModule, ID0, ZERO_ID) },
    ]);

    const report = await reportFor(wideModule);

    expect(report.errors).toEqual([expect.stringContaining('схема кода расходится с миграциями')]);
    expect(report.errors[0]).toContain('ADD COLUMN');
  });

  it('снапшот богаче схемы кода: лишняя в миграциях колонка тоже красит гейт', async () => {
    writeCatalog([{ idx: 0, tag: '0000_init', snapshot: snapshotText(wideModule, ID0, ZERO_ID) }]);

    const report = await reportFor(narrowModule);

    expect(report.errors).toEqual([expect.stringContaining('схема кода расходится с миграциями')]);
    expect(report.errors[0]).toContain('DROP COLUMN');
  });

  it('миграция без правки схемы — предупреждение, гейт остаётся зелёным', async () => {
    // Канонический след `drizzle-kit generate --custom`: новый id, прежнее
    // содержимое (журнал c1.3). Схема кода по-прежнему узкая.
    writeCatalog([
      { idx: 0, tag: '0000_init', snapshot: snapshotText(narrowModule, ID0, ZERO_ID) },
      { idx: 1, tag: '0001_backfill', snapshot: snapshotText(narrowModule, ID1, ID0) },
    ]);

    const report = await reportFor(narrowModule);

    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([expect.stringContaining('0001_backfill не меняет схему')]);
    expect(report.warnings[0]).toContain('expand/contract');
  });

  it('две data-only миграции подряд — по предупреждению на каждую', async () => {
    const id2 = '33333333-3333-4333-8333-333333333333';
    writeCatalog([
      { idx: 0, tag: '0000_init', snapshot: snapshotText(narrowModule, ID0, ZERO_ID) },
      { idx: 1, tag: '0001_backfill', snapshot: snapshotText(narrowModule, ID1, ID0) },
      { idx: 2, tag: '0002_backfill_more', snapshot: snapshotText(narrowModule, id2, ID1) },
    ]);

    const report = await reportFor(narrowModule);

    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([
      expect.stringContaining('0001_backfill не меняет схему'),
      expect.stringContaining('0002_backfill_more не меняет схему'),
    ]);
  });

  it('дыра в снапшотах не порождает data-only предупреждений через дыру', async () => {
    // Снапшот второй миграции отсутствует: гейт уже красит, и сравнение
    // третьей миграции через дыру с первой не должно добавлять ложный warning.
    const id2 = '33333333-3333-4333-8333-333333333333';
    writeCatalog([
      { idx: 0, tag: '0000_init', snapshot: snapshotText(narrowModule, ID0, ZERO_ID) },
      { idx: 1, tag: '0001_lost' },
      { idx: 2, tag: '0002_after_hole', snapshot: snapshotText(narrowModule, id2, ID1) },
    ]);

    const report = await reportFor(narrowModule);

    expect(report.errors).toEqual([expect.stringContaining('отсутствует')]);
    expect(report.warnings).toEqual([]);
  });

  it('битая цепочка prevId красит гейт', async () => {
    const foreignId = '44444444-4444-4444-8444-444444444444';
    writeCatalog([
      { idx: 0, tag: '0000_init', snapshot: snapshotText(narrowModule, ID0, ZERO_ID) },
      { idx: 1, tag: '0001_next', snapshot: snapshotText(narrowModule, ID1, foreignId) },
    ]);

    const report = await reportFor(narrowModule);

    expect(report.errors).toEqual([
      expect.stringContaining('снапшот 0001_next ссылается на prevId'),
    ]);
  });

  it('первый снапшот с ненулевым prevId красит гейт', async () => {
    writeCatalog([{ idx: 0, tag: '0000_init', snapshot: snapshotText(narrowModule, ID0, ID1) }]);

    const report = await reportFor(narrowModule);

    expect(report.errors).toEqual([
      expect.stringContaining('первый снапшот 0000_init ссылается на prevId'),
    ]);
  });

  it('отсутствующий снапшот красит гейт, а чтение продолжается', async () => {
    writeCatalog([
      { idx: 0, tag: '0000_init', snapshot: snapshotText(narrowModule, ID0, ZERO_ID) },
      // снапшот второй миграции не пишем: журнал ссылается на отсутствующий файл
      { idx: 1, tag: '0001_lost' },
    ]);

    const report = await reportFor(narrowModule);

    expect(report.errors).toEqual([expect.stringContaining('отсутствует')]);
    expect(report.errors[0]).toContain('0001_snapshot.json');
    expect(report.errors[0]).toContain('0001_lost');
  });

  it('отсутствующий SQL-файл миграции красит гейт', async () => {
    writeCatalog([
      {
        idx: 0,
        tag: '0000_init',
        snapshot: snapshotText(narrowModule, ID0, ZERO_ID),
        withSql: false,
      },
    ]);

    const report = await reportFor(narrowModule);

    expect(report.errors).toEqual([expect.stringContaining('SQL-файл')]);
    expect(report.errors[0]).toContain('0000_init.sql');
  });

  it('SQL-файл вне журнала красит гейт', async () => {
    writeCatalog([
      { idx: 0, tag: '0000_init', snapshot: snapshotText(narrowModule, ID0, ZERO_ID) },
    ]);
    writeFileSync(join(catalogRoot, 'migrations', '0001_orphan.sql'), '-- не в журнале\n');

    const report = await reportFor(narrowModule);

    expect(report.errors).toEqual([
      expect.stringContaining('0001_orphan.sql вне журнала миграций'),
    ]);
  });

  it('служебные файлы каталога (не SQL) вне журнала не красят гейт', async () => {
    writeCatalog([
      { idx: 0, tag: '0000_init', snapshot: snapshotText(narrowModule, ID0, ZERO_ID) },
    ]);
    writeFileSync(join(catalogRoot, 'migrations', '0000_init.sql.bak'), '-- не SQL-миграция\n');

    const report = await reportFor(narrowModule);

    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it('журнал без массива entries красит гейт', async () => {
    writeCatalog([]);
    writeFileSync(
      join(catalogRoot, 'migrations', 'meta', '_journal.json'),
      JSON.stringify({ version: '7', dialect: 'postgresql' }),
    );

    const report = await reportFor(narrowModule);

    expect(report.errors).toEqual([expect.stringContaining('нет массива entries')]);
  });

  it('нечитаемый журнал красит гейт', async () => {
    writeCatalog([]);
    writeFileSync(join(catalogRoot, 'migrations', 'meta', '_journal.json'), '{ неполный json');

    const report = await reportFor(narrowModule);

    expect(report.errors).toEqual([expect.stringContaining('не прочитан')]);
  });

  it('непоследовательные idx журнала красят гейт', async () => {
    writeCatalog([
      { idx: 0, tag: '0000_init', snapshot: snapshotText(narrowModule, ID0, ZERO_ID) },
      { idx: 2, tag: '0002_skip', snapshot: snapshotText(narrowModule, ID1, ID0) },
    ]);

    const report = await reportFor(narrowModule);

    expect(report.errors).toEqual([expect.stringContaining('idx непоследователен')]);
  });

  it('пустой журнал красит гейт: схема не покрыта миграциями', async () => {
    writeCatalog([]);

    const report = await reportFor(narrowModule);

    expect(report.errors).toEqual([expect.stringContaining('журнал миграций пуст')]);
  });

  it('кривое содержимое снапшота красит гейт объяснением, а не падением', async () => {
    // Форму на входе дифф-функция принимает, глубину колонок проверяет zod:
    // кривой снапшот красит гейт объяснением из catch (fail-closed).
    writeCatalog([
      {
        idx: 0,
        tag: '0000_init',
        snapshot: JSON.stringify({
          id: ID0,
          prevId: ZERO_ID,
          tables: { 'public.fake': { name: 'fake', schema: '', columns: { id: 'не объект' } } },
        }),
      },
    ]);

    const report = await reportFor(narrowModule);

    expect(report.errors).toEqual([expect.stringContaining('0000_init не сверён со схемой кода')]);
  });

  it('снапшот без таблиц красит гейт объяснением', async () => {
    writeCatalog([
      {
        idx: 0,
        tag: '0000_init',
        snapshot: JSON.stringify({ id: ID0, prevId: ZERO_ID, tables: 'не объект' }),
      },
    ]);

    const report = await reportFor(narrowModule);

    expect(report.errors).toEqual([expect.stringContaining('нет таблиц')]);
  });
});

describe('runSchemaSyncCheck', () => {
  it('зелёный каталог: код 0 и строка-подтверждение', async () => {
    writeCatalog([
      { idx: 0, tag: '0000_init', snapshot: snapshotText(narrowModule, ID0, ZERO_ID) },
    ]);
    const logged: string[] = [];

    const code = await runSchemaSyncCheck({
      migrationsFolder: join(catalogRoot, 'migrations'),
      schemaImports: narrowModule,
      log: (line) => logged.push(line),
    });

    expect(code).toBe(0);
    expect(logged).toEqual(['schema-sync: схема кода совпадает с миграциями.']);
  });

  it('красный каталог: код 1 и строка с ОШИБКА', async () => {
    writeCatalog([
      { idx: 0, tag: '0000_init', snapshot: snapshotText(narrowModule, ID0, ZERO_ID) },
    ]);
    const logged: string[] = [];

    const code = await runSchemaSyncCheck({
      migrationsFolder: join(catalogRoot, 'migrations'),
      schemaImports: wideModule, // схема ушла вперёд без миграции
      log: (line) => logged.push(line),
    });

    expect(code).toBe(1);
    expect(logged).toEqual([expect.stringContaining('ADD COLUMN')]);
    expect(logged[0]).toContain('ОШИБКА');
  });

  it('data-only каталог: предупреждение печатается, код остаётся 0', async () => {
    writeCatalog([
      { idx: 0, tag: '0000_init', snapshot: snapshotText(narrowModule, ID0, ZERO_ID) },
      { idx: 1, tag: '0001_backfill', snapshot: snapshotText(narrowModule, ID1, ID0) },
    ]);
    const logged: string[] = [];

    const code = await runSchemaSyncCheck({
      migrationsFolder: join(catalogRoot, 'migrations'),
      schemaImports: narrowModule,
      log: (line) => logged.push(line),
    });

    expect(code).toBe(0);
    expect(logged).toEqual([expect.stringContaining('предупреждение: миграция 0001_backfill')]);
  });
});

describe('formatSchemaSyncReport', () => {
  it('ошибки и предупреждения печатаются отдельными строками с префиксом', () => {
    const lines = formatSchemaSyncReport({
      errors: ['первая', 'вторая'],
      warnings: ['смотреть глазами'],
    });

    expect(lines).toEqual([
      'schema-sync: ОШИБКА: первая',
      'schema-sync: ОШИБКА: вторая',
      'schema-sync: предупреждение: смотреть глазами',
    ]);
  });
});

describe('isDirectInvocation', () => {
  const syntheticUrl = pathToFileURL('/repo/apps/api/src/tasks/schema-sync-cli.ts').href;
  // Реальное положение cli относительно этого теста: src/tasks/<name>.ts.
  const cliUrl = pathToFileURL(
    join(dirname(fileURLToPath(import.meta.url)), 'schema-sync-cli.ts'),
  ).href;

  it('прямой запуск: модуль совпадает с argv1', () => {
    expect(isDirectInvocation(syntheticUrl, '/repo/apps/api/src/tasks/schema-sync-cli.ts')).toBe(
      true,
    );
  });

  it('относительный argv1 резолвится против cwd', () => {
    // Без process.chdir: он запрещён в воркерах (stryker, rev c1.3). Относительный
    // путь от текущего cwd к cli проверяет тот же контракт в любом cwd.
    const cliPath = join(dirname(fileURLToPath(import.meta.url)), 'schema-sync-cli.ts');
    expect(isDirectInvocation(cliUrl, relative(process.cwd(), cliPath))).toBe(true);
  });

  it('чужой argv1 (vitest, другой скрипт) — не прямой запуск', () => {
    expect(isDirectInvocation(syntheticUrl, '/repo/node_modules/vitest/vitest.mjs')).toBe(false);
  });

  it('argv1 без значения — не прямой запуск', () => {
    expect(isDirectInvocation(syntheticUrl, undefined)).toBe(false);
  });
});
