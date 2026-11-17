/**
 * Контур оператора (ADR 0009) на настоящем git-репозитории: временный клон,
 * реальные команды `node tools/backlog.ts next/start --operator`,
 * `doctor` и `node tools/check-docs.ts`. Изолирован от backlog-cli.test.ts:
 * свой временный репозиторий с задачами оператора, чтобы состояние doctor
 * (ветки, merge, файлы режима) не мешало чужим сценариям. Логика
 * needsHumanKind/doctorFindings канареечна на уровне модуля
 * (backlog-board.test.ts), правило needs_human гейта docs — здесь проводкой.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const backlogCli = resolve(import.meta.dirname, '../backlog.ts');
const checkDocs = resolve(import.meta.dirname, '../check-docs.ts');

let tmpBase = '';
let repo = '';

const taskFile = (id: string, extra: Record<string, string> = {}): string => {
  const fields: Record<string, string> = { priority: 'low', depends_on: '', ...extra };
  const lines = Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
  return `---\ntitle: ${id}\ntype: change\n${lines}\n---\n# ${id}\n\n## Журнал\n`;
};

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(script: string, args: string[]): RunResult {
  const result = spawnSync('node', [script, ...args], { cwd: repo, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Два одновременных запуска: гонка за атомарное создание ветки. */
function runPair(script: string, args: string[]): Promise<RunResult[]> {
  const children = [0, 1].map(() => spawn('node', [script, ...args], { cwd: repo }));
  return Promise.all(
    children.map(
      (child) =>
        new Promise<RunResult>((resolvePromise) => {
          let out = '';
          let err = '';
          child.stdout.on('data', (chunk: Buffer) => {
            out += chunk.toString();
          });
          child.stderr.on('data', (chunk: Buffer) => {
            err += chunk.toString();
          });
          child.on('close', (code) => resolvePromise({ status: code, stdout: out, stderr: err }));
        }),
    ),
  );
}

function git(args: string[], env: NodeJS.ProcessEnv = {}, cwd: string = repo): RunResult {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** В setup вне тестов expect запрещён линтом: неудача — бросок с выводом (З11). */
function assertOk(result: RunResult, what: string): void {
  if (result.status !== 0) {
    throw new Error(`${what} failed:\n${result.stderr || result.stdout}`);
  }
}

beforeAll(() => {
  tmpBase = mkdtempSync(join(tmpdir(), 'backlog-operator-'));
  repo = join(tmpBase, 'clone');
  mkdirSync(repo, { recursive: true });
  assertOk(git(['init', '-b', 'main']), 'git init');
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'test']);
  mkdirSync(join(repo, 'backlog'), { recursive: true });
  writeFileSync(
    join(repo, 'backlog', 'e.md'),
    taskFile('e', { priority: 'high', touches: 'tools/**' }),
  );
  writeFileSync(
    join(repo, 'backlog', 'm2.md'),
    taskFile('m2', { priority: 'high', touches: '.github/**' }),
  );
  writeFileSync(
    join(repo, 'backlog', 'o1.md'),
    taskFile('o1', { priority: 'medium', needs_human: 'оператор: настроить запись Claude Code' }),
  );
  writeFileSync(
    join(repo, 'backlog', 'o2.md'),
    taskFile('o2', { needs_human: 'отложено: появится второй тег' }),
  );
  writeFileSync(join(repo, 'backlog', 'dep.md'), taskFile('dep', { depends_on: 'e' }));
  writeFileSync(join(repo, 'backlog', 'plain.md'), taskFile('plain', {}));
  git(['add', '-A']);
  assertOk(git(['commit', '-m', 'init: задачи оператора']), 'git commit');
});

afterAll(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

describe('pnpm backlog list: статусы needs_human', () => {
  it('оператор:/отложено:/человек: — отдельные статусы вместо «заблокирована»', () => {
    const result = run(backlogCli, ['list']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('нужен оператор');
    expect(result.stdout).toContain('отложено');
    expect(result.stdout).toContain('нужно решение: отложено: появится второй тег');
    expect(result.stdout).toContain('ждёт: e');
  });
});

describe('pnpm backlog next --operator', () => {
  it('выдаёт задачу оператора: приоритет, затем число открываемых', () => {
    // e и m2 одного приоритета, от e зависит dep: порядок открывает e.
    const result = run(backlogCli, ['next', '--operator']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('задача оператора: e');
    expect(result.stdout).toContain('открывает задач: 1');
    expect(result.stdout).toContain('start e --operator');
  });

  it('обычный next задачи оператора не выдаёт и указывает на --operator', () => {
    const result = run(backlogCli, ['next']);
    expect(result.stdout).toContain('Следующая свободная задача: plain');
    expect(result.stderr).toContain('ведёт оператор');
    expect(result.stderr).toContain('next --operator');
  });

  it('ведущаяся задача оператора без открытого PR занимает слот (ADR 0009)', () => {
    assertOk(git(['branch', 'task/e']), 'branch task/e');
    const result = run(backlogCli, ['next', '--operator']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('уже ведётся задача оператора');
    expect(git(['branch', '-D', 'task/e']).status).toBe(0);
  }, 30_000);
});

describe('pnpm backlog start --operator', () => {
  it('start задачи режима обслуживания без флага — отказ с подсказкой', () => {
    const result = run(backlogCli, ['start', 'e']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('задача оператора');
    expect(result.stderr).toContain('--operator');
    expect(existsSync(join(tmpBase, 'clone-task-e'))).toBe(false);
  });

  it('start e --operator — захват веткой и worktree (ADR 0009, «Захват»)', () => {
    const result = run(backlogCli, ['start', 'e', '--operator']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Захвачено: task/e');
    expect(git(['rev-parse', '--verify', 'task/e']).status).toBe(0);
    expect(existsSync(join(tmpBase, 'clone-task-e'))).toBe(true);
  }, 30_000);

  it('отложенная задача не захватывается даже оператором', () => {
    const result = run(backlogCli, ['start', 'o2', '--operator']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('отложено');
  });

  it('задача с незакрытыми зависимостями не захватывается даже оператором', () => {
    const result = run(backlogCli, ['start', 'dep', '--operator']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ждёт e');
  });

  it('из двух одновременных start --operator проходит один (атомарный захват)', async () => {
    const results = await runPair(backlogCli, ['start', 'o1', '--operator']);
    const ok = results.filter((result) => result.status === 0);
    const failed = results.filter((result) => result.status !== 0);
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.stderr).toContain('занята');
    expect(git(['rev-parse', '--verify', 'task/o1']).status).toBe(0);
  }, 30_000);
});

// Пути ленивые (функции на уровне модуля): repo/tmpBase заполняются в beforeAll,
// describe-константы вычисляются раньше и превращаются в относительные.
const mainSettings = (): string => join(repo, '.claude', 'settings.local.json');
const worktreeDir = (): string => join(tmpBase, 'clone-task-e');
const worktreeSettings = (): string => join(worktreeDir(), '.claude', 'settings.local.json');

describe('pnpm backlog doctor: файлы режима обслуживания', () => {
  it('в основном checkout — блокирующее расхождение безусловно', () => {
    mkdirSync(dirname(mainSettings()), { recursive: true });
    writeFileSync(mainSettings(), '{"disableAllHooks": true}');
    const result = run(backlogCli, ['doctor']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('основном checkout');
  }, 30_000);

  it('активное окно в worktree задачи (без PR, ветка свежая) — только предупреждение', () => {
    rmSync(mainSettings(), { force: true });
    mkdirSync(dirname(worktreeSettings()), { recursive: true });
    writeFileSync(worktreeSettings(), '{"disableAllHooks": true}');
    const result = run(backlogCli, ['doctor']);
    expect(result.stderr).toContain('активное окно');
    expect(result.stderr).toContain('worktree задачи e');
    // Exit-код здесь 0 не бывает: ветки захватов указывают на tip main, и
    // git-fallback doctor видит их как смерженные (unclosed) — это чужой
    // сценарий backlog-cli.test.ts. Блокирующую семантику режим-файлов пинят
    // юнит-тесты doctorFindings (backlog-board.test.ts).
  }, 30_000);

  it('простой ветки дольше порога при включённом режиме — блокирующее', () => {
    // Старый коммит на task/e в его worktree: возраст ветки превышает порог.
    writeFileSync(join(worktreeDir(), 'idle.txt'), 'x');
    assertOk(git(['add', 'idle.txt'], {}, worktreeDir()), 'add idle.txt');
    assertOk(
      git(
        ['commit', '-m', 'старый коммит'],
        { GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z' },
        worktreeDir(),
      ),
      'old commit',
    );
    const result = run(backlogCli, ['doctor']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('worktree задачи e');
    expect(result.stderr).toContain('последнем коммите');
  }, 30_000);

  it('файлы убраны — doctor молчит о режиме обслуживания', () => {
    rmSync(mainSettings(), { force: true });
    rmSync(worktreeSettings(), { force: true });
    const result = run(backlogCli, ['doctor']);
    expect(result.stderr).not.toContain('режима обслуживания');
  }, 30_000);
});

describe('гейт needs_human (tools/check-docs.ts)', () => {
  it('без префикса и «оператор:» с действием приёмки — красный; допустимые — зелёный', () => {
    git(['switch', 'main']);
    writeFileSync(
      join(repo, 'backlog', 'evil-nh.md'),
      taskFile('evil-nh', { needs_human: 'выбери вариант сам и продолжай' }),
    );
    writeFileSync(
      join(repo, 'backlog', 'evil-nh2.md'),
      taskFile('evil-nh2', { needs_human: 'оператор: поставить label gate-change-approved' }),
    );
    const bad = run(checkDocs, []);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain('evil-nh.md: needs_human');
    expect(bad.stderr).toContain('не делегируется');
    writeFileSync(
      join(repo, 'backlog', 'evil-nh.md'),
      taskFile('evil-nh', { needs_human: 'человек: поставить защищённый тег' }),
    );
    rmSync(join(repo, 'backlog', 'evil-nh2.md'), { force: true });
    const good = run(checkDocs, []);
    expect(good.status).toBe(0);
    expect(good.stderr).not.toContain('needs_human');
  }, 30_000);

  it('архив (backlog/done/) правилу префиксов не подчиняется', () => {
    mkdirSync(join(repo, 'backlog', 'done'), { recursive: true });
    writeFileSync(
      join(repo, 'backlog', 'done', 'old1.md'),
      taskFile('old1', { needs_human: 'утвердить дизайн из старой декомпозиции' }),
    );
    const result = run(checkDocs, []);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('old1');
    rmSync(join(repo, 'backlog', 'done', 'old1.md'), { force: true });
  }, 30_000);
});
