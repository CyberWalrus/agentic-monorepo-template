/**
 * Канарейка и тесты гейта check-branch-scope (D7, З2): логика — юниты
 * fileInTouches и интеграционные прогоны чекера на временном изолированном
 * клоне (refs не общие с рабочим репозиторием); проводка — три парити-ассерта
 * по образцу check-tool-class (verify-steps, package.json, ci.yml, бюджет).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileInTouches } from '../backlog-board.ts';

const checker = resolve(import.meta.dirname, '../check-branch-scope.ts');
const repoRoot = resolve(import.meta.dirname, '..', '..');

let repo = '';
let tmp = '';

const taskFile = (id: string, touches: string): string =>
  `---\ntitle: ${id}\ntype: change\npriority: low\ndepends_on:\ntouches: ${touches}\nneeds_human:\n---\n# ${id}\n\n## Журнал\n`;

const scriptsOf = (json: string): Record<string, string> => {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null || !('scripts' in parsed)) {
    throw new Error('package.json: нет scripts');
  }
  const scripts: unknown = parsed['scripts'];
  if (typeof scripts !== 'object' || scripts === null) {
    throw new Error('package.json: scripts не объект');
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(scripts)) {
    if (typeof value !== 'string') {
      throw new Error(`package.json: scripts.${key} не строка`);
    }
    result[key] = value;
  }
  return result;
};

const fastBudgetOf = (json: string): Record<string, number> => {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null || !('fast' in parsed)) {
    throw new Error('verify-budgets.json: нет fast');
  }
  const fast: unknown = parsed['fast'];
  if (typeof fast !== 'object' || fast === null) {
    throw new Error('verify-budgets.json: fast не объект');
  }
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(fast)) {
    if (typeof value !== 'number') {
      throw new Error(`verify-budgets.json: fast.${key} не число`);
    }
    result[key] = value;
  }
  return result;
};

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runIn(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): RunResult {
  // GITHUB_HEAD_REF/GITHUB_BASE_REF стираются (ревью d7): в CI они заданы для
  // PR раннера и протекли бы в чекер во временном клоне — чекер читал бы ветку
  // task/d7 вместо ветки клона (task/x, task/ghost…). Истина — ветка клона;
  // явные env-кейсы («detached HEAD») задают переменные намеренно через env.
  const { GITHUB_HEAD_REF: _head, GITHUB_BASE_REF: _base, ...inherited } = process.env;
  const result = spawnSync('node', [checker, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...inherited, ...env },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function run(args: string[], env: NodeJS.ProcessEnv = {}): RunResult {
  return runIn(repo, args, env);
}

function git(args: string[]): RunResult {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function assertOk(result: RunResult, what: string): void {
  if (result.status !== 0) {
    throw new Error(`${what} failed:\n${result.stderr || result.stdout}`);
  }
}

function commitAll(message: string): void {
  git(['add', '-A']);
  assertOk(git(['commit', '-m', message]), `git commit ${message}`);
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'branch-scope-'));
  repo = join(tmp, 'clone');
  mkdirSync(join(repo, 'backlog', 'done'), { recursive: true });
  mkdirSync(join(repo, 'solo'), { recursive: true });
  assertOk(git(['init', '-b', 'main']), 'git init');
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'test']);
  // x — открытая задача с touches solo/**, bare-dir solo и файлом у root;
  // d — закрытая (для leftover fail-closed); s — с литеральным путём.
  writeFileSync(join(repo, 'backlog', 'x.md'), taskFile('x', 'solo/**, solo, README.md'));
  writeFileSync(join(repo, 'backlog', 's.md'), taskFile('s', 'tools/backlog.ts'));
  writeFileSync(join(repo, 'backlog', 'done', 'd.md'), taskFile('d', 'gone/**'));
  writeFileSync(join(repo, 'solo', 'base.ts'), 'export const base = 1;\n');
  commitAll('init: доска x, s, закрытая d');
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('fileInTouches (матчинг «файл ⊆ touches»)', () => {
  it('литеральный путь — точное равенство, дочерний — только через каталог/**', () => {
    expect(fileInTouches('tools/backlog.ts', ['tools/backlog.ts'])).toBe(true);
    expect(fileInTouches('tools/backlog-board.ts', ['tools/backlog.ts'])).toBe(false);
    expect(fileInTouches('solo/a.ts', ['solo'])).toBe(false); // bare-dir: только точный путь
    expect(fileInTouches('solo', ['solo'])).toBe(true);
    expect(fileInTouches('solo/a.ts', ['solo/**'])).toBe(true);
    expect(fileInTouches('sololess/a.ts', ['solo/**'])).toBe(false);
  });
});

describe('check-branch-scope: интеграция на временном клоне', () => {
  it('дифф внутри touches — зелёный', () => {
    assertOk(git(['switch', '-c', 'task/x']), 'branch task/x');
    writeFileSync(join(repo, 'solo', 'inner.ts'), 'export const inner = 1;\n');
    commitAll('x: файл внутри touches');
    const result = run([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('внутри touches — ok');
  });

  it('собственный файл задачи (перенос в done/ и журнал) — всегда разрешён', () => {
    assertOk(git(['mv', 'backlog/x.md', 'backlog/done/x.md']), 'close x');
    writeFileSync(
      join(repo, 'backlog', 'done', 'x.md'),
      taskFile('x', 'solo/**, solo, README.md').replace('## Журнал\n', '## Журнал\n\n- итог\n'),
    );
    commitAll('x: перенос в done и журнал');
    const result = run([]);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('вне touches');
  });

  it('незакоммиченный файл вне touches — красный (рабочее дерево)', () => {
    mkdirSync(join(repo, 'other'), { recursive: true });
    writeFileSync(join(repo, 'other', 'evil.ts'), 'export const evil = 1;\n');
    const result = run([]);
    // Чистка до expect: упавший expect не должен оставить untracked в дереве —
    // он утечёт в коммиты следующих тестов (наблюдение первого прогона).
    rmSync(join(repo, 'other'), { recursive: true, force: true });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('other/evil.ts');
    expect(result.stderr).toContain('вне touches задачи');
  });

  it('bare-каталог в touches покрывает только точный путь', () => {
    mkdirSync(join(repo, 'solo', 'sub'), { recursive: true });
    writeFileSync(join(repo, 'solo', 'sub', 'deep.ts'), 'export const deep = 1;\n');
    // solo/sub/deep.ts внутри solo/** — зелёный (bare-dir тест — fileInTouches выше).
    commitAll('x: файл в подкаталоге solo');
    const result = run([]);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('вне touches задачи');
  });

  it('ветка вне task/* — зелёный skip', () => {
    assertOk(git(['switch', '-c', 'feat/off-board']), 'branch feat/off-board');
    const result = run([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('проверка пропущена');
    assertOk(git(['switch', 'task/x']), 'back to task/x');
  });

  it('проект без доски (копия шаблона) — зелёный skip даже для task/*', () => {
    const plain = join(tmp, 'plain-project');
    mkdirSync(plain, { recursive: true });
    const plainGit = (args: string[]): RunResult => {
      const result = spawnSync('git', args, { cwd: plain, encoding: 'utf8' });
      return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    };
    assertOk(plainGit(['init', '-b', 'main']), 'git init plain');
    plainGit(['config', 'user.email', 'test@example.com']);
    plainGit(['config', 'user.name', 'test']);
    writeFileSync(join(plain, 'app.ts'), 'export const app = 1;\n');
    plainGit(['add', '-A']);
    assertOk(plainGit(['commit', '-m', 'init: копия шаблона без backlog/']), 'commit plain');
    assertOk(plainGit(['switch', '-c', 'task/x']), 'branch task/x в копии');
    const result = runIn(plain, []);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('проект из шаблона без доски');
  });

  it('fail-closed: файла задачи нет на main — красный', () => {
    assertOk(git(['switch', '-c', 'task/ghost']), 'branch task/ghost');
    const result = run([]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('файла задачи ghost нет на базе');
    assertOk(git(['switch', 'task/x']), 'back to task/x');
    assertOk(git(['branch', '-D', 'task/ghost']), 'cleanup ghost');
  });

  it('fail-closed: task/<done-id> (закрытая задача) — красный', () => {
    assertOk(git(['switch', '-c', 'task/d']), 'branch task/d');
    const result = run([]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('закрыта в main');
    expect(result.stderr).toContain('backlog release d');
    assertOk(git(['switch', 'task/x']), 'back to task/x');
    assertOk(git(['branch', '-D', 'task/d']), 'cleanup task/d');
  });

  it('detached HEAD: ветка берётся из GITHUB_HEAD_REF (прецедент check-docs)', () => {
    assertOk(git(['switch', '--detach']), 'detach');
    const result = run([], { GITHUB_HEAD_REF: 'task/x' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('внутри touches — ok');
    const leak = run([], { GITHUB_HEAD_REF: 'task/ghost' });
    expect(leak.status).not.toBe(0);
    expect(leak.stderr).toContain('файла задачи ghost нет на базе');
    assertOk(git(['switch', 'task/x']), 'back to task/x');
  });

  it('CI-сценарий: локальной main нет (checkout PR) — доска читается из origin/main', () => {
    // Клон-симуляция job static (actions/checkout fetch-depth: 0): локальной
    // refs/heads/main нет, только origin/* (ревью d7: литеральный
    // `git show main:` ложнокраснил «файла задачи нет» при живом origin/main).
    const ci = join(tmp, 'ci-clone');
    // --branch main: HEAD источника — task/x, клон без явной ветки унёс бы её
    // локальной; симуляция CI требует локальной main, которую затем удаляем.
    const clone = spawnSync('git', ['clone', '--quiet', '--branch', 'main', repo, ci], {
      encoding: 'utf8',
    });
    if (clone.status !== 0) {
      throw new Error(`git clone failed:\n${clone.stderr}`);
    }
    const cgit = (args: string[]): RunResult => {
      const result = spawnSync('git', args, { cwd: ci, encoding: 'utf8' });
      return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    };
    assertOk(cgit(['config', 'user.email', 'test@example.com']), 'config email');
    assertOk(cgit(['config', 'user.name', 'test']), 'config name');
    assertOk(cgit(['switch', '--detach']), 'detach');
    assertOk(cgit(['branch', '-D', 'main']), 'drop local main');
    expect(cgit(['rev-parse', '--verify', 'main']).status).not.toBe(0);
    // Чекер с веткой из GITHUB_HEAD_REF на detached merge-ref: файл задачи
    // найден через origin/main, touches непусты, дифф чист — зелёный.
    const green = runIn(ci, [], { GITHUB_HEAD_REF: 'task/x' });
    expect(green.status).toBe(0);
    expect(green.stdout).toContain('внутри touches — ok');
    // Красный кейс там же: посторонний файл в диффе, touches видны.
    mkdirSync(join(ci, 'other'), { recursive: true });
    writeFileSync(join(ci, 'other', 'evil.ts'), 'export const evil = 1;\n');
    const red = runIn(ci, [], { GITHUB_HEAD_REF: 'task/x' });
    rmSync(join(ci, 'other'), { recursive: true, force: true });
    expect(red.status).not.toBe(0);
    expect(red.stderr).toContain('other/evil.ts');
    expect(red.stderr).toContain('solo/**'); // touches прочитаны, не «пусто»
    rmSync(ci, { recursive: true, force: true });
  });

  it('touches читаются из main, не из ветки: правка touches в ветке не расширяет права (З2)', () => {
    // Задача s с touches tools/backlog.ts; в ВЕТКЕ расширим touches до solo/**,
    // а в main останутся старые — гейт обязан использовать main.
    writeFileSync(join(repo, 'backlog', 's.md'), taskFile('s', 'solo/**'));
    commitAll('s: расширили себе touches в ветке');
    assertOk(git(['switch', '-c', 'task/s']), 'branch task/s');
    writeFileSync(join(repo, 'solo', 'sneaky.ts'), 'export const sneaky = 1;\n');
    commitAll('s: файл по веточным touches, не по main');
    const result = run([]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('solo/sneaky.ts');
    assertOk(git(['switch', 'task/x']), 'back to task/x');
  });
});

describe('проводка: шаг branch-scope в verify', () => {
  it('verify-steps содержит шаг branch-scope в fast-волне', () => {
    const source = readFileSync(join(repoRoot, 'tools', 'verify-steps.ts'), 'utf8');
    expect(source).toMatch(/name:\s*'branch-scope'/);
    expect(source).toMatch(/'branch-scope:check'/);
  });

  it('package.json: скрипт branch-scope:check → node tools/check-branch-scope.ts', () => {
    const scripts = scriptsOf(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    expect(scripts['branch-scope:check']).toBe('node tools/check-branch-scope.ts');
    expect(existsSync(join(repoRoot, 'tools/check-branch-scope.ts'))).toBe(true);
  });

  it('ci.yml: job static гоняет branch-scope:check', () => {
    const ci = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ci).toMatch(/pnpm branch-scope:check/);
  });

  it('verify-budgets.json: бюджет branch-scope в fast (З6)', () => {
    const fast = fastBudgetOf(readFileSync(join(repoRoot, 'verify-budgets.json'), 'utf8'));
    expect(typeof fast['branch-scope']).toBe('number');
  });
});
