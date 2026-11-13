/**
 * stop-verify по merge-base (roadmap A2 пункт 2): закоммиченные изменения больше
 * не прячут работу от проверки, повторный Stop на том же состоянии не гоняет
 * verify повторно, docs-only изменения пропускаются. Фикстура — git-репозиторий
 * в tmp с копией хука и заглушкой tools/verify.ts: она печатает отчёт под
 * контролем теста (STUB_VERIFY_MODE) и считает вызовы (STUB_VERIFY_CALLS).
 * origin в фикстуре нет, поэтому fallback «origin/main → main» покрыт каждым
 * тестом: merge-base ищется от локального main.
 */
import { spawnSync } from 'node:child_process';
import {
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
import { beforeAll, expect, it } from 'vitest';

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
const steps = [{ name: 'stub', ok: mode === 'green', command: 'stub verify', output: 'mode=' + mode }];
if (mode === 'garbage') {
  process.stdout.write('not json at all');
} else {
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
  // untracked на всех ветках и ломают кейс docs-only
  git(['add', '.']);
  git(['commit', '-m', 'hooks']);
  git(['checkout', '-b', 'feature']);
  writeFileSync(join(fixture, 'src', 'a.ts'), 'export const a = 1;\n');
  git(['add', '.']);
  git(['commit', '-m', 'feature change']);
});

function git(args: string[]): void {
  const result = spawnSync('git', args, { cwd: fixture, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

function uniqueSession(): string {
  sessionCounter += 1;
  return `sess-${sessionCounter}`;
}

function runHook(
  input: Record<string, unknown>,
  mode: string,
): {
  status: number | null;
  stdout: string;
  stderr: string;
  calls: number;
} {
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
      },
    },
  );
  if (result.error) {
    throw result.error;
  }
  const calls = existsSync(callsPath) ? readFileSync(callsPath, 'utf8').split('\n').length - 1 : 0;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
}

function stop(sessionId: string, mode = 'green'): ReturnType<typeof runHook> {
  return runHook({ session_id: sessionId, hook_event_name: 'Stop', cwd: fixture }, mode);
}

it('Stop после коммита всё равно гоняет verify: изменения ищутся от merge-base с main', () => {
  const sessionId = uniqueSession();
  const result = stop(sessionId);
  expect(result.status).toBe(0);
  expect(result.calls, 'verify ran once').toBe(1);
});

it('повторный Stop на том же состоянии не гоняет verify повторно', () => {
  const sessionId = uniqueSession();
  stop(sessionId);
  const again = stop(sessionId);
  expect(again.calls, 'green fingerprint skipped verify').toBe(0);
});

it('новое состояние снова гоняет verify', () => {
  const sessionId = uniqueSession();
  stop(sessionId);
  writeFileSync(join(fixture, 'src', 'b.ts'), 'export const b = 2;\n');
  const result = stop(sessionId);
  expect(result.calls, 'untracked file is a change').toBe(1);
  rmSync(join(fixture, 'src', 'b.ts'), { force: true });
});

it('docs-only изменения пропускаются', () => {
  const sessionId = uniqueSession();
  // отдельный бранч от main: на feature уже есть закоммиченный src/a.ts
  git(['checkout', '-b', 'docs-only', 'main']);
  mkdirSync(join(fixture, 'docs'), { recursive: true });
  writeFileSync(join(fixture, 'docs', 'guide.md'), '# guide\n');
  git(['add', '.']);
  git(['commit', '-m', 'docs only']);
  const result = stop(sessionId);
  expect(result.calls, 'docs-only did not run verify').toBe(0);
  expect(result.status).toBe(0);
  git(['checkout', 'feature']);
});

it('красный verify блокирует завершение с деталями шагов', () => {
  const sessionId = uniqueSession();
  const result = stop(sessionId, 'red');
  expect(result.stdout).toContain('"decision":"block"');
  expect(result.stdout).toContain('stub');
  expect(result.calls, 'verify ran').toBe(1);
});

it('после трёх красных подряд Stop отпускает и требует сообщить пользователю', () => {
  const sessionId = uniqueSession();
  stop(sessionId, 'red');
  stop(sessionId, 'red');
  stop(sessionId, 'red');
  const fourth = stop(sessionId, 'red');
  expect(fourth.stdout).not.toContain('"decision":"block"');
  expect(fourth.stdout, 'release asks to tell the user').toMatch(/verify is still failing/i);
});

it('зелёный после красного сбрасывает счётчик блоков', () => {
  const sessionId = uniqueSession();
  stop(sessionId, 'red');
  const green = stop(sessionId, 'green');
  expect(green.status).toBe(0);
  const again = stop(sessionId, 'green');
  expect(again.calls, 'green fingerprint stored').toBe(0);
});

it('отчёт verify, который не читается, блокирует как красный', () => {
  const sessionId = uniqueSession();
  const result = stop(sessionId, 'garbage');
  expect(result.stdout).toContain('"decision":"block"');
  expect(result.stdout).toMatch(/did not produce a report/i);
});

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
});

it('другая сессия не переиспользует отпечаток — verify гоняется заново', () => {
  const first = uniqueSession();
  stop(first);
  const second = uniqueSession();
  const result = stop(second);
  expect(result.calls, 'fresh session runs verify').toBe(1);
  expect(stateDir(fixture, first)).not.toBe(stateDir(fixture, second));
});
