/**
 * stop-verify по merge-base (roadmap A2 пункт 2): закоммиченные изменения больше
 * не прячут работу от проверки, повторный Stop на том же состоянии не гоняет
 * verify повторно, правка содержимого изменённого файла меняет отпечаток,
 * docs-only изменения пропускаются. Фикстура — git-репозиторий в tmp с копией
 * хука и заглушкой tools/verify.ts: она печатает отчёт под контролем теста
 * (STUB_VERIFY_MODE) и считает вызовы (STUB_VERIFY_CALLS).
 */
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { stateDir } from '../snapshot.ts';

const repoDir = resolve(import.meta.dirname, '..', '..');

const COPIED_FILES = [
  '.claude/hooks/lib.ts',
  '.claude/hooks/stop-verify.ts',
  '.claude/hooks/stop-verify.main.ts',
  'tools/snapshot.ts',
  'tools/protected-paths.ts',
];

const STUB_VERIFY = `import { appendFileSync } from 'node:fs';
const calls = process.env['STUB_VERIFY_CALLS'];
if (calls) {
  appendFileSync(calls, '1\\n');
}
const mode = process.env['STUB_VERIFY_MODE'] ?? 'green';
if (mode === 'garbage') {
  process.stdout.write('not json at all');
} else if (mode === 'halfvalid') {
  // ok-тип верен, шаг сломан: отчёт не читаем — хук обязан считать его красным
  console.log(JSON.stringify({ ok: true, steps: [{ name: 123 }] }));
} else {
  const steps = [{ name: 'stub', ok: mode === 'green', command: 'stub verify', output: 'mode=' + mode }];
  console.log(JSON.stringify({ ok: mode === 'green', steps }));
}
`;

let fixture = '';
let sessionCounter = 0;

beforeAll(() => {
  fixture = mkdtempSync(join(tmpdir(), 'a2-2-'));
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'fixture@example.com']);
  git(['config', 'user.name', 'Fixture']);
  mkdirSync(join(fixture, 'src'), { recursive: true });
  mkdirSync(join(fixture, 'tools'), { recursive: true });
  mkdirSync(join(fixture, '.claude', 'hooks'), { recursive: true });
  writeFileSync(join(fixture, 'README.md'), '# fixture\n');
  for (const file of COPIED_FILES) {
    const target = join(fixture, file);
    mkdirSync(resolve(target, '..'), { recursive: true });
    cpSync(join(repoDir, file), target);
  }
  writeFileSync(
    join(fixture, 'tools', 'protected-paths.json'),
    JSON.stringify({ deny: [], review: [] }),
  );
  writeFileSync(join(fixture, 'tools', 'verify.ts'), STUB_VERIFY);
  // копии и заглушка закоммичены на main до ветвления: иначе они остаются
  // untracked на всех ветках и ломают кейсы docs-only и untracked
  git(['add', '.']);
  git(['commit', '-m', 'hooks']);
  git(['checkout', '-b', 'feature']);
  writeFileSync(join(fixture, 'src', 'a.ts'), 'export const a = 1;\n');
  git(['add', '.']);
  git(['commit', '-m', 'feature change']);
});

afterAll(() => {
  rmSync(fixture, { recursive: true, force: true });
});

function git(args: string[]): void {
  const run = spawnSync('git', args, { cwd: fixture, encoding: 'utf8' });
  if (run.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`);
  }
}

function uniqueSession(): string {
  sessionCounter += 1;
  return `sess-${sessionCounter}`;
}

interface HookOutcome {
  status: number | null;
  stdout: string;
  stderr: string;
  calls: number;
}

function runHook(
  input: Record<string, unknown>,
  mode: string,
  extraEnv: Record<string, string> = {},
): HookOutcome {
  const sessionId = typeof input['session_id'] === 'string' ? input['session_id'] : 'x';
  const callsPath = join(tmpdir(), `stub-calls-${sessionId}`);
  rmSync(callsPath, { force: true });
  const result = spawnSync(
    process.execPath,
    [join(fixture, '.claude', 'hooks', 'stop-verify.ts')],
    {
      cwd: fixture,
      input: JSON.stringify(input),
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: fixture,
        STUB_VERIFY_CALLS: callsPath,
        STUB_VERIFY_MODE: mode,
        ...extraEnv,
      },
    },
  );
  if (result.error) {
    throw result.error;
  }
  const calls = existsSync(callsPath) ? readFileSync(callsPath, 'utf8').split('\n').length - 1 : 0;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
}

function stop(sessionId: string, mode = 'green'): HookOutcome {
  return runHook({ session_id: sessionId, hook_event_name: 'Stop', cwd: fixture }, mode);
}

it('Stop после коммита всё равно гоняет verify: изменения ищутся от merge-base с main', () => {
  const result = stop(uniqueSession());
  expect(result.status).toBe(0);
  expect(result.calls, 'verify ran once').toBe(1);
}, 30_000);

it('повторный Stop на том же состоянии не гоняет verify повторно', () => {
  const sessionId = uniqueSession();
  stop(sessionId);
  const again = stop(sessionId);
  expect(again.calls, 'green fingerprint skipped verify').toBe(0);
}, 30_000);

it('правка содержимого уже изменённого файла после зелёного Stop снова гоняет verify', () => {
  const sessionId = uniqueSession();
  stop(sessionId);
  appendFileSync(join(fixture, 'src', 'a.ts'), 'export const c = 3;\n');
  const result = stop(sessionId);
  expect(result.calls, 'content change alters the fingerprint').toBe(1);
  // вернуть содержимое для остальных тестов
  writeFileSync(join(fixture, 'src', 'a.ts'), 'export const a = 1;\n');
  stop(sessionId);
}, 30_000);

it('новое состояние снова гоняет verify', () => {
  const sessionId = uniqueSession();
  stop(sessionId);
  writeFileSync(join(fixture, 'src', 'b.ts'), 'export const b = 2;\n');
  const result = stop(sessionId);
  expect(result.calls, 'untracked file is a change').toBe(1);
  rmSync(join(fixture, 'src', 'b.ts'), { force: true });
}, 30_000);

it('docs-only изменения пропускаются', () => {
  const sessionId = uniqueSession();
  // отдельный бранч от main: на feature уже есть закоммиченный src/a.ts
  git(['checkout', '-b', 'docs-only', 'main']);
  try {
    mkdirSync(join(fixture, 'docs'), { recursive: true });
    writeFileSync(join(fixture, 'docs', 'guide.md'), '# guide\n');
    git(['add', '.']);
    git(['commit', '-m', 'docs only']);
    const result = stop(sessionId);
    expect(result.calls, 'docs-only did not run verify').toBe(0);
    expect(result.status).toBe(0);
  } finally {
    git(['checkout', 'feature']);
  }
}, 30_000);

it('untracked файл — изменение даже там, где закоммиченный дифф только docs', () => {
  const sessionId = uniqueSession();
  git(['checkout', 'docs-only']);
  try {
    mkdirSync(join(fixture, 'src'), { recursive: true });
    writeFileSync(join(fixture, 'src', 'late.ts'), 'export const late = 1;\n');
    const result = stop(sessionId);
    expect(result.calls, 'untracked triggers verify').toBe(1);
  } finally {
    rmSync(join(fixture, 'src', 'late.ts'), { force: true });
    git(['checkout', 'feature']);
  }
}, 30_000);

it('есть origin/main — merge-base берётся от него', () => {
  const sessionId = uniqueSession();
  const bare = mkdtempSync(join(tmpdir(), 'a2-2-origin-'));
  const originGit = join(bare, 'origin.git');
  spawnSync('git', ['init', '--bare', originGit]);
  git(['remote', 'add', 'origin', originGit]);
  try {
    git(['push', 'origin', 'main']);
    const result = stop(sessionId);
    expect(result.calls, 'verify ran with origin/main as the base').toBe(1);
  } finally {
    git(['remote', 'remove', 'origin']);
    rmSync(bare, { recursive: true, force: true });
  }
}, 30_000);

it('git нечитаем — verify запускается консервативно', () => {
  const sessionId = uniqueSession();
  const result = runHook(
    { session_id: sessionId, hook_event_name: 'Stop', cwd: fixture },
    'green',
    { PATH: join(fixture, 'no-bin') },
  );
  expect(result.calls, 'unknown state must run verify').toBe(1);
  expect(result.status).toBe(0);
}, 30_000);

it('битый state не пропускает verify', () => {
  const sessionId = uniqueSession();
  const dir = stateDir(fixture, sessionId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'stop-verify.json'), '{garbage');
  const result = stop(sessionId);
  expect(result.calls, 'unreadable state cannot vouch for a green run').toBe(1);
}, 30_000);

it('красный verify блокирует завершение с деталями шагов', () => {
  const result = stop(uniqueSession(), 'red');
  expect(result.stdout).toContain('"decision":"block"');
  expect(result.stdout).toContain('stub');
  expect(result.calls, 'verify ran').toBe(1);
}, 30_000);

it('после трёх красных подряд Stop отпускает и требует сообщить пользователю', () => {
  const sessionId = uniqueSession();
  stop(sessionId, 'red');
  stop(sessionId, 'red');
  stop(sessionId, 'red');
  const fourth = stop(sessionId, 'red');
  expect(fourth.stdout).not.toContain('"decision":"block"');
  expect(fourth.stdout, 'release asks to tell the user').toMatch(/verify is still failing/i);
}, 30_000);

it('зелёный сбрасывает счётчик блоков в state, а не оставляет накопленный', () => {
  const sessionId = uniqueSession();
  stop(sessionId, 'red');
  stop(sessionId, 'green');
  const stateFile = join(stateDir(fixture, sessionId), 'stop-verify.json');
  const parsed: unknown = JSON.parse(readFileSync(stateFile, 'utf8'));
  expect(parsed, 'blocks reset to 0, green fingerprint stored').toEqual({
    green: expect.any(String),
    blocks: 0,
  });
}, 30_000);

it('полувалидный отчёт verify блокирует как красный', () => {
  const result = stop(uniqueSession(), 'halfvalid');
  expect(result.stdout).toContain('"decision":"block"');
  expect(result.stdout).toMatch(/did not produce a report/i);
}, 30_000);

it('отчёт verify, который не читается, блокирует как красный', () => {
  const result = stop(uniqueSession(), 'garbage');
  expect(result.stdout).toContain('"decision":"block"');
  expect(result.stdout).toMatch(/did not produce a report/i);
}, 30_000);

it('битый вход Stop закрывает хук кодом 2, а не неблокирующим 1', () => {
  const result = spawnSync(
    process.execPath,
    [join(fixture, '.claude', 'hooks', 'stop-verify.ts')],
    {
      cwd: fixture,
      input: 'not json',
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, CLAUDE_PROJECT_DIR: fixture },
    },
  );
  if (result.error) {
    throw result.error;
  }
  expect(result.status, 'fail-closed exit code').toBe(2);
}, 30_000);

it('другая сессия не переиспользует отпечаток — verify гоняется заново', () => {
  const first = uniqueSession();
  stop(first);
  const second = uniqueSession();
  const result = stop(second);
  expect(result.calls, 'fresh session runs verify').toBe(1);
  expect(stateDir(fixture, first)).not.toBe(stateDir(fixture, second));
}, 30_000);
