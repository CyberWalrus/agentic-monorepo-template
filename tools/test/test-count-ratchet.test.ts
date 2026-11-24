/**
 * Канарейка a10: update поднимает базлайн до факта и отказывается понижать;
 * nightly-джоб храповика на месте; правило «поднимает автоматика» в архитектуре.
 *
 * Канарейки e40 «PR создан или громкая ошибка» (критерий приёмки): шаг
 * «PR with raised baseline» исполняется тем текстом, что читает runner из
 * nightly.yml, — в подставном репозитории: bare-репозиторий вместо github.com
 * (url.insteadOf подменяет URL push) и подставной gh на PATH. Отказ create,
 * который не «PR уже открыт», обязан краснить шаг: замаскированный `|| echo`
 * ловится исполнением шага, а не поиском подстроки.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const repoDir = resolve(import.meta.dirname, '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'a10-ratchet-'));
const prTmp = mkdtempSync(join(tmpdir(), 'e40-ratchet-pr-'));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(prTmp, { recursive: true, force: true });
});

function runUpdate(): { status: number | null; stdout: string } {
  const baseline = join(tmp, 'test-count-baseline.json');
  const run = spawnSync(
    'node',
    [
      join(repoDir, 'tools', 'check-test-count.ts'),
      '--cwd',
      tmp,
      '--baseline',
      baseline,
      '--update',
    ],
    { encoding: 'utf8', timeout: 60_000 },
  );
  return { status: run.status, stdout: run.stdout };
}

function writeFixture(baselineCount: number): void {
  mkdirSync(join(tmp, 'apps', 'api', 'reports'), { recursive: true });
  writeFileSync(join(tmp, 'apps', 'api', 'reports', 'vitest.json'), '{"numTotalTests": 48}');
  writeFileSync(
    join(tmp, 'test-count-baseline.json'),
    `${JSON.stringify({ 'apps/api/reports/vitest.json': baselineCount }, null, 2)}\n`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function baselineValue(): unknown {
  const parsed: unknown = JSON.parse(readFileSync(join(tmp, 'test-count-baseline.json'), 'utf8'));
  return isRecord(parsed) ? parsed['apps/api/reports/vitest.json'] : undefined;
}

it('update поднимает базлайн до факта (дифф непуст — PR храповика формируется)', () => {
  writeFixture(43);
  const run = runUpdate();
  expect(run.status).toBe(0);
  expect(baselineValue()).toBe(48);
  expect(run.stdout).toContain('raised');
});

it('update отказывается понижать (дифф пуст, отказ в выводе)', () => {
  writeFixture(100);
  const run = runUpdate();
  expect(run.status).toBe(0);
  expect(baselineValue()).toBe(100);
  expect(run.stdout).toContain('refused to lower');
});

function nightlyLines(): string[] {
  return readFileSync(join(repoDir, '.github', 'workflows', 'nightly.yml'), 'utf8').split('\n');
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** Текст шага (`run:`) из nightly.yml — тот самый, который исполняет runner. */
function stepScript(stepName: string): string {
  const lines = nightlyLines();
  const header = `- name: ${stepName}`;
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) {
    throw new Error(`step "${stepName}" not found in nightly.yml`);
  }
  const stepIndent = indentOf(lines[start] ?? '');
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim() === '' || indentOf(line) > stepIndent + 2) {
      continue;
    }
    if (indentOf(line) <= stepIndent) {
      break;
    }
    if (!line.trimStart().startsWith('run:')) {
      continue;
    }
    const inline = line.trimStart().slice('run:'.length).trim();
    if (inline !== '|' && inline !== '>') {
      return inline;
    }
    const block: string[] = [];
    for (let body = index + 1; body < lines.length; body += 1) {
      const bodyLine = lines[body] ?? '';
      if (bodyLine.trim() !== '' && indentOf(bodyLine) <= indentOf(line)) {
        break;
      }
      block.push(bodyLine);
    }
    const contentIndent = indentOf(block.find((bodyLine) => bodyLine.trim() !== '') ?? '');
    return block
      .map((bodyLine) => (bodyLine.trim() === '' ? '' : bodyLine.slice(contentIndent)))
      .join('\n')
      .trimEnd();
  }
  throw new Error(`step "${stepName}" has no run: in nightly.yml`);
}

/** Блок джобы nightly.yml — от её ключа до начала следующей джобы. */
function jobLines(jobName: string): string[] {
  const lines = nightlyLines();
  const start = lines.findIndex((line) => line === `  ${jobName}:`);
  if (start === -1) {
    throw new Error(`job "${jobName}" not found in nightly.yml`);
  }
  const end = lines.findIndex((line, index) => index > start && /^  \S/.test(line));
  return lines.slice(start, end === -1 ? lines.length : end);
}

it('проводка: nightly-джоб храповика и правило в architecture.md (a10)', () => {
  const nightly = readFileSync(join(repoDir, '.github', 'workflows', 'nightly.yml'), 'utf8');
  expect(nightly).toContain('test count ratchet');
  expect(nightly).toContain('pnpm test:count:update');
  const architecture = readFileSync(join(repoDir, 'docs', 'architecture.md'), 'utf8');
  expect(architecture).toContain('Числовые храповики поднимает автоматика');
});

it('проводка e40: hooks-отчёт гоняется до update; красная джоба храповика доходит до issue', () => {
  // Корневая //#test:hooks не входит в `turbo run test`: без своего шага отчёта
  // в job нет, и update молча не трогал запись reports/vitest-hooks.json
  // (296 в базлайне при 718 тестах).
  const job = jobLines('test-count-ratchet').join('\n');
  const hooks = job.indexOf('turbo run test:hooks');
  expect(hooks).toBeGreaterThanOrEqual(0);
  expect(hooks).toBeLessThan(job.indexOf('test:count:update'));
  // report заводит issue только по джобам из needs — иначе красный шаг молчит.
  expect(jobLines('report').join('\n')).toContain('test-count-ratchet');
});

const BRANCH = 'chore/test-count-ratchet';
// Токен в URL — как в ночном шаге; insteadOf в подставном клоне уводит push в bare-репозиторий.
const PUSH_URL = 'https://x-access-token:tok@github.com/org/repo.git';
const REFUSED =
  'gh: pull request create failed: GraphQL: GitHub Actions is not permitted to create or approve pull requests (createPullRequest)';

let prCounter = 0;

/** Глобальный и системный git-конфиг машины (gpgsign, hooksPath) не должен влиять на фикстуру. */
function neutralEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
}

function gitText(cwd: string, args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    env: neutralEnv(),
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

const FAKE_GH = `#!/bin/sh
# Подставной gh (e40): вызовы — в calls.log, ответы — файлами $FAKE_GH_DIR.
printf '%s\\n' "$*" >> "$FAKE_GH_DIR/calls.log"
case "$1 $2" in
  "pr list")
    if [ -f "$FAKE_GH_DIR/list-fails" ]; then
      echo "gh: HTTP 502: Bad Gateway (https://api.github.com/graphql)" >&2
      exit 1
    fi
    cat "$FAKE_GH_DIR/pr-list.json"
    ;;
  "pr create")
    if [ -f "$FAKE_GH_DIR/create-refused" ]; then
      echo "${REFUSED}" >&2
      exit 1
    fi
    echo "https://github.com/org/repo/pull/42"
    ;;
  *)
    echo "fake gh: unexpected call: $*" >&2
    exit 99
    ;;
esac
`;

interface RatchetRepo {
  /** Клон на main: здесь ночная джоба делает update и исполняет шаг. */
  dir: string;
  /** Bare-репозиторий — «remote» вместо github.com. */
  remote: string;
  /** Состояние подставного gh: pr-list.json, create-refused, list-fails. */
  ghState: string;
  /** Одна ночь: свежий main, отчёт hooks, pnpm test:count:update. */
  night(hooksTests: number): void;
  runStep(): { status: number | null; output: string };
  ghCalls(): string[];
  remoteTip(): string;
  remoteBaseline(): unknown;
}

function ratchetRepo(): RatchetRepo {
  prCounter += 1;
  const root = mkdtempSync(join(prTmp, `repo-${prCounter}-`));
  const dir = join(root, 'work');
  const remote = join(root, 'origin.git');
  const bin = join(root, 'bin');
  const ghState = join(root, 'gh-state');
  for (const path of [dir, bin, ghState]) {
    mkdirSync(path, { recursive: true });
  }
  gitText(root, ['init', '-q', '--bare', remote]);
  gitText(dir, ['init', '-q', '-b', 'main']);
  gitText(dir, ['config', 'user.name', 'canary']);
  gitText(dir, ['config', 'user.email', 'canary@example.com']);
  gitText(dir, ['config', `url.${remote}.insteadOf`, PUSH_URL]);
  mkdirSync(join(dir, 'tools'));
  copyFileSync(
    join(repoDir, 'tools', 'check-test-count.ts'),
    join(dir, 'tools', 'check-test-count.ts'),
  );
  writeFileSync(
    join(dir, 'test-count-baseline.json'),
    `${JSON.stringify({ 'reports/vitest-hooks.json': 296 }, null, 2)}\n`,
  );
  gitText(dir, ['add', '.']);
  gitText(dir, ['commit', '-qm', 'base']);
  writeFileSync(join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
  writeFileSync(join(ghState, 'pr-list.json'), '[]');
  return {
    dir,
    remote,
    ghState,
    night(hooksTests) {
      gitText(dir, ['checkout', '-q', '--', 'test-count-baseline.json']);
      mkdirSync(join(dir, 'reports'), { recursive: true });
      writeFileSync(join(dir, 'reports', 'vitest-hooks.json'), `{"numTotalTests": ${hooksTests}}`);
      const update = spawnSync(process.execPath, ['tools/check-test-count.ts', '--update'], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 60_000,
      });
      if (update.error !== undefined || update.status !== 0) {
        throw new Error(`test:count:update failed: ${update.stdout}${update.stderr}`);
      }
    },
    runStep() {
      const script = join(root, 'step.sh');
      writeFileSync(script, stepScript('PR with raised baseline'));
      // Как runner на linux: bash --noprofile --norc -eo pipefail <script>.
      const run = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          ...neutralEnv(),
          PATH: `${bin}${delimiter}${process.env['PATH'] ?? ''}`,
          GH_TOKEN: 'tok',
          GITHUB_REPOSITORY: 'org/repo',
          FAKE_GH_DIR: ghState,
        },
      });
      return { status: run.status, output: `${run.stdout}${run.stderr}` };
    },
    ghCalls() {
      const log = join(ghState, 'calls.log');
      return existsSync(log)
        ? readFileSync(log, 'utf8')
            .split('\n')
            .filter((line) => line !== '')
        : [];
    },
    remoteTip() {
      const result = spawnSync('git', ['ls-remote', remote, `refs/heads/${BRANCH}`], {
        encoding: 'utf8',
        timeout: 30_000,
        env: neutralEnv(),
      });
      return (result.stdout ?? '').split(/\s+/)[0] ?? '';
    },
    remoteBaseline() {
      gitText(dir, ['fetch', '-q', PUSH_URL, `refs/heads/${BRANCH}`]);
      return JSON.parse(gitText(dir, ['show', 'FETCH_HEAD:test-count-baseline.json']));
    },
  };
}

it('create отказал, и это не «уже открыт» (настройка Actions выключена) — шаг красный: exit 1, причина дословно, действие человека', () => {
  const repo = ratchetRepo();
  writeFileSync(join(repo.ghState, 'create-refused'), '');
  repo.night(718);

  const run = repo.runStep();

  expect(run.status).toBe(1);
  expect(run.output).toContain(REFUSED);
  expect(run.output).toContain('ветка chore/test-count-ratchet обновлена — PR открывает человек');
  expect(run.output).toContain('gh pr create --base main --head chore/test-count-ratchet');
  expect(run.output).not.toContain('уже открыт');
  // Сообщение говорит правду: ветка и правда обновлена.
  expect(repo.remoteBaseline()).toEqual({ 'reports/vitest-hooks.json': 718 });
}, 30_000);

it('PR уже открыт — ветка обновлена без удаления, create не вызывается, шаг зелёный', () => {
  const repo = ratchetRepo();
  writeFileSync(join(repo.ghState, 'create-refused'), '');
  repo.night(700);
  expect(repo.runStep().status).toBe(1);
  const nightOne = repo.remoteTip();
  expect(nightOne).not.toBe('');
  const callsAfterNightOne = repo.ghCalls().length;

  // Ночь 2: человек открыл PR, тестов стало больше.
  writeFileSync(
    join(repo.ghState, 'pr-list.json'),
    JSON.stringify([{ number: 7, url: 'https://github.com/org/repo/pull/7' }]),
  );
  rmSync(join(repo.ghState, 'create-refused'));
  repo.night(718);

  const run = repo.runStep();

  expect(run.status).toBe(0);
  expect(run.output).toContain('PR #7 уже открыт');
  expect(run.output).toContain('https://github.com/org/repo/pull/7');
  // Журнал вызовов накопительный: смотрим только на ночь 2.
  expect(repo.ghCalls().slice(callsAfterNightOne).join('\n')).not.toContain('pr create');
  expect(gitText(repo.dir, ['rev-parse', '--verify', `${repo.remoteTip()}^`])).toBe(nightOne);
  expect(repo.remoteBaseline()).toEqual({ 'reports/vitest-hooks.json': 718 });
}, 30_000);

it('create удался — PR создан, шаг зелёный', () => {
  const repo = ratchetRepo();
  repo.night(300);

  const run = repo.runStep();

  expect(run.status).toBe(0);
  expect(run.output).toContain('https://github.com/org/repo/pull/42');
  expect(repo.ghCalls().join('\n')).toContain('pr create');
}, 30_000);

it('push отклонён — шаг красный с причиной дословно, без «уже открыт» и без create', () => {
  const repo = ratchetRepo();
  const hook = join(repo.remote, 'hooks', 'pre-receive');
  writeFileSync(hook, '#!/bin/sh\necho "remote: rejected by test pre-receive" >&2\nexit 1\n', {
    mode: 0o755,
  });
  repo.night(300);

  const run = repo.runStep();

  expect(run.status).toBe(1);
  expect(run.output).toContain('rejected by test pre-receive');
  expect(run.output).not.toContain('уже открыт');
  expect(repo.remoteTip()).toBe('');
  expect(repo.ghCalls().join('\n')).not.toContain('pr create');
}, 30_000);

it('ветка прошлой ночи осталась без PR — заменена коммитом поверх текущего main', () => {
  const repo = ratchetRepo();
  writeFileSync(join(repo.ghState, 'create-refused'), '');
  repo.night(300);
  expect(repo.runStep().status).toBe(1);
  const nightOne = repo.remoteTip();

  // main уехал вперёд (squash-merge чужого PR), PR по ветке так и нет.
  writeFileSync(join(repo.dir, 'other.txt'), 'x');
  gitText(repo.dir, ['add', 'other.txt']);
  gitText(repo.dir, ['commit', '-qm', 'main moved']);
  const mainHead = gitText(repo.dir, ['rev-parse', 'HEAD']);
  repo.night(320);
  expect(repo.runStep().status).toBe(1);

  const tip = repo.remoteTip();
  expect(tip).not.toBe(nightOne);
  expect(gitText(repo.dir, ['rev-parse', '--verify', `${tip}^`])).toBe(mainHead);
}, 30_000);

it('gh pr list не ответил — шаг красный, ветка не тронута, create не вызывался', () => {
  const repo = ratchetRepo();
  writeFileSync(join(repo.ghState, 'list-fails'), '');
  repo.night(300);

  const run = repo.runStep();

  expect(run.status).toBe(1);
  expect(run.output).toContain('HTTP 502');
  expect(run.output).not.toContain('уже открыт');
  expect(repo.remoteTip()).toBe('');
  expect(repo.ghCalls().join('\n')).not.toContain('pr create');
}, 30_000);

it('базлайн актуален — шаг зелёный, gh не вызывался', () => {
  const repo = ratchetRepo();

  const run = repo.runStep();

  expect(run.status).toBe(0);
  expect(run.output).toContain('Базлайн актуален');
  expect(repo.ghCalls()).toEqual([]);
  expect(repo.remoteTip()).toBe('');
}, 30_000);
