/**
 * Тесты генератора фичи (c7): запуск настоящего `tools/gen.ts` subprocess-ом
 * против фикстуры-репозитория с файлами-образцами проводки. Импорта тестируемого
 * файла здесь нет (как в backlog-cli.test.ts): tools/, втянутый в импорты
 * tools/test/**, попадает в замыкание гейт-контурa и обязан быть deny
 * (check-tool-class), а генератор — инструмент review-класса. pnpm подменяется
 * стабом через PATH: форматирование и openapi на юнит-уровне проверяются фактом
 * вызова; содержимое шаблонов против всех гейтов проверяет канарейка
 * `pnpm gen canary` (временный worktree + pnpm verify).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const genCli = resolve(import.meta.dirname, '../gen.ts');
const repoDir = resolve(import.meta.dirname, '..', '..');
const byCode = (a: string, b: string): number => a.localeCompare(b);

/** Файлы-образцы проводки: генератор проверяет якоря против их настоящей формы. */
const PATCH_TARGETS = [
  'packages/contracts/src/index.ts',
  'apps/api/src/router.ts',
  'apps/api/src/authorization.ts',
  'apps/api/src/app.ts',
];

const tmpDirs: string[] = [];

afterAll(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

interface GenRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runGen(args: string[], root: string, extraEnv: NodeJS.ProcessEnv = {}): GenRun {
  const result = spawnSync('node', [genCli, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * Стаб pnpm: каждый вызов дописывает свои аргументы в GEN_STUB_LOG. Юнит-тесту
 * не нужны настоящие pnpm/oxfmt/воркспейс — только факт и аргументы вызова.
 */
function stubbedPnpm(): { path: string; log: string; env: NodeJS.ProcessEnv } {
  const dir = tempDir('c7-stub-');
  const log = join(dir, 'calls.log');
  writeFileSync(join(dir, 'pnpm'), '#!/bin/sh\necho "$@" >> "$GEN_STUB_LOG"\nexit 0\n', {
    mode: 0o755,
  });
  return {
    path: dir,
    log,
    env: { GEN_STUB_LOG: log, PATH: `${dir}:${process.env['PATH'] ?? ''}` },
  };
}

/** Фикстура-репозиторий: настоящие файлы проводки + tasks.ts как занятое имя. */
function fixture(): string {
  const dir = tempDir('c7-gen-');
  mkdirSync(join(dir, 'reports'), { recursive: true });
  for (const path of [...PATCH_TARGETS, 'packages/contracts/src/tasks.ts']) {
    const target = join(dir, path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, readFileSync(join(repoDir, path), 'utf8'));
  }
  spawnSync('git', ['init', '-q', dir]);
  return dir;
}

function read(root: string, path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

describe('gen feature', () => {
  it('generates all five layers, wires them and runs the post steps', () => {
    const root = fixture();
    const pnpm = stubbedPnpm();

    const run = runGen(['feature', 'notes'], root, pnpm.env);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Фича «notes» сгенерирована');

    const index = read(root, 'packages/contracts/src/index.ts');
    expect(index).toContain("import { notesContract } from './notes.ts';");
    expect(index).toContain('  tasks: tasksContract,\n  notes: notesContract,');
    expect(index).toContain("} from './notes.ts';");

    const contract = read(root, 'packages/contracts/src/notes.ts');
    expect(contract).toContain('export const notesContract = {');
    expect(contract).toContain("path: '/notes'");

    const router = read(root, 'apps/api/src/router.ts');
    expect(router).toContain('  notes: {\n    list: os.notes.list.handler(');
    expect(router).toContain('context.notes.create(input.title)');

    const authorization = read(root, 'apps/api/src/authorization.ts');
    expect(authorization).toContain("import type { NoteRepository } from './notes/repository.ts';");
    expect(authorization).toContain('  tasks: TaskRepository;\n  notes: NoteRepository;');

    const app = read(root, 'apps/api/src/app.ts');
    expect(app).toContain("import type { NoteRepository } from './notes/repository.ts';");
    expect(app).toContain('  tasks: TaskRepository;\n  notes: NoteRepository;');
    expect(app).toContain('  notes,\n  tasks,\n  router = defaultRouter,');
    // Вставка сразу после открывающей строки buildContext: устойчиво к тому,
    // что в репозитории уже есть другие сгенерированные фичи.
    expect(app).toContain('const buildContext = (request: Request): AppContext => ({\n    notes,');

    const page = read(root, 'apps/web/src/features/notes/NotesPage.tsx');
    expect(page).toContain('export function NotesPage');
    expect(page).toContain('<h1>Notes</h1>');
    expect(page).toContain('aria-label="Notes"');
    expect(page).toContain("useHydrated } from '../../lib/use-hydrated.ts';");

    const hooks = read(root, 'apps/web/src/features/notes/use-notes.ts');
    expect(hooks).toContain('const listQuery = orpc.notes.list.queryOptions();');
    expect(hooks).toContain('export function useCreateNote()');

    const spec = read(root, 'e2e/features/notes/notes.spec.ts');
    expect(spec).toContain('created note appears in the list [AC-1]');

    const planMd = read(root, 'e2e/specs/notes.md');
    expect(planMd).toContain('- **AC-1**:');

    for (const path of [
      'packages/contracts/src/notes.test.ts',
      'apps/api/src/notes/repository.ts',
      'apps/api/src/notes/repository.test.ts',
      'apps/api/src/notes.test.ts',
      'apps/web/src/features/notes/NotesPage.test.tsx',
      'apps/web/src/features/notes/CreateNoteForm.tsx',
      'apps/web/src/features/notes/CreateNoteForm.test.tsx',
      'apps/web/src/features/notes/use-notes.test.tsx',
    ]) {
      expect(existsSync(join(root, path))).toBe(true);
    }

    const calls = readFileSync(pnpm.log, 'utf8');
    expect(calls).toContain('--filter @repo/contracts openapi');
    expect(calls).toContain('exec oxfmt packages/contracts/src/notes.ts');
  });

  it('derives hyphenated names: files in kebab, symbols in camel', () => {
    const root = fixture();
    const run = runGen(['feature', 'todo-lists'], root, stubbedPnpm().env);

    expect(run.status).toBe(0);
    const page = read(root, 'apps/web/src/features/todo-lists/TodoListsPage.tsx');
    expect(page).toContain('<h1>TodoLists</h1>');
    expect(page).toContain('export function TodoListsPage({ todoLists, onCreate }');
    expect(read(root, 'apps/web/src/features/todo-lists/use-todo-lists.ts')).toContain(
      'const listQuery = orpc.todoLists.list.queryOptions();',
    );
    expect(read(root, 'apps/api/src/authorization.ts')).toContain(
      '  todoLists: TodoListRepository;',
    );
    expect(read(root, 'apps/api/src/todo-lists/repository.test.ts')).toContain(
      'const todoList = await repository.create',
    );
    // kebab остаётся в путях и текстах, но не в идентификаторах кода
    expect(page).not.toMatch(/const todo-lists|todoLists: TodoList\b/);
  });

  it('generates a second feature next to the first one', () => {
    const root = fixture();
    expect(runGen(['feature', 'notes'], root, stubbedPnpm().env).status).toBe(0);

    const run = runGen(['feature', 'memos'], root, stubbedPnpm().env);

    expect(run.status).toBe(0);
    const index = read(root, 'packages/contracts/src/index.ts');
    expect(index).toContain('  notes: notesContract,');
    expect(index).toContain('  memos: memosContract,');
    expect(read(root, 'apps/api/src/router.ts')).toContain('  memos: {');
  });

  it('rejects a malformed name with a human message', () => {
    const run = runGen(['feature', 'Notes!'], fixture());

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('kebab-case');
  });

  it('refuses to overwrite an existing feature and writes nothing', () => {
    const root = fixture();
    const pnpm = stubbedPnpm();
    const existing = join(root, 'packages/contracts/src/notes.ts');
    mkdirSync(join(existing, '..'), { recursive: true });
    writeFileSync(existing, 'export const notesContract = {};\n');

    const run = runGen(['feature', 'notes'], root, pnpm.env);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('уже существует');
    expect(read(root, 'packages/contracts/src/notes.ts')).toBe(
      'export const notesContract = {};\n',
    );
    expect(existsSync(pnpm.log)).toBe(false);
  });

  it('fails loudly when a wiring anchor drifted, before any write', () => {
    const root = fixture();
    const pnpm = stubbedPnpm();
    const router = join(root, 'apps/api/src/router.ts');
    writeFileSync(
      router,
      readFileSync(router, 'utf8').replace('  },\n});', '  },\n  extra: {},\n});'),
    );

    const run = runGen(['feature', 'notes'], root, pnpm.env);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('встречается 0 раз');
    expect(existsSync(join(root, 'packages/contracts/src/notes.ts'))).toBe(false);
  });

  it('prints usage for an unknown command', () => {
    const run = runGen(['nonsense'], fixture());

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('pnpm gen feature');
  });
});

describe('generated e2e traces against the generated plan', () => {
  it('references exactly the AC ids the plan declares', () => {
    const root = fixture();
    expect(runGen(['feature', 'notes'], root, stubbedPnpm().env).status).toBe(0);

    const spec = read(root, 'e2e/features/notes/notes.spec.ts');
    const planMd = read(root, 'e2e/specs/notes.md');
    const specRefs = [...spec.matchAll(/\[(AC-\d+)\]/g)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]],
    );
    const planIds = [...planMd.matchAll(/^- \*\*(AC-\d+)\*\*:/gm)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]],
    );

    expect(planIds.length).toBeGreaterThan(0);
    expect([...new Set(planIds)].toSorted(byCode)).toEqual(planIds);
    expect([...new Set(specRefs)].toSorted(byCode)).toEqual(planIds);
  });
});
