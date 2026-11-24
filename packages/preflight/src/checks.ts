/**
 * Проверки окружения `pnpm preflight` (задача e4). Каждая проверка отвечает
 * на «что не так и какой командой исправить»; предупреждения (режим
 * обслуживания, gh) сообщают, но команду красным не делают.
 *
 * Логика отделена от CLI (cli.ts) зависимостями PreflightEnv: тесты подставляют
 * фальшивые команды и файлы, поэтому сообщения каждой проверки проверяются без
 * реального Docker и без подмены версии Node — на самом низком уровне, где
 * поведение наблюдаемо. preflight — не гейт: в verify не входит и ничего не
 * блокирует (решение — в файле задачи e4).
 */
import { join, resolve } from 'node:path';

export type CheckId =
  | 'node'
  | 'pnpm'
  | 'node_modules'
  | 'git-hooks'
  | 'docker'
  | 'chromium'
  | 'maintenance-mode'
  | 'gh';

export type CheckLevel = 'error' | 'warning';

export interface CommandResult {
  /** Код выхода; null — процесс убит по таймауту. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Исполняемый не найден (ENOENT). */
  missing: boolean;
  /** Превышен таймаут — процесс убит. */
  timedOut: boolean;
}

/** Запуск внешней команды; cwd — каталог запуска (корень, если не задан). */
export type RunCommand = (
  command: string,
  args: string[],
  timeoutMs: number,
  cwd?: string,
) => Promise<CommandResult>;

export interface PreflightEnv {
  /** Корень checkout/worktree: здесь ищутся .nvmrc, package.json, .claude. */
  root: string;
  platform: NodeJS.Platform;
  /** Версия запущенного Node (process.versions.node). */
  nodeVersion: string;
  runCommand: RunCommand;
  fileExists: (path: string) => boolean;
  /** undefined — файла нет или не читается. */
  readTextFile: (path: string) => string | undefined;
}

export interface CheckOutcome {
  id: CheckId;
  ok: boolean;
  level: CheckLevel;
  /** Что обнаружено — короткая строка для человека. */
  detail: string;
  /** Что не так; пусто у зелёной проверки. */
  problem: string;
  /** Какой командой исправить; пусто, если исправление — не команда. */
  fix: string;
}

export interface PreflightReport {
  /** Все error-проверки зелёные; предупреждения не считаются. */
  ok: boolean;
  /** В стабильном порядке CHECK_ORDER — чтобы --json диффовался между прогонами. */
  checks: CheckOutcome[];
}

const outcome = (
  id: CheckId,
  level: CheckLevel,
  ok: boolean,
  detail: string,
  problem = '',
  fix = '',
): CheckOutcome => ({ id, level, ok, detail, problem, fix });

/** Порядок проверок в выводе и в --json. */
export const CHECK_ORDER: readonly CheckId[] = [
  'node',
  'pnpm',
  'node_modules',
  'git-hooks',
  'docker',
  'chromium',
  'maintenance-mode',
  'gh',
];

/** Читает путь относительно корня; абсолютный путь проходит как есть. */
const fromRoot = (env: PreflightEnv, path: string): string => resolve(env.root, path);

/**
 * Сниппет для резолва Chromium той же версией Playwright, что стоит в e2e:
 * путь браузера зависит от сборки, поэтому не хардкодим — спрашиваем реестр.
 * cwd у запуска — <root>/e2e, где объявлен @playwright/test.
 */
const CHROMIUM_PATH_SNIPPET =
  "import('@playwright/test').then((m) => console.log(m.chromium.executablePath())).catch((error) => { console.error(String(error)); process.exit(1); })";

function parseNvmrc(raw: string): string {
  return raw.trim().replace(/^v/, '');
}

/** «26» соответствует 26.13.0: сравниваем только названные в .nvmrc сегменты. */
function versionMatches(actual: string, expected: string): boolean {
  const actualSegments = actual.split('.');
  return expected.split('.').every((segment, index) => actualSegments[index] === segment);
}

interface PackageManagerSpec {
  name: string;
  version: string;
}

function parsePackageManager(value: string): PackageManagerSpec | null {
  const at = value.lastIndexOf('@');
  if (at <= 0) {
    return null;
  }
  return { name: value.slice(0, at), version: value.slice(at + 1) };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function readRootJson(env: PreflightEnv, path: string): Record<string, unknown> | null {
  const text = env.readTextFile(path);
  if (text === undefined) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function checkNode(env: PreflightEnv): Promise<CheckOutcome> {
  const raw = env.readTextFile('.nvmrc');
  if (raw === undefined) {
    return outcome(
      'node',
      'error',
      false,
      '.nvmrc не найден',
      '.nvmrc не найден — ожидаемая версия Node не зафиксирована',
    );
  }
  const expected = parseNvmrc(raw);
  if (versionMatches(env.nodeVersion, expected)) {
    return outcome(
      'node',
      'error',
      true,
      `Node v${env.nodeVersion} соответствует .nvmrc (${expected})`,
    );
  }
  return outcome(
    'node',
    'error',
    false,
    `Node v${env.nodeVersion}`,
    `Node v${env.nodeVersion}, а .nvmrc требует ${expected} — падает typecheck и сборка`,
    'nvm use',
  );
}

async function checkPnpm(env: PreflightEnv): Promise<CheckOutcome> {
  const manifest = readRootJson(env, 'package.json');
  const declared =
    typeof manifest?.['packageManager'] === 'string' ? manifest['packageManager'] : '';
  const spec = declared !== '' ? parsePackageManager(declared) : null;
  if (spec === null) {
    return outcome(
      'pnpm',
      'error',
      false,
      'packageManager не объявлен',
      'в package.json нет поля packageManager — версия pnpm не зафиксирована',
    );
  }
  if (spec.name !== 'pnpm') {
    return outcome(
      'pnpm',
      'error',
      false,
      'packageManager указывает не на pnpm',
      `packageManager объявляет ${declared} — репозиторий рассчитан на pnpm`,
    );
  }
  const installed = await env.runCommand('pnpm', ['--version'], 30_000);
  const version = installed.stdout.trim();
  if (installed.missing) {
    return outcome(
      'pnpm',
      'error',
      false,
      'pnpm не найден',
      `pnpm не найден в PATH, а packageManager требует ${declared}`,
      `npm install -g pnpm@${spec.version}`,
    );
  }
  if (installed.code !== 0) {
    return outcome(
      'pnpm',
      'error',
      false,
      'pnpm не отвечает',
      `pnpm --version завершился с кодом ${installed.code}`,
      `npm install -g pnpm@${spec.version}`,
    );
  }
  if (version === spec.version) {
    return outcome('pnpm', 'error', true, `pnpm ${version} соответствует packageManager`);
  }
  return outcome(
    'pnpm',
    'error',
    false,
    `pnpm ${version}`,
    `pnpm ${version}, а packageManager требует ${declared} — каталог и lockfile рассчитаны на ${spec.version}`,
    `npm install -g pnpm@${spec.version}`,
  );
}

/** Код ошибки pnpm в stderr (`ERR_PNPM_…`); null — pnpm кода не назвал. */
const pnpmErrorCode = (stderr: string): string | null =>
  /\bERR_PNPM_[A-Z0-9_]+\b/.exec(stderr)?.[0] ?? null;

/**
 * `pnpm install` из песочницы агента падает на первом шаге: pnpm держит блокировки
 * хранилища в `/tmp/pnpm-store-operation-locks-<uid>`, вне гранта песочницы, и берёт
 * блокировку даже при установке без изменений — проверка слепа в любой песочнице
 * (ADR 0004, «pnpm install из песочницы»). Сигнатура — код блокировки плюс EPERM:
 * та же ошибка без «Operation not permitted» — не песочница, а права на каталог.
 */
const SANDBOX_STORE_LOCK = 'ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK';
const SANDBOX_EPERM = 'Operation not permitted';

async function checkNodeModules(env: PreflightEnv): Promise<CheckOutcome> {
  // Замороженная установка — собственная проверка pnpm на соответствие
  // node_modules и lockfile: при синхроне это no-op (доли секунды), при
  // дрейфе — ненулевой код без мутаций окружения. Заодно подкатывает
  // отсутствующий node_modules на свежем клоне. В песочнице агента установка
  // падает на блокировке хранилища — это сообщение о песочнице, не о дрейфе.
  const result = await env.runCommand(
    'pnpm',
    ['install', '--frozen-lockfile', '--reporter=silent'],
    120_000,
  );
  if (result.missing) {
    return outcome(
      'node_modules',
      'error',
      false,
      'pnpm не найден',
      'pnpm не найден в PATH — соответствие node_modules и lockfile не проверить',
    );
  }
  if (result.timedOut) {
    return outcome(
      'node_modules',
      'error',
      false,
      'pnpm install не уложился в таймаут',
      'pnpm install --frozen-lockfile не завершился за 120 с',
      'pnpm install',
    );
  }
  if (result.code === 0) {
    return outcome('node_modules', 'error', true, 'node_modules соответствует lockfile');
  }
  const errorCode = pnpmErrorCode(result.stderr);
  if (errorCode === SANDBOX_STORE_LOCK && result.stderr.includes(SANDBOX_EPERM)) {
    return outcome(
      'node_modules',
      'error',
      false,
      'соответствие node_modules и lockfile не проверить: pnpm install блокирует песочница агента',
      `${errorCode}: песочница агента не даёт pnpm открыть блокировку хранилища (/tmp/pnpm-store-operation-locks-<uid>) — это не дрейф lockfile, повтор внутри песочницы не поможет (ADR 0004)`,
      'pnpm install --frozen-lockfile вне песочницы агента — в своём терминале',
    );
  }
  return outcome(
    'node_modules',
    'error',
    false,
    'node_modules не соответствует lockfile',
    `pnpm install --frozen-lockfile завершился с кодом ${result.code}${errorCode === null ? '' : `: ${errorCode}`}`,
    'pnpm install',
  );
}

async function checkGitHooks(env: PreflightEnv): Promise<CheckOutcome> {
  const git = await env.runCommand('git', ['rev-parse', '--git-path', 'hooks'], 10_000);
  if (git.missing || git.code !== 0) {
    return outcome(
      'git-hooks',
      'error',
      false,
      'git-хуки не проверить',
      git.missing
        ? 'git не найден в PATH'
        : 'git rev-parse --git-path hooks завершился с ошибкой — это не git-репозиторий?',
      'git init',
    );
  }
  const hooksDir = fromRoot(env, git.stdout.trim());
  const missing: string[] = [];
  for (const hook of ['pre-commit', 'pre-push']) {
    const content = env.readTextFile(join(hooksDir, hook));
    if (content === undefined || !content.includes('lefthook')) {
      missing.push(hook);
    }
  }
  if (missing.length === 0) {
    return outcome('git-hooks', 'error', true, `хуки Lefthook установлены (${git.stdout.trim()})`);
  }
  return outcome(
    'git-hooks',
    'error',
    false,
    `хуки Lefthook не установлены (${git.stdout.trim()})`,
    `нет ${missing.map((hook) => `${hook} с lefthook`).join(' и ')} — проверки L1/L2 молча не работают`,
    'pnpm exec lefthook install',
  );
}

async function checkDocker(env: PreflightEnv): Promise<CheckOutcome> {
  const startFix = env.platform === 'darwin' ? 'open -a Docker' : 'sudo systemctl start docker';
  const installFix =
    env.platform === 'darwin' ? 'brew install --cask docker' : 'apt-get install docker.io';
  const docker = await env.runCommand('docker', ['info'], 15_000);
  if (docker.missing) {
    return outcome(
      'docker',
      'error',
      false,
      'docker не найден',
      'docker не найден в PATH — интеграционные тесты (Testcontainers) и pnpm visual не запустятся',
      installFix,
    );
  }
  if (docker.code === 0) {
    return outcome('docker', 'error', true, 'Docker отвечает');
  }
  const reason = docker.timedOut ? 'не ответил за 15 с' : `демон не отвечает (код ${docker.code})`;
  return outcome(
    'docker',
    'error',
    false,
    'Docker не отвечает',
    `Docker ${reason} — pnpm verify (Testcontainers) и pnpm visual упадут`,
    startFix,
  );
}

async function checkChromium(env: PreflightEnv): Promise<CheckOutcome> {
  const result = await env.runCommand(
    process.execPath,
    ['-e', CHROMIUM_PATH_SNIPPET],
    30_000,
    join(env.root, 'e2e'),
  );
  if (result.missing || result.code !== 0) {
    return outcome(
      'chromium',
      'error',
      false,
      'Chromium не проверить',
      '@playwright/test не резолвится из e2e/ — сначала нужны зависимости',
      'pnpm install',
    );
  }
  const executable = result.stdout.trim();
  if (!env.fileExists(executable)) {
    return outcome(
      'chromium',
      'error',
      false,
      `Chromium не скачан (${executable})`,
      `Chromium не скачан (${executable}) — browser-mode unit тесты и e2e упадут`,
      'pnpm exec playwright install --with-deps chromium',
    );
  }
  return outcome('chromium', 'error', true, 'Chromium установлен (реестр Playwright)');
}

async function checkMaintenanceMode(env: PreflightEnv): Promise<CheckOutcome> {
  if (!env.fileExists('.claude/settings.local.json')) {
    return outcome('maintenance-mode', 'warning', true, 'режим обслуживания выключен');
  }
  return outcome(
    'maintenance-mode',
    'warning',
    false,
    'режим обслуживания включён',
    'режим обслуживания включён (.claude/settings.local.json существует): хуки и песочница отключены — работает только в worktree задачи (ADR 0009)',
    'удали .claude/settings.local.json после работы',
  );
}

async function checkGh(env: PreflightEnv): Promise<CheckOutcome> {
  const gh = await env.runCommand('gh', ['auth', 'status'], 15_000);
  if (gh.missing) {
    return outcome(
      'gh',
      'warning',
      false,
      'gh не найден',
      'gh не установлен — pnpm backlog doctor неполон',
      env.platform === 'darwin' ? 'brew install gh' : 'установи gh (cli.github.com)',
    );
  }
  if (gh.code === 0) {
    return outcome('gh', 'warning', true, 'gh авторизован');
  }
  return outcome(
    'gh',
    'warning',
    false,
    'gh не авторизован',
    'gh установлен, но не авторизован — pnpm backlog doctor неполон',
    'gh auth login',
  );
}

const CHECKS: ReadonlyArray<{ id: CheckId; run: (env: PreflightEnv) => Promise<CheckOutcome> }> = [
  { id: 'node', run: checkNode },
  { id: 'pnpm', run: checkPnpm },
  { id: 'node_modules', run: checkNodeModules },
  { id: 'git-hooks', run: checkGitHooks },
  { id: 'docker', run: checkDocker },
  { id: 'chromium', run: checkChromium },
  { id: 'maintenance-mode', run: checkMaintenanceMode },
  { id: 'gh', run: checkGh },
];

/** Прогоняет все проверки параллельно — здоровое окружение укладывается в секунду. */
export async function runPreflight(env: PreflightEnv): Promise<PreflightReport> {
  const checks = await Promise.all(CHECKS.map((check) => check.run(env)));
  const ordered = CHECK_ORDER.map(
    (id) =>
      checks.find((check) => check.id === id) ??
      outcome(id, 'error', false, 'проверка не выполнилась'),
  );
  return {
    ok: ordered.every((check) => check.level === 'warning' || check.ok),
    checks: ordered,
  };
}
