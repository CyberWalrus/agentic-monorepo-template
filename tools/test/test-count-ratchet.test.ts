/**
 * Канарейка a10: update поднимает базлайн до факта и отказывается понижать;
 * nightly-джоб храповика на месте; правило «поднимает автоматика» в архитектуре.
 *
 * Канарейки e40 «PR создан или громкая ошибка» (критерий приёмки): шаг
 * «PR with raised baseline» исполняется тем текстом, что читает runner из
 * nightly.yml, — в подставном репозитории: bare-репозиторий вместо github.com
 * (url.insteadOf подменяет URL команды) и подставной gh на PATH; git на PATH —
 * обёртка, пишущая argv и конфиг-окружение каждого вызова. Отказ create,
 * который не «PR уже открыт», обязан краснить шаг: замаскированный `|| echo`
 * ловится исполнением шага, а не поиском подстроки.
 *
 * Канарейки e85 «PR создан и CI на нём запущен или громкая ошибка»: после
 * create (и после push под открытым PR) шаг диспатчит ci.yml на ветку
 * храповика — отказ диспатча краснит шаг с причиной дословно и командой
 * человека; зелёный вывод называет остаточное событие человека для
 * gate-integrity (маршрут (б1)). Подставной gh отказывает по файлам
 * create-refused и dispatch-refused, команду вне списка — кодом 99.
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

/** Блок джобы без строк-комментариев: комментарий — не шаг и не needs. */
function jobCodeLines(jobName: string): string[] {
  return jobLines(jobName).filter((line) => !line.trimStart().startsWith('#'));
}

/**
 * `needs` джобы — только записи массива (в квадратных скобках или списком
 * `- …`), без комментариев. Комментарий job со словом из needs (в report над
 * needs лежит «# test-count-ratchet (e40): …») проводкой не считается: поиск
 * слова по тексту блока оставлял мутант «убрать джобу из needs» зелёным.
 */
function jobNeeds(jobName: string): string[] {
  const lines = jobCodeLines(jobName);
  const start = lines.findIndex((line) => /^\s+needs:/.test(line));
  if (start === -1) {
    return [];
  }
  const needIndent = indentOf(lines[start] ?? '');
  const body: string[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    // Комментарий в конце строки («needs: [a]  # …») — тоже не запись.
    const code = line.replace(/\s+#.*$/, '').trim();
    if (index > start && code !== '' && indentOf(line) <= needIndent) {
      break;
    }
    body.push(code);
  }
  const text = body.join(' ').replace(/^needs:\s*/, '');
  const items = text.includes('[')
    ? text.slice(text.indexOf('[') + 1, text.lastIndexOf(']')).split(',')
    : body.slice(1).map((item) => item.replace(/^-\s*/, ''));
  return items.map((item) => item.trim().replace(/^['"]|['"]$/g, '')).filter((item) => item !== '');
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
  // Комментарии job в проверку не входят: слово в комментарии — не шаг и не needs.
  const job = jobCodeLines('test-count-ratchet').join('\n');
  const hooks = job.indexOf('turbo run test:hooks');
  expect(hooks).toBeGreaterThanOrEqual(0);
  expect(hooks).toBeLessThan(job.indexOf('test:count:update'));
  // report заводит issue только по джобам из needs — иначе красный шаг молчит.
  // Сверяются записи массива needs, а не текст блока: над needs лежит комментарий
  // со словом test-count-ratchet, и поиск по блоку не замечал, что джобы в needs нет.
  expect(jobNeeds('report')).toContain('test-count-ratchet');
});

it('проводка e85: джоба храповика имеет право actions: write — без него диспатч ci.yml отклоняют', () => {
  expect(jobCodeLines('test-count-ratchet').join('\n')).toMatch(/^ {6}actions: write\b/m);
});

const BRANCH = 'chore/test-count-ratchet';
// Скрипт ходит на github.com; insteadOf в подставном клоне уводит команду в
// bare-репозиторий. Токен в URL не ходит (e67): авторизация — конфиг-окружением
// git (GIT_CONFIG_*), заголовок скрипт собирает из GH_TOKEN.
const REMOTE_URL = 'https://github.com/org/repo.git';
const TOKEN = 'tok';
/** Так шаг ходил на remote до перевода на конфиг-окружение — токен в argv. */
const TOKEN_URL = `https://x-access-token:${TOKEN}@github.com/org/repo.git`;
/** Запись лога вызова git: конфиг-окружение с заголовком для токена фикстуры. */
const AUTH_CONFIG = `1|http.https://github.com/.extraheader|AUTHORIZATION: basic ${Buffer.from(
  `x-access-token:${TOKEN}`,
).toString('base64')}`;
/** Подкоманда git по argv: опции git (-c …) отброшены. */
const gitSubcommand = (argv: string): string =>
  argv.replace(/^(?:-c \S+ )+/, '').split(' ')[0] ?? '';
const REFUSED =
  'gh: pull request create failed: GraphQL: GitHub Actions is not permitted to create or approve pull requests (createPullRequest)';
/** Отказ диспатча: у джобы нет права actions: write. */
const DISPATCH_REFUSED =
  'gh: HTTP 403: Resource not accessible by integration (https://api.github.com/repos/org/repo/actions/workflows/ci%2Eyml/dispatches)';
/** Вызов диспатча ci.yml на ветку храповика — как его пишет подставной gh в calls.log. */
const DISPATCH_CALL = 'workflow run ci.yml --repo org/repo --ref chore/test-count-ratchet';

let prCounter = 0;

/** Глобальный и системный git-конфиг машины (gpgsign, hooksPath) не должен влиять на фикстуру. */
function neutralEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    // Фикстура не выходит в сеть: git-у разрешён только file-транспорт
    // (любой https-адрес, не переписанный insteadOf, отклоняется им же).
    GIT_ALLOW_PROTOCOL: 'file',
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
  "workflow run")
    if [ -f "$FAKE_GH_DIR/dispatch-refused" ]; then
      echo "${DISPATCH_REFUSED}" >&2
      exit 1
    fi
    ;;
  *)
    echo "fake gh: unexpected call: $*" >&2
    exit 99
    ;;
esac
`;

/** Строки лога без пустых; файла нет — пусто. */
function readLog(path: string): string[] {
  return existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
    : [];
}

/** Настоящий git для обёртки: первый в PATH машины, вне подставного bin. */
const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
if (realGit === '') {
  throw new Error('git не найден в PATH — фикстура e40 не соберётся.');
}

const FAKE_GIT = `#!/bin/sh
# Обёртка git (e40): argv и конфиг-окружение вызова — в git-calls.log, затем настоящий git.
# Токен фикстуры фиктивный, поэтому значение конфигурации пишется целиком.
printf 'argv:%s\\nconfig:%s|%s|%s\\n' "$*" "\${GIT_CONFIG_COUNT:-}" "\${GIT_CONFIG_KEY_0:-}" "\${GIT_CONFIG_VALUE_0:-}" >> "$FAKE_GH_DIR/git-calls.log"
exec "${realGit}" "$@"
`;

interface RatchetRepo {
  /** Клон на main: здесь ночная джоба делает update и исполняет шаг. */
  dir: string;
  /** Bare-репозиторий — «remote» вместо github.com. */
  remote: string;
  /** Состояние подставного gh: pr-list.json, create-refused, list-fails, dispatch-refused. */
  ghState: string;
  /** Одна ночь: свежий main, отчёт hooks, pnpm test:count:update. */
  night(hooksTests: number): void;
  runStep(): { status: number | null; output: string };
  ghCalls(): string[];
  /** Вызовы git, порождённые шагом: argv и конфиг-окружение каждого. */
  gitCalls(): { argv: string; config: string }[];
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
  gitText(dir, ['config', `url.${remote}.insteadOf`, REMOTE_URL]);
  // Саботаж «токен возвращён в URL» уводится в тот же bare-репозиторий: тест
  // краснеет по argv, а не по отказу транспорта.
  gitText(dir, ['config', '--add', `url.${remote}.insteadOf`, TOKEN_URL]);
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
  writeFileSync(join(bin, 'git'), FAKE_GIT, { mode: 0o755 });
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
      return readLog(log);
    },
    gitCalls() {
      const lines = readLog(join(ghState, 'git-calls.log'));
      return lines.flatMap((line, index) => {
        const config = lines[index + 1] ?? '';
        return line.startsWith('argv:') && config.startsWith('config:')
          ? [{ argv: line.slice('argv:'.length), config: config.slice('config:'.length) }]
          : [];
      });
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
      gitText(dir, ['fetch', '-q', REMOTE_URL, `refs/heads/${BRANCH}`]);
      return JSON.parse(gitText(dir, ['show', 'FETCH_HEAD:test-count-baseline.json']));
    },
  };
}

it('create отказал, и это не «уже открыт» — шаг красный: exit 1, причина дословно, действие человека', () => {
  const repo = ratchetRepo();
  writeFileSync(join(repo.ghState, 'create-refused'), '');
  repo.night(718);

  const run = repo.runStep();

  expect(run.status).toBe(1);
  expect(run.output).toContain(REFUSED);
  // Первая ночь: ветки на remote не было — действие человека называет «создана».
  expect(run.output).toContain('ветка chore/test-count-ratchet создана — PR открывает человек');
  expect(run.output).toContain('gh pr create --base main --head chore/test-count-ratchet');
  expect(run.output).not.toContain('уже открыт');
  // Сообщение говорит правду: ветка и правда создана — с поднятым базлайном.
  expect(repo.remoteBaseline()).toEqual({ 'reports/vitest-hooks.json': 718 });
  // PR откроет человек — его событие opened запустит проверки само: ни диспатча
  // (e85: диспатч — только с существующим PR), ни заметок о CI и gate-integrity.
  expect(repo.ghCalls().join('\n')).not.toContain('workflow run');
  expect(run.output).not.toContain('CI (ci.yml)');
  expect(run.output).not.toContain('gate-integrity и bundle-approval');
}, 30_000);

it('PR уже открыт — ветка обновлена без удаления, create не вызывается, CI запущен диспатчем, шаг зелёный', () => {
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
  expect(run.output).toContain('PR #7 уже открыт — ветка chore/test-count-ratchet обновлена');
  expect(run.output).toContain('https://github.com/org/repo/pull/7');
  // Push сделал github.token — события от него workflow не рождают: шаг сам
  // запускает CI на новом head SHA (e85, маршрут (а)) и называет остаточное
  // событие человека для доверенного gate-integrity (маршрут (б1)), а не молчит
  // за зелёным exit 0.
  expect(run.output).toContain('CI (ci.yml) на head SHA запущен диспатчем');
  expect(run.output).toContain('gate-integrity и bundle-approval автоматика не запускает');
  expect(run.output).toContain('закрыть и снова открыть PR');
  // Журнал вызовов накопительный: смотрим только на ночь 2.
  const nightTwo = repo.ghCalls().slice(callsAfterNightOne);
  expect(nightTwo.join('\n')).not.toContain('pr create');
  expect(nightTwo.filter((call) => call.startsWith('workflow run'))).toEqual([DISPATCH_CALL]);
  expect(gitText(repo.dir, ['rev-parse', '--verify', `${repo.remoteTip()}^`])).toBe(nightOne);
  expect(repo.remoteBaseline()).toEqual({ 'reports/vitest-hooks.json': 718 });
}, 30_000);

it('create удался — PR создан, CI запущен диспатчем на ветку храповика, шаг зелёный', () => {
  const repo = ratchetRepo();
  repo.night(300);

  const run = repo.runStep();

  expect(run.status).toBe(0);
  expect(run.output).toContain('PR храповика создан: https://github.com/org/repo/pull/42');
  expect(run.output).toContain('CI (ci.yml) на head SHA запущен диспатчем');
  expect(run.output).toContain('gate-integrity и bundle-approval автоматика не запускает');
  const calls = repo.ghCalls();
  // Диспатч — ровно один и после create: диспатч ветки без PR гонял бы CI впустую.
  expect(calls.filter((call) => call.startsWith('workflow run'))).toEqual([DISPATCH_CALL]);
  const createAt = calls.findIndex((call) => call.startsWith('pr create'));
  expect(createAt).toBeGreaterThanOrEqual(0);
  expect(createAt).toBeLessThan(calls.indexOf(DISPATCH_CALL));
  // «PR не одобряет сам себя» (e85, п. 4): с включённой настройкой право
  // pull-requests: write позволяет и одобрить PR — шаг зовёт gh только этими
  // командами (подставной gh отвечает 99 на любую другую).
  expect(calls.filter((call) => !/^(pr list|pr create|workflow run ci\.yml) /.test(call))).toEqual(
    [],
  );
  // Токен — только в env шага: в argv вызовов gh его нет.
  expect(calls.join('\n')).not.toContain(TOKEN);
}, 30_000);

it('диспатч ci.yml отказал после create — шаг красный: PR создан, причина дословно, команда человека (e85)', () => {
  const repo = ratchetRepo();
  writeFileSync(join(repo.ghState, 'dispatch-refused'), '');
  repo.night(300);

  const run = repo.runStep();

  expect(run.status).toBe(1);
  // PR создан и поднятие опубликовано — вывод говорит правду о состоянии.
  expect(run.output).toContain('PR храповика создан: https://github.com/org/repo/pull/42');
  expect(repo.remoteBaseline()).toEqual({ 'reports/vitest-hooks.json': 300 });
  // «PR создан или громкая ошибка» распространён на запуск CI: отказ — не
  // зелёный шаг с PR без проверок, а причина дословно и действие человека.
  expect(run.output).toContain('CI (ci.yml) на head SHA не запущен');
  expect(run.output).toContain(DISPATCH_REFUSED);
  expect(run.output).not.toContain('CI (ci.yml) на head SHA запущен диспатчем');
  expect(run.output).toContain(`Дальше человек: запусти CI на ветке PR — gh ${DISPATCH_CALL}`);
  // Остаточное событие для gate-integrity названо и в красном выводе.
  expect(run.output).toContain('gate-integrity и bundle-approval автоматика не запускает');
  expect(repo.ghCalls().filter((call) => call.startsWith('workflow run'))).toEqual([DISPATCH_CALL]);
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
  // Сообщение говорит правду о ветке (находка ревью): ветки на remote нет, и
  // действие человека называет её состояние — «обновлена» была бы ложью.
  expect(run.output).toContain('ветка chore/test-count-ratchet не создана: поднятие не потеряно');
  expect(run.output).not.toContain('ветка chore/test-count-ratchet обновлена');
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
  const run = repo.runStep();

  expect(run.status).toBe(1);
  // Сообщение говорит правду (находка ревью): действие человека называет
  // состояние ветки по факту — «удалена и не пересоздана» рядом с командой на
  // эту же ветку читалось бы как потерянное поднятие.
  expect(run.output).toContain(
    'ветка chore/test-count-ratchet заменена коммитом поверх main — PR открывает человек',
  );
  expect(run.output).not.toContain('не пересоздана');

  const tip = repo.remoteTip();
  expect(tip).not.toBe(nightOne);
  expect(gitText(repo.dir, ['rev-parse', '--verify', `${tip}^`])).toBe(mainHead);
}, 30_000);

it('ветка прошлой ночи без PR: удаление прошло, push отклонён — «удалена и не пересоздана»', () => {
  const repo = ratchetRepo();
  writeFileSync(join(repo.ghState, 'create-refused'), '');
  repo.night(300);
  expect(repo.runStep().status).toBe(1);
  expect(repo.remoteTip()).not.toBe('');
  const callsAfterNightOne = repo.ghCalls().length;

  // Ночь 2: remote принимает удаление (новое значение ссылки — нули) и
  // отклоняет любое иное.
  const deleted = '0'.repeat(40);
  writeFileSync(
    join(repo.remote, 'hooks', 'pre-receive'),
    `#!/bin/sh\nwhile read -r old new ref; do [ "$new" = ${deleted} ] || exit 1; done\n`,
    { mode: 0o755 },
  );
  repo.night(320);

  const run = repo.runStep();

  expect(run.status).toBe(1);
  // Сообщение говорит правду (находка ревью): старая ветка удалена, новая не
  // прошла — действие человека называет ровно это состояние.
  expect(run.output).toContain(
    'ветка chore/test-count-ratchet удалена и не пересоздана: поднятие не потеряно',
  );
  expect(repo.remoteTip()).toBe('');
  // Журнал вызовов накопительный: смотрим только на ночь 2.
  expect(repo.ghCalls().slice(callsAfterNightOne).join('\n')).not.toContain('pr create');
}, 30_000);

it('PR уже открыт, push отклонён — «не обновлена», шаг красный без create', () => {
  const repo = ratchetRepo();
  writeFileSync(join(repo.ghState, 'create-refused'), '');
  repo.night(300);
  expect(repo.runStep().status).toBe(1);
  const nightOne = repo.remoteTip();

  // Ночь 2: человек открыл PR, remote отклоняет push.
  writeFileSync(
    join(repo.remote, 'hooks', 'pre-receive'),
    '#!/bin/sh\necho "remote: rejected by test pre-receive" >&2\nexit 1\n',
    { mode: 0o755 },
  );
  writeFileSync(
    join(repo.ghState, 'pr-list.json'),
    JSON.stringify([{ number: 7, url: 'https://github.com/org/repo/pull/7' }]),
  );
  const callsAfterNightOne = repo.ghCalls().length;
  repo.night(320);

  const run = repo.runStep();

  expect(run.status).toBe(1);
  // Сообщение говорит правду (находка ревью): push отклонён — ветка не
  // обновлена, и действие человека не утверждает обратное.
  expect(run.output).toContain('ветка chore/test-count-ratchet не обновлена: поднятие не потеряно');
  expect(repo.remoteTip()).toBe(nightOne);
  expect(repo.ghCalls().slice(callsAfterNightOne).join('\n')).not.toContain('pr create');
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

it('токен не в argv git: авторизация — конфиг-окружением, и только у команд на remote (e67)', () => {
  const repo = ratchetRepo();
  writeFileSync(join(repo.ghState, 'create-refused'), '');

  // Ночь 1: ветки нет — ls-remote и push. Ночь 2: ветка прошлой ночи без PR —
  // ls-remote, push --delete и push.
  repo.night(700);
  expect(repo.runStep().status).toBe(1);
  repo.night(718);
  expect(repo.runStep().status).toBe(1);

  // Ночь 3: человек открыл PR — fetch и push.
  writeFileSync(
    join(repo.ghState, 'pr-list.json'),
    JSON.stringify([{ number: 7, url: 'https://github.com/org/repo/pull/7' }]),
  );
  repo.night(740);
  expect(repo.runStep().status).toBe(0);

  const calls = repo.gitCalls();
  const onRemote = calls.filter(({ argv }) => argv.includes(REMOTE_URL));
  // Все команды шага на remote исполнялись — каждая несла URL без токена.
  expect(new Set(onRemote.map(({ argv }) => gitSubcommand(argv)))).toEqual(
    new Set(['fetch', 'ls-remote', 'push']),
  );
  expect(onRemote.some(({ argv }) => argv.includes('--delete'))).toBe(true);
  for (const { argv } of calls) {
    expect(argv).not.toMatch(/x-access-token|:tok@/);
  }
  // Авторизация — конфиг-окружением, и только у команд на remote: локальный git
  // (diff, rev-parse, коммит) токена не получает.
  expect(calls.filter(({ config }) => config === AUTH_CONFIG)).toEqual(onRemote);
}, 30_000);
