/**
 * D7 «запрет при пересечении» (ADR 0007) — канарейка части 1 на настоящем git.
 * Временный изолированный клон (refs не общие с рабочим репозиторием), реальные
 * `node tools/backlog.ts start/next`. Проверка пересечения живёт в commandStart
 * ПОД замком — после атомарного создания ветки, поэтому «второй start
 * пересекающейся задачи получает отказ» проверяется целиком: отказ, откат
 * ветки (клейма нет), успех непересекающейся задачи (собственный id исключён
 * из свежих claimedIds — иначе каждый start самоотказался бы). Отключение
 * проверки или исключения себя делает этот тест красным без его правки.
 * Математика пересечения канареечна отдельно (backlog-board.test.ts,
 * touchesOverlap), сообщение next отличимо от «свободных задач нет».
 * Отказ действует одинаково для обычного и --operator захвата: путь commandStart
 * общий (граница «одна операторская задача за раз» commandNextOperator не
 * проверяет пересечения — осознанное решение, журнал d7).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const backlogCli = resolve(import.meta.dirname, '../backlog.ts');

let repo = '';
let tmp = '';

const taskFile = (id: string, touches: string): string =>
  `---\ntitle: ${id}\ntype: change\npriority: low\ndepends_on:\ntouches: ${touches}\nneeds_human:\n---\n# ${id}\n\n## Журнал\n`;

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(script: string, args: string[]): RunResult {
  const result = spawnSync('node', [script, ...args], {
    cwd: repo,
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function git(args: string[]): RunResult {
  const result = spawnSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function assertOk(result: RunResult, what: string): void {
  if (result.status !== 0) {
    throw new Error(`${what} failed:\n${result.stderr || result.stdout}`);
  }
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'backlog-lock-'));
  repo = join(tmp, 'clone');
  mkdirSync(join(repo, 'backlog', 'done'), { recursive: true });
  assertOk(git(['init', '-b', 'main']), 'git init');
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'test']);
  // a и b пересекаются по touches, c — нет; d закрыта (done/), её touches
  // совпадают с b — leftover-ветка закрытой задачи не считается «в работе».
  writeFileSync(join(repo, 'backlog', 'a.md'), taskFile('a', 'shared/mod.ts'));
  writeFileSync(join(repo, 'backlog', 'b.md'), taskFile('b', 'shared/mod.ts'));
  writeFileSync(join(repo, 'backlog', 'c.md'), taskFile('c', 'solo/mod.ts'));
  writeFileSync(join(repo, 'backlog', 'done', 'd.md'), taskFile('d', 'shared/mod.ts'));
  git(['add', '-A']);
  assertOk(git(['commit', '-m', 'init: доска a–c, d закрыта']), 'git commit');
  assertOk(git(['branch', 'task/a']), 'git branch task/a'); // чужой захват
  assertOk(git(['branch', 'task/d']), 'git branch task/d'); // leftover
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('D7: start под замком (канарейка части 1)', () => {
  it('второй start пересекающейся задачи получает отказ, ветка-проба откачена', () => {
    const result = run(backlogCli, ['start', 'b']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('пересекается по touches с задачами в работе (D7): a');
    expect(result.stderr).toContain('Ветка task/b откачена');
    // Клейма нет: откат ветки обязателен, иначе задача b блокируется всему клону.
    expect(git(['rev-parse', '--verify', 'task/b']).status).not.toBe(0);
  });

  it('next выдаёт только непересекающиеся, пересекающиеся — отказом захвата, не выдачей', () => {
    const result = run(backlogCli, ['next']);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('не выдаются (D7): b');
    expect(result.stdout).toContain('Следующая свободная задача: c');
  });

  it('непересекающаяся задача захватывается: собственный id исключён из свежих claimedIds', () => {
    const result = run(backlogCli, ['start', 'c']);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(git(['rev-parse', '--verify', 'task/c']).status).toBe(0);
  });

  it('закрытая задача с leftover-веткой «в работе» не считается', () => {
    assertOk(git(['branch', '-D', 'task/a']), 'release a'); // a больше не в работе
    const result = run(backlogCli, ['start', 'b']);
    expect(result.status).toBe(0);
    // b пересекается с d, но d закрыта в main — её leftover-ветку ловит doctor
    // (backlog-board.ts), а fresh-проверка захвата «в работе» её не считает.
    expect(result.stderr).toBe('');
    expect(git(['rev-parse', '--verify', 'task/b']).status).toBe(0);
    // start b создал worktree рядом с клоном (worktreePath): снимаем до -D.
    assertOk(git(['worktree', 'remove', '--force', `${repo}-task-b`]), 'worktree remove');
    assertOk(git(['branch', '-D', 'task/b']), 'release b');
  });
});

describe('D7: next отличает «все пересекаются» от «свободных нет»', () => {
  it('все свободные пересекаются — отказ с перечнем, не «свободных задач нет»', () => {
    assertOk(git(['branch', 'task/a']), 'claim a'); // a снова в работе
    const result = run(backlogCli, ['next']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('их touches пересекаются с задачами в работе (D7): b');
    expect(result.stderr).not.toContain('Свободных задач нет');
    expect(result.stderr).toContain('Работа вне доски');
  });
});
