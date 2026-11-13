/**
 * Проверка по результату (roadmap A2 пункт 1, ADR 0003): канарейки механизма снимка.
 * Фикстура — настоящий git-репозиторий в tmp с копией хуков и собственным
 * protected-paths.json. Табличные кейсы: изменение защищённого файла, проскочившее
 * guard-bash, отменяется хуком и объясняется агенту; дрейф, совпавший с новым HEAD,
 * перебазируется; новые файлы под deny — только сообщаются, не удаляются; порча
 * state делает проверку громко слепой, а не тихо пропускающей.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { beforeAll, expect, it, vi } from 'vitest';

// Все тесты файла спавнят настоящие хуки в git-фикстуре: под параллельной
// нагрузкой verify дефолтные 5 c на тест флакуют (наблюдалось на чистом main).
vi.setConfig({ testTimeout: 30_000 });

import { stateDir } from '../snapshot.ts';

const repoDir = resolve(import.meta.dirname, '..', '..');

/** Хуки и модули, без которых цепочка импортов фикстуры не собирается. */
const COPIED_FILES = [
  '.claude/hooks/lib.ts',
  '.claude/hooks/session-start.ts',
  '.claude/hooks/protect-result.ts',
  '.claude/hooks/protect-result.main.ts',
  'tools/protected-paths.ts',
  'tools/snapshot.ts',
];

const PIN = '{"budget": 100}\n';
const KEEP = '{"baseline": true}\n';
const KEEPER_SH = '#!/bin/sh\necho keeper\n';

let fixture = '';
let sessionCounter = 0;

beforeAll(() => {
  fixture = mkdtempSync(join(tmpdir(), 'a2-1b-'));
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'fixture@example.com']);
  git(['config', 'user.name', 'Fixture']);
  mkdirSync(join(fixture, 'gates'), { recursive: true });
  mkdirSync(join(fixture, 'tools'), { recursive: true });
  mkdirSync(join(fixture, '.claude', 'hooks'), { recursive: true });
  writeFileSync(join(fixture, 'gates', 'keep.json'), KEEP);
  writeFileSync(join(fixture, 'gates', 'keeper.sh'), KEEPER_SH);
  chmodSync(join(fixture, 'gates', 'keeper.sh'), 0o755);
  writeFileSync(join(fixture, 'pin.json'), PIN);
  writeFileSync(join(fixture, 'README.md'), '# fixture\n');
  git(['add', '.']);
  git(['commit', '-m', 'init']);
  for (const file of COPIED_FILES) {
    const target = join(fixture, file);
    mkdirSync(resolve(target, '..'), { recursive: true });
    cpSync(join(repoDir, file), target);
  }
  writeFileSync(
    join(fixture, 'tools', 'protected-paths.json'),
    JSON.stringify({ deny: ['pin.json', 'gates/**'], review: [] }),
  );
  git(['add', '.']);
  git(['commit', '-m', 'hooks']);
});

function git(args: string[]): void {
  const result = spawnSync('git', args, { cwd: fixture, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

function headSha(): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: fixture, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git rev-parse failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function uniqueSession(): string {
  sessionCounter += 1;
  return `sess-${sessionCounter}`;
}

interface HookResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runHook(hook: string, input: Record<string, unknown>): HookResult {
  const result = spawnSync(process.execPath, [join(fixture, '.claude', 'hooks', hook)], {
    cwd: fixture,
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: fixture },
  });
  if (result.error) {
    throw result.error;
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Хук обязан выходить с 0; stderr попадает в сообщение ошибки. */
function expectOk(result: { status: number | null; stderr: string }, what: string): void {
  if (result.status !== 0) {
    throw new Error(`${what} exited with ${result.status}: ${result.stderr}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function startup(sessionId: string, source = 'startup'): HookResult {
  return runHook('session-start.ts', {
    session_id: sessionId,
    hook_event_name: 'SessionStart',
    source,
    cwd: fixture,
  });
}

function postToolUse(sessionId: string): HookResult {
  return runHook('protect-result.ts', {
    session_id: sessionId,
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'true' },
    cwd: fixture,
  });
}

function stop(sessionId: string): HookResult {
  return runHook('protect-result.ts', {
    session_id: sessionId,
    hook_event_name: 'Stop',
    cwd: fixture,
  });
}

function snapshottedHash(sessionId: string, path: string): string {
  const parsed: unknown = JSON.parse(
    readFileSync(join(stateDir(fixture, sessionId), 'manifest.json'), 'utf8'),
  );
  if (!isRecord(parsed) || !isRecord(parsed['files'])) {
    throw new Error('manifest has no files map');
  }
  const entry = parsed['files'][path];
  if (!isRecord(entry) || typeof entry['hash'] !== 'string') {
    throw new Error(`${path} is not snapshotted`);
  }
  return entry['hash'];
}

/** manifest как изменяемый объект — для кейсов с подделкой state. */
function readManifest(sessionId: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(
    readFileSync(join(stateDir(fixture, sessionId), 'manifest.json'), 'utf8'),
  );
  if (!isRecord(parsed)) {
    throw new Error('manifest is not an object');
  }
  return parsed;
}

function contentSha(content: string): string {
  return createHash('sha1').update(content).digest('hex');
}

it('startup снимает снимок: tracked-файлы из deny, копии 0600, записан HEAD', () => {
  const sessionId = uniqueSession();
  const result = startup(sessionId);
  expectOk(result, 'session-start');
  const dir = stateDir(fixture, sessionId);
  expect(existsSync(join(dir, 'manifest.json')), 'manifest exists').toBe(true);
  for (const path of ['pin.json', join('gates', 'keep.json')]) {
    const copy = join(dir, path.replaceAll('/', '__'));
    expect(existsSync(copy), `copy of ${path} exists`).toBe(true);
    expect(statSync(copy).mode & 0o777, 'copy is 0600').toBe(0o600);
    expect(readFileSync(copy, 'utf8'), 'copy matches the worktree').toBe(
      readFileSync(join(fixture, path), 'utf8'),
    );
    expect(snapshottedHash(sessionId, path), 'hash looks like sha1').toMatch(/^[0-9a-f]{40}$/);
  }
  expect(readFileSync(join(dir, 'manifest.json'), 'utf8')).toContain(headSha());
  expect(statSync(join(dir, 'manifest.json')).mode & 0o777, 'manifest is 0600').toBe(0o600);
});

it('resume переиспользует снимок, а не переснимает изменившееся рабочее дерево', () => {
  const sessionId = uniqueSession();
  startup(sessionId);
  const before = snapshottedHash(sessionId, 'pin.json');
  writeFileSync(join(fixture, 'pin.json'), '{"budget": 999}\n');
  const result = startup(sessionId, 'resume');
  expectOk(result, 'session-start on resume');
  expect(snapshottedHash(sessionId, 'pin.json'), 'snapshot untouched by resume').toBe(before);
  writeFileSync(join(fixture, 'pin.json'), PIN);
});

it('resume без снимка создаёт его и предупреждает', () => {
  const sessionId = uniqueSession();
  const result = startup(sessionId, 'resume');
  expectOk(result, 'session-start on resume');
  expect(existsSync(join(stateDir(fixture, sessionId), 'manifest.json')), 'snapshot created').toBe(
    true,
  );
  expect(result.stdout, 'warning is reported').toMatch(/snapshot/i);
});

it.each([
  {
    name: 'перезапись через node -e — мимо guard-bash',
    action: `node -e "require('fs').writeFileSync('pin.json', '{\\"budget\\": 0}\\n')"`,
    path: 'pin.json',
    original: PIN,
  },
  {
    name: 'перезапись защищённого файла в подкаталоге',
    action: `echo '{"hacked": 1}' > gates/keep.json`,
    path: join('gates', 'keep.json'),
    original: KEEP,
  },
  {
    name: 'удаление защищённого файла',
    action: 'rm pin.json',
    path: 'pin.json',
    original: PIN,
  },
])('PostToolUse(Bash): $name — отменено и объяснено', ({ action, path, original }) => {
  const sessionId = uniqueSession();
  startup(sessionId);
  const run = spawnSync('bash', ['-c', action], { cwd: fixture, encoding: 'utf8' });
  expectOk(run, `bash action ${action}`);
  const result = postToolUse(sessionId);
  expectOk(result, 'protect-result');
  expect(result.stdout, 'the agent is told what happened').toContain(path);
  expect(result.stdout, 'the cancellation is explained, not just a path').toMatch(/CANCELLED/);
  expect(readFileSync(join(fixture, path), 'utf8'), `${path} is restored`).toBe(original);
});

it('новый файл под deny только сообщается и не удаляется', () => {
  const sessionId = uniqueSession();
  startup(sessionId);
  const run = spawnSync('bash', ['-c', `echo '{"new": 1}' > gates/extra.json`], {
    cwd: fixture,
    encoding: 'utf8',
  });
  expectOk(run, 'bash action creating gates/extra.json');
  const result = postToolUse(sessionId);
  expectOk(result, 'protect-result');
  expect(result.stdout, 'new file is reported').toContain(join('gates', 'extra.json'));
  expect(existsSync(join(fixture, 'gates', 'extra.json')), 'new file is NOT deleted').toBe(true);
  rmSync(join(fixture, 'gates', 'extra.json'), { force: true });
});

it('исполнительный бит восстанавливается вместе с содержимым', () => {
  const sessionId = uniqueSession();
  startup(sessionId);
  const script = join(fixture, 'gates', 'keeper.sh');
  writeFileSync(script, '#!/bin/sh\necho hacked\n');
  chmodSync(script, 0o644);
  const result = postToolUse(sessionId);
  expectOk(result, 'protect-result');
  expect(readFileSync(script, 'utf8'), 'content restored').toBe(KEEPER_SH);
  expect(statSync(script).mode & 0o111, 'exec bit restored').not.toBe(0);
});

it('symlink на защищённом пути заменяется файлом из снимка, а не проследовывается', () => {
  const sessionId = uniqueSession();
  startup(sessionId);
  const target = join(fixture, '..', `${basename(fixture)}-restore-victim`);
  rmSync(join(fixture, 'pin.json'));
  symlinkSync(target, join(fixture, 'pin.json'));
  const result = postToolUse(sessionId);
  expectOk(result, 'protect-result');
  expect(lstatSync(join(fixture, 'pin.json')).isSymbolicLink(), 'link is replaced').toBe(false);
  expect(readFileSync(join(fixture, 'pin.json'), 'utf8'), 'file restored from snapshot').toBe(PIN);
  expect(existsSync(target), 'link target was never written through').toBe(false);
});

it('защищённый путь-symlink на старте сессии делает снимок громко слепым', () => {
  const sessionId = uniqueSession();
  rmSync(join(fixture, 'pin.json'));
  symlinkSync(join(fixture, 'README.md'), join(fixture, 'pin.json'));
  const result = startup(sessionId);
  expect(result.stdout, 'failure is loud').toMatch(/snapshot FAILED/);
  expect(
    existsSync(join(stateDir(fixture, sessionId), 'manifest.json')),
    'no trustworthy manifest',
  ).toBe(false);
  rmSync(join(fixture, 'pin.json'));
  writeFileSync(join(fixture, 'pin.json'), PIN);
});

it('дрейф, совпавший с новым HEAD (pull/merge), перебазируется, а не откатывается', () => {
  const sessionId = uniqueSession();
  startup(sessionId);
  writeFileSync(join(fixture, 'pin.json'), '{"budget": 200}\n');
  git(['add', '.']);
  git(['commit', '-m', 'legitimate gate change from a labeled PR']);
  const result = postToolUse(sessionId);
  expectOk(result, 'protect-result');
  expect(readFileSync(join(fixture, 'pin.json'), 'utf8'), 'legit change stays').toBe(
    '{"budget": 200}\n',
  );
  expect(snapshottedHash(sessionId, 'pin.json'), 'snapshot rebased to the new content').toBe(
    contentSha('{"budget": 200}\n'),
  );
  expect(result.stdout, 'rebase is reported').toMatch(/rebas/i);
  const parsed = readManifest(sessionId);
  if (typeof parsed['head'] !== 'string') {
    throw new Error('manifest has no head');
  }
  expect(parsed['head'], 'recorded HEAD follows the branch').toBe(headSha());
  // возвращаем базу, чтобы последующие тесты не зависели от порядка
  git(['revert', '--no-edit', 'HEAD']);
});

it('файл, исчезнувший вместе с HEAD (git rm), убирается из снимка, а не воскрешается', () => {
  const sessionId = uniqueSession();
  startup(sessionId);
  git(['rm', join('gates', 'keep.json')]);
  git(['commit', '-m', 'gate removed from the repo by a labeled PR']);
  const result = postToolUse(sessionId);
  expectOk(result, 'protect-result');
  expect(existsSync(join(fixture, 'gates', 'keep.json')), 'deletion stays').toBe(false);
  expect(result.stdout, 'drop is reported').toContain(join('gates', 'keep.json'));
  expect(() => snapshottedHash(sessionId, join('gates', 'keep.json'))).toThrow(/not snapshotted/);
  // возвращаем файл для последующих тестов
  writeFileSync(join(fixture, 'gates', 'keep.json'), KEEP);
  git(['add', '.']);
  git(['commit', '-m', 'keep.json restored']);
});

it('Stop при дрейфе восстанавливает файл и блокирует завершение с объяснением', () => {
  const sessionId = uniqueSession();
  startup(sessionId);
  const baseline = readFileSync(join(fixture, 'pin.json'), 'utf8');
  writeFileSync(join(fixture, 'pin.json'), '{"budget": 0}\n');
  const result = stop(sessionId);
  expect(readFileSync(join(fixture, 'pin.json'), 'utf8'), 'file is restored').toBe(baseline);
  expect(result.stdout).toContain('"decision":"block"');
  expect(result.stdout).toContain('pin.json');
});

it('Stop без дрейфа не блокирует завершение', () => {
  const sessionId = uniqueSession();
  startup(sessionId);
  const result = stop(sessionId);
  expectOk(result, 'protect-result on Stop');
  expect(result.stdout).not.toContain('"decision":"block"');
});

it('Stop без снимка не притворяется, что всё в порядке', () => {
  const result = stop(`sess-missing-${uniqueSession()}`);
  expectOk(result, 'protect-result without snapshot');
  expect(result.stdout, 'blindness is reported').toMatch(/snapshot/i);
});

it('переписанный хеш в manifest при старой копии делает проверку громко слепой', () => {
  const sessionId = uniqueSession();
  startup(sessionId);
  writeFileSync(join(fixture, 'pin.json'), '{"budget": 0}\n');
  // агент «узаконивает» новое содержимое правкой manifest, но копию не трогает:
  // доверять такой паре нельзя ни для сверки, ни для отката
  const manifest = readManifest(sessionId);
  const files = manifest['files'];
  if (!isRecord(files)) {
    throw new Error('manifest has no files map');
  }
  const pin = files['pin.json'];
  if (!isRecord(pin)) {
    throw new Error('pin.json is not snapshotted');
  }
  pin['hash'] = contentSha('{"budget": 0}\n');
  writeFileSync(join(stateDir(fixture, sessionId), 'manifest.json'), JSON.stringify(manifest));
  const result = postToolUse(sessionId);
  expectOk(result, 'protect-result');
  expect(result.stdout, 'broken state is reported loudly').toMatch(/cannot proceed/i);
  expect(
    readFileSync(join(fixture, 'pin.json'), 'utf8'),
    'nothing restored from untrusted state',
  ).toBe('{"budget": 0}\n');
});

it('пропавшая копия снимка не уводит Stop в livelock', () => {
  const sessionId = uniqueSession();
  startup(sessionId);
  rmSync(join(stateDir(fixture, sessionId), 'pin.json'));
  writeFileSync(join(fixture, 'pin.json'), '{"budget": 0}\n');
  const result = stop(sessionId);
  expectOk(result, 'protect-result on Stop');
  expect(result.stdout, 'no endless blocking').not.toContain('"decision":"block"');
  expect(result.stdout, 'broken state is reported loudly').toMatch(/cannot proceed/i);
});

it('путь из manifest не может выйти за worktree — снимок отвергается громко', () => {
  const sessionId = uniqueSession();
  startup(sessionId);
  const manifest = readManifest(sessionId);
  const files = manifest['files'];
  if (!isRecord(files)) {
    throw new Error('manifest has no files map');
  }
  files['../escaped.txt'] = { hash: contentSha('x'), executable: false };
  writeFileSync(join(stateDir(fixture, sessionId), 'manifest.json'), JSON.stringify(manifest));
  const result = postToolUse(sessionId);
  expectOk(result, 'protect-result');
  expect(existsSync(join(fixture, '..', 'escaped.txt')), 'no write outside worktree').toBe(false);
  expect(result.stdout, 'rejection is reported').toMatch(/snapshot/i);
});

it('старые state-каталоги других сессий удаляются при старте', () => {
  const stale = join(tmpdir(), 'claude-gate-guard', 'stale-session-old');
  mkdirSync(stale, { recursive: true });
  const weekAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(stale, weekAgo, weekAgo);
  startup(uniqueSession());
  expect(existsSync(stale), 'stale state dir removed').toBe(false);
});
