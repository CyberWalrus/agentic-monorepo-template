/**
 * Храповик числа тестов (A3 п.3, З7): число тестов в пакете не уменьшается
 * без явного подтверждения. Warning-only — решение о блокирующем режиме за
 * человеком: падение числа тестов относительно базлайна и понижение базлайна
 * относительно merge-base дают WARNING с именем файла и обоими числами,
 * exit-код всегда 0. Битый или отсутствующий базлайн тоже WARNING — храповик
 * не должен молча ослепнуть.
 *
 * Базлайн — map «путь отчёта → число тестов», он же перечисляет, что храповик
 * смотрит: vitest-отчёты гейт-пакетов и корневых хуков. Playwright-отчёты
 * (e2e/perf) не считаются — удаление e2e-теста сейчас не видит ни один гейт.
 * База для сравнения базлайна: --merge-base <ref>, иначе env TURBO_SCM_BASE,
 * иначе origin/main → main → HEAD.
 *
 * --affected: отчёт, которого нет (turbo --affected не гонял пакет), молча
 * пропускается — сравнивается только реально гонявшееся. Без него (полный
 * прогон: локальный verify, merge queue, push) отсутствующий отчёт из
 * базлайна — WARNING: храповик не имеет права молча ослепнуть к удалению
 * пакета (e21). Семантика не как у check-test-report.ts: там --affected
 * форвардится в вызов turbo, здесь turbo не запускается вовсе — флаг только
 * объявляет вызов частичным («в этом прогоне отчёты могут легально
 * отсутствовать»). Callers: job unit передаёт $AFFECTED из CI (пуст на
 * merge_group/push), static — литеральный --affected (гоняет только
 * test:hooks, отчёты пакетов там отсутствуют всегда).
 *
 * `pnpm test:count:update` (--update) поднимает числа и добавляет новые
 * отчёты; понижать и удалять не умеет — ослабить храповик им нельзя (З7).
 * Автоматически порог может только ужесточаться; когда человек решит сделать
 * гейт блокирующим, файл базлайна уходит в protected-paths.
 *
 * `node tools/check-test-count.ts --pr` (e40) — вторая половина ночного
 * храповика после --update: публикует поднятый базлайн и либо выполняет
 * действие, либо красная с причиной дословно. Базлайн без диффа — зелёный;
 * push прошёл и PR создан либо уже был открыт — зелёный с правдивым
 * сообщением; любой иной отказ (list, fetch, push, create) — exit 1 с причиной
 * и следующим действием человека. Пока выключена настройка Actions «Allow
 * GitHub Actions to create and approve pull requests» (решение владельца),
 * github.token PR не открывает: без открытого PR шаг красный — «ветка
 * создана — PR открывает человек» (ветка прошлой ночи без PR — «заменена
 * коммитом поверх main»). Состояние ветки в тексте — по факту, после успеха
 * команды: отказ push называет ветку до него («не создана», «удалена и не
 * пересоздана», «не обновлена»). Логика здесь, а не inline в nightly.yml:
 * текст шага исполняет канарейка tools/test/test-count-ratchet.test.ts с
 * подставным gh. Остаточный риск: под открытым PR коммит ложится на топ ветки
 * (fast-forward) — если main менял базлайн после её основания, конфликт
 * покажет сам PR, шаг об этом не знает.
 *
 * Авторизация git — конфиг-окружением (GIT_CONFIG_*, git >= 2.31), как в блоке
 * e67 (visual-approve.yml): заголовок собирается из GH_TOKEN здесь и живёт
 * только в env дочерних процессов git, которые ходят на remote, и только на
 * время команды. В argv команд токена нет — в URL remote он был бы виден в ps
 * на время команды. Это держат храповик tools/test/visual-approval.test.ts (в
 * тексте скрипта — ноль литералов URL с токеном) и лог argv в канарейке
 * tools/test/test-count-ratchet.test.ts.
 *
 * Второй остаточный риск (находка ревью e40): push делает github.token, а
 * события от него не рождают workflow run (как у базлайнов visual, ADR 0015) —
 * CI (ci.yml) и gate-integrity на новом коммите сами не запустятся,
 * обязательные checks не появятся, и PR не смержить. Шаг остаётся зелёным:
 * поднятие опубликовано, повторять его не нужно, — но зелёный вывод обязан
 * назвать это и действие человека (CI_NOTE): один synchronize от человека
 * (пустой push, Update branch) либо закрыть и снова открыть PR. То же названо
 * у PR, созданного github.token. Сам шаг этого не проверяет: вывод следует из
 * документации платформы, на GitHub не воспроизводился.
 *
 * Остаточные риски: гейт вызывается через скрипт в package.json, который не
 * защищён — агент может перепривязать `test:count` или подсунуть --baseline
 * на собственный файл без предупреждений (против этого — ревью правок
 * тест-скриптов; то же задокументировано в check-test-report.ts).
 *
 * Аргументы: [--cwd <dir>] [--baseline <path>] [--merge-base <ref>] [--update]
 * [--pr]. --cwd/--baseline/--merge-base — для тестов.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const BOOLEAN_FLAGS = new Set(['affected', 'update', 'pr']);
const REPORT_PATTERNS = [
  'apps/*/reports/vitest.json',
  'packages/*/reports/vitest.json',
  'reports/vitest-hooks.json',
];

const warnings: string[] = [];
const hints: string[] = [];

// Ключи базлайна и ref из окружения попадают в вывод и в сводку PR
// (log/markdown injection) — управляющие символы экранируются.
function clean(value: string): string {
  let result = '';
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      result += code === 10 ? '\\n' : code === 9 ? '\\t' : `\\x${code.toString(16)}`;
    } else {
      result += char;
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseArgs(argv: string[]): Record<string, string[]> {
  const parsed: Record<string, string[]> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      break;
    }
    if (!arg.startsWith('--')) {
      warnings.push(`unexpected argument: ${arg}`);
      continue;
    }
    const name = arg.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      parsed[name] = [];
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      warnings.push(`flag --${name} requires a value`);
      continue;
    }
    index += 1;
    (parsed[name] ??= []).push(value);
  }
  return parsed;
}

function readReportTotal(path: string): number | null {
  try {
    const report = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const total = isRecord(report) ? report['numTotalTests'] : undefined;
    if (typeof total !== 'number') {
      warnings.push(`${clean(path)}: report unreadable ("numTotalTests" is not a number)`);
      return null;
    }
    return total;
  } catch (error) {
    warnings.push(
      `${path}: report unreadable (${error instanceof Error ? error.message : String(error)})`,
    );
    return null;
  }
}

function git(args: string[], cwd: string): string | null {
  const result = spawnSync('git', args, { encoding: 'utf8', cwd, timeout: 30_000 });
  if (result.error !== undefined || result.status !== 0) {
    return null;
  }
  return result.stdout.trim();
}

function resolveBaseRef(root: string, explicit?: string): string | null {
  if (explicit !== undefined) {
    return explicit;
  }
  const fromEnv = process.env['TURBO_SCM_BASE'];
  if (fromEnv !== undefined && fromEnv !== '') {
    return fromEnv;
  }
  for (const candidate of ['origin/main', 'main', 'HEAD']) {
    if (git(['rev-parse', '--verify', candidate], root) !== null) {
      return candidate;
    }
  }
  return null;
}

const argv = parseArgs(process.argv.slice(2));
const root = resolve(argv['cwd']?.[0] ?? process.cwd());
const baselinePath = resolve(root, argv['baseline']?.[0] ?? 'test-count-baseline.json');

// Базлайн: map «путь отчёта → число тестов». Нечитаемый — WARNING: храповик
// не имеет права молча ослепнуть, но warning-only гейт не красит прогон.
let baseline: Record<string, number> | null = null;
if (!existsSync(baselinePath)) {
  warnings.push(
    `${argv['baseline']?.[0] ?? 'test-count-baseline.json'}: baseline is missing — run pnpm test:count:update to create it`,
  );
} else {
  try {
    const parsed: Record<string, number> = {};
    const raw: unknown = JSON.parse(readFileSync(baselinePath, 'utf8'));
    if (!isRecord(raw)) {
      throw new Error('expected an object of {report path: number}');
    }
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value !== 'number') {
        throw new Error(`expected a number for "${key}", got ${typeof value}`);
      }
      parsed[key] = value;
    }
    baseline = parsed;
  } catch (error) {
    warnings.push(
      `${argv['baseline']?.[0] ?? 'test-count-baseline.json'}: baseline is unreadable (${error instanceof Error ? error.message : String(error)}) — the ratchet is blind`,
    );
  }
}

if (argv['update'] !== undefined) {
  if (baseline === null) {
    baseline = {};
  }
  let lowered = 0;
  let raised = 0;
  for await (const entry of glob(REPORT_PATTERNS, { cwd: root })) {
    const key = entry.replaceAll('\\', '/');
    const total = readReportTotal(resolve(root, key));
    if (total === null) {
      continue;
    }
    const current = baseline[key];
    if (current === undefined || total > current) {
      baseline[key] = total;
      raised += 1;
      console.log(`raised ${key}: ${current ?? 'new'} → ${total}`);
    } else if (total < current) {
      lowered += 1;
      console.log(`refused to lower ${key}: baseline ${current} > current ${total}`);
    }
  }
  const sorted = Object.fromEntries(
    Object.entries(baseline).toSorted(([a], [b]) => a.localeCompare(b)),
  );
  // temp+rename: обрыв записи не оставляет усечённый базлайн.
  const tempPath = `${baselinePath}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(sorted, null, 2)}\n`);
  renameSync(tempPath, baselinePath);
  if (lowered > 0) {
    console.log(`test count: updated with ${raised} raise(s); ${lowered} decrease(s) refused`);
  } else {
    console.log(`test count: baseline updated (${raised} raise(s))`);
  }
  process.exit(0);
}

// --pr (e40): публикация поднятого базлайна — коммит ровно с базлайном, push
// ветки, PR — и никакого «|| echo»: каждый отказ либо объяснён «уже открыт»,
// либо красный.
const RATCHET_BRANCH = 'chore/test-count-ratchet';
const TRACKING_REF = `refs/remotes/nightly-ratchet/${RATCHET_BRANCH}`;
const COMMIT_MESSAGE = 'chore: поднятие храповика числа тестов (nightly, a10)';
const PR_TITLE = 'chore: поднятие храповика числа тестов (nightly)';
const PR_BODY =
  'Автоматическое поднятие test-count-baseline.json после зелёного nightly (a10): числовой храповик поднимает автоматика, а не автор PR. Update понижать отказывается — дифф только вверх.';
// Push делает github.token, а события от него не рождают workflow run (как у
// базлайнов visual, ADR 0015): на новом коммите обязательные checks (gate,
// gate-integrity) сами не появятся, и PR не смержить. Поднятие при этом
// опубликовано — шаг зелёный, но вывод обязан назвать это и действие человека.
const CI_NOTE = [
  'CI на новый коммит не запустится: push сделал github.token,',
  'события от него workflow не рождают, а обязательные checks (gate, gate-integrity)',
  'ждут результаты на новом head SHA.',
  'Перед merge человеку одно из: пустой коммит от себя, Update branch',
  'или закрыть и снова открыть PR — synchronize/reopened запускают',
  'ci.yml и gate-integrity.yml на новом коммите.',
].join('\n');

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** spawn не удался (нет исполняемого файла, нет прав) — сообщение запуска. */
  spawnError: string;
}

interface OpenPullRequest {
  number: number;
  url: string;
}

/** Шаг красный: линии с причиной дословно и действие человека. */
class PublishFailure extends Error {
  // Без property-параметров конструктора: Node исполняет .ts в strip-only режиме.
  action: string;

  lines: string[];

  constructor(action: string, lines: string[]) {
    super(action);
    this.action = action;
    this.lines = lines;
  }
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): CommandResult {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', env, timeout: 120_000 });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    spawnError: result.error?.message ?? '',
  };
}

// Заголовок авторизации для конфиг-окружения git (блок e67): basic от пары
// «x-access-token:<токен>». Пустой токен — пустая строка.
function authorizationHeader(token: string): string {
  return token === ''
    ? ''
    : `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
}

// Токен и собранный из него заголовок живут в env дочерних процессов (GH_TOKEN,
// GIT_CONFIG_VALUE_*) и могут вернуться в выводе команды (например, git
// печатает значение конфигурации при ошибке разбора) — из вывода они вырезаются.
function redact(text: string): string {
  const token = process.env['GH_TOKEN'] ?? '';
  let result = text;
  for (const secret of [token, authorizationHeader(token)]) {
    result = secret === '' ? result : result.replaceAll(secret, '***');
  }
  return result;
}

// Вывод команды дословно, построчно: управляющие символы экранируются
// (log/markdown injection), префикс не даёт строке начаться с `::`.
function quote(label: string, output: string): string[] {
  const text = redact(output).trim();
  if (text === '') {
    return [`${label} <пусто>`];
  }
  return [label, ...text.split('\n').map((line) => `  | ${clean(line.replaceAll('\r', ''))}`)];
}

function commandFailed(label: string, result: CommandResult): string[] {
  const spawn = result.spawnError === '' ? '' : ` (${clean(result.spawnError)})`;
  return [
    `✗ ${label} — код ${result.status ?? 'нет'}${spawn}`,
    ...quote(`${label}, stdout:`, result.stdout),
    ...quote(`${label}, stderr:`, result.stderr),
  ];
}

function must(action: string, label: string, result: CommandResult): string {
  if (result.status !== 0) {
    throw new PublishFailure(action, commandFailed(label, result));
  }
  return result.stdout.trim();
}

function parseOpenPullRequest(stdout: string): OpenPullRequest | null {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) {
    throw new Error('expected a JSON array of pull requests');
  }
  if (parsed.length === 0) {
    return null;
  }
  const first: unknown = parsed[0];
  if (!isRecord(first) || typeof first['number'] !== 'number' || typeof first['url'] !== 'string') {
    throw new Error('expected {number, url}');
  }
  return { number: first['number'], url: first['url'] };
}

// Коммит через plumbing: рабочее дерево, индекс и HEAD не трогаются, в коммит
// попадает ровно базлайн — дерево родителя с заменённым файлом.
function commitBaselineOn(parent: string, baselineRelative: string): string {
  const untouched = 'ветка не тронута';
  const scratch = mkdtempSync(join(tmpdir(), 'test-count-ratchet-'));
  const indexEnv: NodeJS.ProcessEnv = { ...process.env, GIT_INDEX_FILE: join(scratch, 'index') };
  try {
    const blob = must(
      untouched,
      'git hash-object',
      run('git', ['hash-object', '-w', '--', baselineRelative]),
    );
    // Режим файла — как у родителя (100644); нового файла с базлайном не бывает.
    const entry = must(
      untouched,
      'git ls-tree',
      run('git', ['ls-tree', parent, '--', baselineRelative]),
    );
    const mode = entry.split(/\s+/)[0] ?? '100644';
    must(untouched, 'git read-tree', run('git', ['read-tree', parent], indexEnv));
    must(
      untouched,
      'git update-index',
      run(
        'git',
        ['update-index', '--add', '--cacheinfo', `${mode},${blob},${baselineRelative}`],
        indexEnv,
      ),
    );
    const tree = must(untouched, 'git write-tree', run('git', ['write-tree'], indexEnv));
    return must(
      untouched,
      'git commit-tree',
      run('git', [
        '-c',
        'user.name=nightly-ratchet',
        '-c',
        'user.email=nightly-ratchet@users.noreply.github.com',
        'commit-tree',
        tree,
        '-p',
        parent,
        '-m',
        COMMIT_MESSAGE,
      ]),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Конфиг-окружение дочернего git (блок e67): заголовок авторизации для github.com
// идёт переменными GIT_CONFIG_* — только процессам, которые ходят на remote, и
// на время команды; в argv, в env шага и в .git/config токена нет. Чужие записи
// конфиг-окружения не затираются — новая идёт после них.
function gitAuthEnv(token: string): NodeJS.ProcessEnv {
  const count = Number.parseInt(process.env['GIT_CONFIG_COUNT'] ?? '0', 10);
  if (!Number.isInteger(count) || count < 0) {
    throw new PublishFailure(
      'это шаг nightly-джобы «test count ratchet», локально его не запускают.',
      ['✗ GIT_CONFIG_COUNT в окружении job — не неотрицательное целое.'],
    );
  }
  return {
    ...process.env,
    GIT_CONFIG_COUNT: String(count + 1),
    [`GIT_CONFIG_KEY_${count}`]: 'http.https://github.com/.extraheader',
    [`GIT_CONFIG_VALUE_${count}`]: authorizationHeader(token),
  };
}

// git-команда на remote: токен — конфиг-окружением; credential.helper сброшен,
// чтобы авторизовал ровно токен job, а не хелпер машины или checkout.
function gitOnRemote(args: string[], gitAuth: NodeJS.ProcessEnv): CommandResult {
  return run('git', ['-c', 'credential.helper=', ...args], gitAuth);
}

function publishRaisedBaseline(): number {
  const baselineRelative = argv['baseline']?.[0] ?? 'test-count-baseline.json';
  const token = process.env['GH_TOKEN'] ?? '';
  const repository = process.env['GITHUB_REPOSITORY'] ?? '';
  if (token === '' || repository === '') {
    throw new PublishFailure(
      'это шаг nightly-джобы «test count ratchet», локально его не запускают.',
      ['✗ GH_TOKEN или GITHUB_REPOSITORY не заданы.'],
    );
  }
  const remote = `https://github.com/${repository}.git`;
  const gitAuth = gitAuthEnv(token);
  const ref = `refs/heads/${RATCHET_BRANCH}`;
  const listArgs = [
    'pr',
    'list',
    '--repo',
    repository,
    '--head',
    RATCHET_BRANCH,
    '--state',
    'open',
    '--json',
    'number,url',
  ];
  const untouched = 'ветка не тронута';

  // Код 1 — дифф есть; всё, кроме 0 и 1, — ошибка git, а не «диффа нет».
  const diff = run('git', ['diff', '--quiet', '--', baselineRelative]);
  if (diff.status === 0) {
    console.log('Базлайн актуален — PR храповика не нужен.');
    return 0;
  }
  if (diff.status !== 1) {
    throw new PublishFailure(
      `${untouched} — проверь состояние checkout в job.`,
      commandFailed('git diff --quiet (ожидался код 1)', diff),
    );
  }

  // «Уже открыт» узнаётся до create — отказ create за него не выдаётся.
  const listed = must(
    `${untouched} — проверь GH_TOKEN и права job (pull-requests: read).`,
    'gh pr list',
    run('gh', listArgs),
  );
  let open: OpenPullRequest | null;
  try {
    open = parseOpenPullRequest(listed);
  } catch {
    throw new PublishFailure(
      `${untouched} — ответ gh pr list не читается.`,
      quote('gh pr list, stdout:', listed),
    );
  }

  // Родитель коммита: под открытым PR — топ ветки (fast-forward: удаление
  // ветки закрыло бы PR), иначе — текущий main: PR из одного коммита поверх него.
  let parent = 'HEAD';
  if (open !== null) {
    must(
      `PR #${open.number} открыт, но топ ветки не получен; ${untouched} — проверь права job (contents: read).`,
      'git fetch',
      gitOnRemote(['fetch', '--no-tags', remote, `${ref}:${TRACKING_REF}`], gitAuth),
    );
    parent = must(
      untouched,
      'git rev-parse',
      run('git', ['rev-parse', '--verify', `${TRACKING_REF}^{commit}`]),
    );
  }
  const commit = commitBaselineOn(parent, baselineRelative);

  // Состояние ветки в тексте — по факту, а не по намерению: текст уходит
  // человеку вместе с причиной отказа, и «обновлена» рядом с отклонённым push
  // или «удалена и не пересоздана» рядом с командой на уже пересозданную ветку
  // — ложь о состоянии ветки (тот же класс, что исходный дефект e40).
  // unpushedState описывает ветку на случай отказа push; pushedState читается
  // только после успеха push.
  const branch = `ветка ${RATCHET_BRANCH}`;
  let unpushedState = `${branch} не обновлена`;
  let pushedState = `${branch} обновлена`;
  // Без открытого PR ветка одноразовая: остаток прошлой ночи (create отказал,
  // PR закрыт или смержен) заменяется новым коммитом. Код 2 у ls-remote —
  // ветки нет (первая ночь); любой другой код — сеть или права, громко.
  if (open === null) {
    const existing = gitOnRemote(['ls-remote', '--exit-code', remote, ref], gitAuth);
    if (existing.status === 0) {
      must(
        `ветка ${RATCHET_BRANCH} не обновлена — на remote старый коммит; проверь права job (contents: write).`,
        'git push --delete',
        gitOnRemote(['push', remote, '--delete', RATCHET_BRANCH], gitAuth),
      );
      unpushedState = `${branch} удалена и не пересоздана`;
      pushedState = `${branch} заменена коммитом поверх main`;
    } else if (existing.status !== 2) {
      must(`${untouched} — проверь права job (contents: write) и сеть.`, 'git ls-remote', existing);
    } else {
      unpushedState = `${branch} не создана`;
      pushedState = `${branch} создана`;
    }
  }
  must(
    `${unpushedState}: поднятие не потеряно — ночная джоба повторит завтра; повторится — проверь права job (contents: write).`,
    'git push',
    gitOnRemote(['push', remote, `${commit}:${ref}`], gitAuth),
  );
  const branchState = pushedState;

  if (open !== null) {
    console.log(
      `PR #${open.number} уже открыт — ${branchState} (commit ${commit.slice(0, 12)}): ${clean(open.url)}`,
    );
    console.log(CI_NOTE);
    return 0;
  }

  const created = run('gh', [
    'pr',
    'create',
    '--repo',
    repository,
    '--base',
    'main',
    '--head',
    RATCHET_BRANCH,
    '--title',
    PR_TITLE,
    '--body',
    PR_BODY,
  ]);
  if (created.status === 0) {
    console.log(`PR храповика создан: ${clean(created.stdout.trim())}`);
    console.log(CI_NOTE);
    return 0;
  }
  // PR могли открыть между list и create — перепроверяем, а не гадаем.
  const rechecked = run('gh', listArgs);
  if (rechecked.status === 0) {
    try {
      const raced = parseOpenPullRequest(rechecked.stdout);
      if (raced !== null) {
        console.log(
          `PR #${raced.number} уже открыт — ${branchState} (commit ${commit.slice(0, 12)}): ${clean(raced.url)}`,
        );
        return 0;
      }
    } catch {
      // Ответ не читается — ниже честный отказ с причиной create дословно.
    }
  }
  throw new PublishFailure(
    `${branchState} — PR открывает человек:\n  gh pr create --base main --head ${RATCHET_BRANCH} --title "${PR_TITLE}"`,
    commandFailed('gh pr create', created),
  );
}

if (argv['pr'] !== undefined) {
  try {
    process.exit(publishRaisedBaseline());
  } catch (error) {
    if (!(error instanceof PublishFailure)) {
      throw error;
    }
    for (const line of error.lines) {
      console.log(line);
    }
    console.log(`Дальше человек: ${error.action}`);
    process.exit(1);
  }
}

// Понижение и удаление записей базлайна против merge-base: ослабление
// храповика видно в PR наравне с падением числа тестов. Сравнение по
// объединению ключей — удалённый ключ иначе обходит проверку молча.
const baseRef = resolveBaseRef(root, argv['merge-base']?.[0]);
if (baseline !== null && baseRef !== null) {
  const baseText = git(['show', `${baseRef}:test-count-baseline.json`], root);
  if (baseText !== null) {
    try {
      const parsed: Record<string, number> = {};
      const raw: unknown = JSON.parse(baseText);
      if (isRecord(raw)) {
        for (const [key, value] of Object.entries(raw)) {
          if (typeof value === 'number') {
            parsed[key] = value;
          }
        }
      }
      const keys = [...new Set([...Object.keys(parsed), ...Object.keys(baseline)])].toSorted();
      for (const key of keys) {
        const baseValue = parsed[key];
        const currentValue = baseline[key];
        if (currentValue === undefined) {
          warnings.push(
            `test-count-baseline.json: baseline entry "${clean(key)}" removed vs ${clean(baseRef)} (was ${baseValue}) — a ratchet must only tighten; justify in the PR description`,
          );
        } else if (baseValue !== undefined && currentValue < baseValue) {
          warnings.push(
            `test-count-baseline.json: baseline for "${clean(key)}" lowered vs ${clean(baseRef)}: ${baseValue} → ${currentValue} — a ratchet must only tighten; justify in the PR description`,
          );
        }
      }
    } catch {
      // Базлайна не было в базе (новый файл) — сравнивать не с чем, не ошибка.
    }
  }
}

// Сравнение с отчётами. Полный прогон (без --affected): отсутствующий отчёт
// из базлайна — WARNING (e21: иначе храповик молча слепнет к удалению
// пакета). С --affected пропуск молча: пакет мог не попасть в прогон.
const affected = argv['affected'] !== undefined;
let compared = 0;
if (baseline !== null) {
  for (const [key, expected] of Object.entries(baseline).toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const reportPath = resolve(root, key);
    if (!existsSync(reportPath)) {
      if (!affected) {
        warnings.push(
          `baseline entry "${clean(key)}": report is missing (package deleted or report no longer produced)`,
        );
      }
      continue;
    }
    const total = readReportTotal(reportPath);
    if (total === null) {
      continue;
    }
    compared += 1;
    if (total < expected) {
      warnings.push(
        `${clean(key)}: test count decreased: ${expected} → ${total} — skipped or deleted tests hide regressions; justify in the PR description`,
      );
    } else if (total > expected) {
      hints.push(
        `${clean(key)}: tests grew ${expected} → ${total} — run pnpm test:count:update to raise the baseline`,
      );
    }
  }
}

for (const warning of warnings) {
  console.log(`WARNING: ${warning}`);
}
for (const hint of hints) {
  console.log(`hint: ${hint}`);
}
console.log(
  warnings.length > 0
    ? `test count: ${warnings.length} warning(s), ${compared} report(s) compared`
    : `test count: ok (${compared} report(s) compared)`,
);
process.exit(0);
