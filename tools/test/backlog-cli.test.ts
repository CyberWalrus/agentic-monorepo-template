/**
 * Проводка close/doctor (ADR 0007, «Замыкание задачи») на настоящем git-репозитории:
 * временный клон с доской, реальные команды `node tools/backlog.ts …` и реальный
 * `node tools/check-docs.ts`. Логика doctorFindings канареечна отдельно
 * (backlog-board.test.ts); здесь проверяется, что команды зовут git, читают
 * доску из ссылки main и уважают запрет чужого файла на ветке задачи.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const backlogCli = resolve(import.meta.dirname, '../backlog.ts');
const checkDocs = resolve(import.meta.dirname, '../check-docs.ts');

let repo = '';

const taskFile = (id: string): string =>
  `---\ntitle: ${id}\ntype: change\npriority: low\ndepends_on:\ntouches:\nneeds_human:\n---\n# ${id}\n\n## Журнал\n`;

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(script: string, args: string[], env: NodeJS.ProcessEnv = {}): RunResult {
  const result = spawnSync('node', [script, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function git(args: string[], env: NodeJS.ProcessEnv = {}): RunResult {
  const result = spawnSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function commitAll(message: string, env: NodeJS.ProcessEnv = {}): void {
  git(['add', '-A']);
  assertOk(git(['commit', '-m', message], env), `git commit ${message}`);
}

/** В setup вне тестов expect запрещён линтом: неудача — бросок с выводом (З11). */
function assertOk(result: RunResult, what: string): void {
  if (result.status !== 0) {
    throw new Error(`${what} failed:\n${result.stderr || result.stdout}`);
  }
}

beforeAll(() => {
  repo = join(mkdtempSync(join(tmpdir(), 'backlog-cli-')), 'clone');
  mkdirSync(repo, { recursive: true });
  assertOk(git(['init', '-b', 'main']), 'git init');
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'test']);
  for (const id of ['a', 'b', 'c', 'd']) {
    mkdirSync(join(repo, 'backlog'), { recursive: true });
    writeFileSync(join(repo, 'backlog', `${id}.md`), taskFile(id));
  }
  git(['add', '-A']);
  assertOk(git(['commit', '-m', 'init: доска a–d']), 'git commit');
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('pnpm backlog close', () => {
  it('переносит файл своей задачи в done/', () => {
    const result = run(backlogCli, ['close', 'a']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(existsSync(join(repo, 'backlog', 'a.md'))).toBe(false);
    expect(existsSync(join(repo, 'backlog', 'done', 'a.md'))).toBe(true);
  });

  it('неизвестный id — отказ с объяснением', () => {
    const result = run(backlogCli, ['close', 'zz']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('нет на доске');
  });

  it('на чужой ветке задачи закрывать другую задачу нельзя', () => {
    expect(git(['switch', '-c', 'task/b']).status).toBe(0);
    const result = run(backlogCli, ['close', 'c']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('закрывается только своя');
    expect(existsSync(join(repo, 'backlog', 'c.md'))).toBe(true);
  });
});

describe('pnpm backlog doctor', () => {
  // Spawn-тяжёлый (десяток node/git-процессов): явный таймаут вместо дефолтных
  // 5 с — на холодном CI-раннере не влезает (урок A3, 2026-11-13).
  it('смерженная открытая задача и закрытая с веткой — красные, брошенный захват — предупреждение', () => {
    // task/b указывает на tip main — git-предок: fallback классифицирует её как
    // смерженную (gh в фикстуре недоступен, проверяется путь fallback).
    expect(git(['switch', 'main']).status).toBe(0);
    // task/c создана до закрытия c; закрытие уходит в main → c ancestor + done → leftover-branch.
    expect(git(['branch', 'task/c']).status).toBe(0);
    expect(run(backlogCli, ['close', 'c']).status).toBe(0);
    commitAll('close c');
    // Брошенный захват: коммит task/d старше порога.
    expect(git(['switch', '-c', 'task/d']).status).toBe(0);
    writeFileSync(join(repo, 'idle.txt'), 'x');
    commitAll('старый коммит задачи d', {
      GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
    });
    const result = run(backlogCli, ['doctor']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('смержена в main'); // unclosed b
    expect(result.stderr).toContain('ветка task/c осталась'); // leftover-branch c
    expect(result.stderr).toContain('предупреждение: задача d'); // idle-claim d
  }, 30_000);
});

describe('гейт замыкания (tools/check-docs.ts)', () => {
  it('файл задачи открыт на ветке task/<id> — красный', () => {
    // В репозитории сейчас task/d, backlog/d.md открыт (тест doctor выше).
    // Локальная ветка авторитетнее протёкшего GITHUB_HEAD_REF (CI).
    expect(git(['branch', '--show-current']).stdout).toContain('task/d');
    const result = run(checkDocs, [], { GITHUB_HEAD_REF: 'feat/leaked-pr-branch' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('перенеси');
    expect(result.stderr).toContain('backlog/done/');
  });

  it('detached HEAD (checkout PR в CI) — ветка берётся из GITHUB_HEAD_REF', () => {
    expect(git(['switch', '--detach']).status).toBe(0);
    const result = run(checkDocs, [], { GITHUB_HEAD_REF: 'task/d' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('перенеси');
    expect(git(['switch', 'task/d']).status).toBe(0);
  });

  it('файл перенесён в backlog/done/ — docs зелёный (happy path)', () => {
    mkdirSync(join(repo, 'backlog', 'done'), { recursive: true });
    expect(git(['mv', 'backlog/d.md', 'backlog/done/d.md']).status).toBe(0);
    const result = run(checkDocs, []);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('перенеси');
  });
});
