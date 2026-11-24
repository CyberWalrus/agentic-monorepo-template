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

/** Захваченная задача = ветка task/<id>: claimedIds читает refs, worktree не нужен. */
function claimBranches(ids: string[]): void {
  for (const id of ids) {
    assertOk(git(['branch', `task/${id}`]), `branch task/${id}`);
  }
}

function releaseBranches(ids: string[]): void {
  for (const id of ids) {
    assertOk(git(['branch', '-D', `task/${id}`]), `delete task/${id}`);
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
    taskFile('e', { priority: 'high', touches: 'tools/verify.ts' }),
  );
  writeFileSync(
    join(repo, 'backlog', 'm2.md'),
    taskFile('m2', { priority: 'high', touches: '.github/**' }),
  );
  writeFileSync(
    join(repo, 'backlog', 'e9.md'),
    taskFile('e9', { priority: 'high', touches: 'tools/verify.ts' }),
  );
  writeFileSync(join(repo, 'backlog', 'c9.md'), taskFile('c9', { touches: 'docs/CODEOWNERS' }));
  writeFileSync(join(repo, 'backlog', 'reg.md'), taskFile('reg', { touches: 'docs/**' }));
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
  writeFileSync(
    join(repo, 'backlog', 'bad.md'),
    taskFile('bad', { needs_human: 'выбери вариант сам и продолжай' }),
  );
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
    expect(result.stdout).toContain('— отложено: появится второй тег');
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

  it('ведущаяся задача оператора перечислена с touches; пересекающаяся не выдаётся, непересекающаяся — выдаётся (D7)', () => {
    // e ведётся: e9 пересекается с ней по tools/verify.ts, m2 — нет.
    claimBranches(['e']);
    const result = run(backlogCli, ['next', '--operator']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('задача оператора: m2');
    expect(result.stdout).not.toContain('start e9');
    expect(result.stderr).toContain('Ведутся задачи оператора');
    expect(result.stderr).toContain('task/e [tools/verify.ts]');
    expect(result.stderr).toContain('e9');
    releaseBranches(['e']);
  }, 60_000);

  it('несколько ведущихся — выдаётся кандидат без пересечения с каждой, и start его принимает (ADR 0009, «Очерёдность»)', () => {
    claimBranches(['e', 'm2']);
    const result = run(backlogCli, ['next', '--operator']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('задача оператора: o1');
    expect(result.stderr).toContain('task/e [tools/verify.ts]');
    expect(result.stderr).toContain('task/m2 [.github/**]');
    expect(result.stderr).not.toContain('Одна операторская');
    // Выданное не отвергается захватом под замком: выдача и D7 считают пересечение одинаково.
    const start = run(backlogCli, ['start', 'o1', '--operator']);
    expect(start.status).toBe(0);
    expect(start.stderr).not.toContain('пересекается');
    assertOk(git(['worktree', 'remove', '--force', join(tmpBase, 'clone-task-o1')]), 'remove o1');
    releaseBranches(['o1', 'm2', 'e']);
  }, 60_000);

  it('все свободные задачи оператора пересекаются с ведущимися — отказ с перечнем, с чем именно (D7)', () => {
    // Ведутся e, m2, o1 (оператор) и reg (обычная): свободны только e9 и c9, оба пересекаются.
    claimBranches(['e', 'm2', 'o1', 'reg']);
    const result = run(backlogCli, ['next', '--operator']);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('все пересекаются по touches с задачами в работе (D7)');
    expect(result.stderr).toContain('e9 — с task/e');
    expect(result.stderr).toContain('c9 — с task/reg');
    expect(result.stderr).not.toContain('Одна операторская');
    releaseBranches(['e', 'm2', 'o1', 'reg']);
  }, 60_000);

  it('кандидат оператора, пересекающийся с задачей обычной сессии, не выдаётся — start отклонил бы его (D7)', () => {
    // reg ведётся обычной сессией: c9 (docs/CODEOWNERS) пересекается с ней по docs/**.
    claimBranches(['reg']);
    const result = run(backlogCli, ['next', '--operator']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('задача оператора: e');
    expect(result.stdout).not.toContain('start c9');
    expect(result.stderr).toContain('c9 — с task/reg');
    expect(result.stderr).not.toContain('Ведутся задачи оператора');
    releaseBranches(['reg']);
  }, 60_000);
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

  it('невалидный needs_human не захватывается ни без флага, ни с --operator (fail-closed)', () => {
    const plain = run(backlogCli, ['start', 'bad']);
    expect(plain.status).not.toBe(0);
    expect(plain.stderr).toContain('needs_human');
    const forced = run(backlogCli, ['start', 'bad', '--operator']);
    expect(forced.status).not.toBe(0);
    expect(forced.stderr).toContain('needs_human');
    expect(git(['rev-parse', '--verify', 'task/bad']).status).not.toBe(0);
  });

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

describe('pnpm backlog next/start --operator: мягкий путь не запирает захват (ADR 0023)', () => {
  it('задача оператора, пересекающаяся с ведущейся только по docs/architecture.md, выдаётся и захватывается', () => {
    const laws = 'docs/architecture.md';
    // ms ведётся оператором; mc сходится с ней только по мягкому пути: документ
    // обязаны объявить обе, пересечением он не считается.
    writeFileSync(
      join(repo, 'backlog', 'ms.md'),
      taskFile('ms', { priority: 'high', touches: `${laws}, tools/verify.ts` }),
    );
    writeFileSync(
      join(repo, 'backlog', 'mc.md'),
      taskFile('mc', {
        priority: 'high',
        touches: `${laws}, apps/web/src/lib/soft.ts`,
        needs_human: 'оператор: согласовать раздел законов',
      }),
    );
    git(['add', '-A']);
    assertOk(git(['commit', '-m', 'доска: ms и mc сходятся по мягкому пути']), 'git commit');
    // m2 — другой свободный кандидат того же приоритета: его дорожка занята, чтобы
    // выдача выбирала только между mc и его пересечением с ms.
    claimBranches(['m2', 'ms']);

    const next = run(backlogCli, ['next', '--operator']);
    expect(next.status).toBe(0);
    expect(next.stdout).toContain('задача оператора: mc');
    expect(next.stderr).toContain('task/ms [docs/architecture.md, tools/verify.ts]');
    expect(next.stderr).not.toContain('mc — с task/ms');
    // Выданное не отвергается захватом под замком: выдача и D7 считают одинаково.
    const start = run(backlogCli, ['start', 'mc', '--operator']);
    expect(start.status).toBe(0);
    expect(start.stderr).not.toContain('пересекается');
    expect(git(['rev-parse', '--verify', 'task/mc']).status).toBe(0);
    assertOk(git(['worktree', 'remove', '--force', join(tmpBase, 'clone-task-mc')]), 'remove mc');
    releaseBranches(['mc', 'ms', 'm2']);
  }, 60_000);
});

// Пути ленивые (функции на уровне модуля): repo/tmpBase заполняются в beforeAll,
// describe-константы вычисляются раньше и превращаются в относительные.
const mainSettings = (): string => join(repo, '.claude', 'settings.local.json');
const worktreeDir = (): string => join(tmpBase, 'clone-task-e');
const worktreeSettings = (): string => join(worktreeDir(), '.claude', 'settings.local.json');

describe('pnpm backlog resume для задачи оператора', () => {
  it('без флага — отказ (в worktree включён режим обслуживания), с --operator — продолжение', () => {
    const refused = run(backlogCli, ['resume', 'e']);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('задача оператора');
    const ok = run(backlogCli, ['resume', 'e', '--operator']);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('Продолжение задачи e');
  }, 30_000);
});

describe('неизвестный флаг', () => {
  it('умирает с перечислением, а не молча игнорирует (З11)', () => {
    const result = run(backlogCli, ['list', '--operatr']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Неизвестный флаг');
    expect(result.stderr).toContain('--operatr');
  });
});

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
    // Фикстура bad.md нужна CLI-сценариям выше, но она заведомо невалидна для
    // этого гейта: убираем из дерева, чтобы happy-path был чистым.
    rmSync(join(repo, 'backlog', 'bad.md'), { force: true });
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
