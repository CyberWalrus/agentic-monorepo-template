/**
 * CLI храповика мутационных порогов web и контрактов (b2.4): подкоманды
 * check / fetch-state / decide / apply / publish. Подробности, коды выходов и
 * решения — в шапке tools/check-mutation-ratchet.ts (чистое ядро,
 * импортируется тестами). Entry отделён от ядра, чтобы импорт из тестов не
 * исполнял CLI (как check-perf-trend(.main).ts).
 *
 * Коды выходов fetch-state — как у perf fetch-baseline (nightly.yml): 0 —
 * найден, 3 — ни у одного зелёного прогона (первый запуск), 1 — ошибка API.
 * Артефакты идут от новейшего к старшему: битый по схеме артефакт свежего
 * прогона не клинит канал, берётся предыдущий (находка arch-ревью A6.1).
 *
 * publish (e82) — шаг nightly «PR with raised thresholds»: коммит с
 * поднятыми порогами, push ветки, PR — либо действие выполнено, либо выход 1
 * с причиной дословно и действием человека.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkDomains,
  checkVerdict,
  decide,
  DOMAINS,
  type Breaks,
  type BreaksConfigPaths,
  type DomainCheckInput,
  MutationReportSchema,
  type ProposalFile,
  ProposalFileSchema,
  RatchetStateSchema,
  type ParsedDomain,
  StrykerThresholdsSchema,
  scoreFromReport,
  STATE_ARTIFACT_NAME,
  STATE_FILE_NAME,
  validateProposals,
} from './check-mutation-ratchet.ts';

const SHA_RE = /^[0-9a-f]{40}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8' }).trim();
}

function ghJson(args: string[]): unknown {
  return JSON.parse(gh(args)) as unknown;
}

function repoFromEnv(): string {
  const fromEnv = process.env['GITHUB_REPOSITORY'];
  if (fromEnv) {
    return fromEnv;
  }
  // Локальный запуск: берём из origin (по образцу pnpm backlog doctor).
  const url = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  const match = /github\.com[/:](.+\/.+?)(?:\.git)?$/.exec(url);
  if (!match?.[1]) {
    throw new Error('не удалось определить репозиторий (GITHUB_REPOSITORY или git origin)');
  }
  return match[1];
}

interface RunInfo {
  id: number;
  createdAt: string;
}

/** Успешные nightly-прогоны main, новейшие первыми (по образцу perf-базлайна). */
function successfulNightlyRuns(): RunInfo[] {
  const raw = ghJson([
    'run',
    'list',
    '--workflow',
    'Nightly',
    '--branch',
    'main',
    '--status',
    'success',
    '--limit',
    '30',
    '--json',
    'databaseId,createdAt',
  ]);
  if (!Array.isArray(raw)) {
    throw new Error('gh run list вернул не массив');
  }
  return raw.flatMap((entry): RunInfo[] => {
    if (!isRecord(entry)) {
      return [];
    }
    const id = entry['databaseId'];
    const createdAt = entry['createdAt'];
    return typeof id === 'number' && typeof createdAt === 'string' ? [{ id, createdAt }] : [];
  });
}

function hasStateArtifact(runId: number): boolean {
  const raw: unknown = ghJson(['api', `repos/${repoFromEnv()}/actions/runs/${runId}/artifacts`]);
  const artifacts = isRecord(raw) && Array.isArray(raw['artifacts']) ? raw['artifacts'] : [];
  return artifacts.some(
    (artifact) =>
      isRecord(artifact) &&
      artifact['name'] === STATE_ARTIFACT_NAME &&
      artifact['expired'] !== true,
  );
}

// ─── Чтение недоверенных входов ───

function parseReportFile(path: string): ParsedDomain {
  if (!existsSync(path)) {
    return { kind: 'missing' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return { kind: 'broken', message: error instanceof Error ? error.message : String(error) };
  }
  const parsed = MutationReportSchema.safeParse(raw);
  if (!parsed.success) {
    return { kind: 'broken', message: parsed.error.message };
  }
  let score: number;
  try {
    score = scoreFromReport(parsed.data);
  } catch (error) {
    return { kind: 'broken', message: error instanceof Error ? error.message : String(error) };
  }
  return { kind: 'ok', score };
}

/** Счёт из разобранного отчёта; нет или бит — красный выход (З11: молча ослепнуть нельзя). */
function requireScore(entry: ParsedDomain, source: string, domain: string): number {
  if (entry.kind === 'missing') {
    console.error(`✗ decide: ${domain}: отчёта нет (${source})`);
    process.exit(1);
  }
  if (entry.kind === 'broken') {
    console.error(`✗ decide: ${domain}: отчёт не читается — ${entry.message}`);
    process.exit(1);
  }
  return entry.score;
}

function readBreakFromConfig(path: string, domain: string): number {
  if (!existsSync(path)) {
    throw new Error(`${domain}: конфиг не найден — ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `${domain}: конфиг не читается (${path}) — ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const parsed = StrykerThresholdsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${domain}: в ${path} нет thresholds.break — ${parsed.error.message}`);
  }
  return parsed.data.thresholds.break;
}

/**
 * Заменяет в сыром тексте конфига ровно одно значение thresholds.break —
 * остальной текст (oxfmt-форматирование) не трогается. Парсить и писать
 * JSON.stringify нельзя: oxfmt сворачивает короткие массивы в строку,
 * stringify пишет развёрнуто — format:check красил бы автоматический PR
 * храповика с первого срабатывания, а force-repush ветки каждую ночь стирал
 * бы ручное переформатирование (находка ревью PR #142). Требует ровно одно
 * вхождение `from` — иначе пишем отказом, конфиг не тот.
 */
function replaceBreakInConfigText(text: string, from: number, to: number, path: string): string {
  const source = `("break"\\s*:\\s*)${String(from).replaceAll('.', '\\.')}(?=\\s*[,}])`;
  const matches = [...text.matchAll(new RegExp(source, 'g'))];
  if (matches.length !== 1) {
    throw new Error(
      `${path}: ожидалось ровно одно значение break=${from}, найдено ${matches.length} — конфиг не тронут`,
    );
  }
  return text.replace(new RegExp(source), (_match, prefix: string) => `${prefix}${to}`);
}

function parseBreakOverrides(specs: string[]): Partial<Breaks> {
  const overrides: Partial<Breaks> = {};
  for (const spec of specs) {
    const match = /^(web|contracts)=(\d+(?:\.\d+)?)$/.exec(spec);
    if (match === null) {
      throw new Error(`--break-override ожидает web|contracts=<число>, получено: ${spec}`);
    }
    const domain = match[1];
    if (domain !== 'web' && domain !== 'contracts') {
      throw new Error(`--break-override: неизвестный домен ${domain}`);
    }
    overrides[domain] = Number(match[2]);
  }
  return overrides;
}

function resolveBreaks(
  configWeb: string,
  configContracts: string,
  overrides: Partial<Breaks>,
): Breaks {
  const breaks: Breaks = {
    web: overrides.web ?? readBreakFromConfig(configWeb, 'web'),
    contracts: overrides.contracts ?? readBreakFromConfig(configContracts, 'contracts'),
  };
  return breaks;
}

function domainInput(
  domain: 'web' | 'contracts',
  reportPath: string,
  threshold: number,
): DomainCheckInput {
  return { domain, break: threshold, parsed: parseReportFile(reportPath) };
}

// ─── CLI ───

function parseFlag(names: string[]): string | undefined {
  for (const name of names) {
    const index = process.argv.indexOf(name);
    if (index >= 0) {
      const value = process.argv[index + 1];
      if (!value) {
        console.error(`${name} требует значение`);
        process.exit(2);
      }
      return value;
    }
  }
  return undefined;
}

function parseAllFlags(name: string): string[] {
  const values: string[] = [];
  let index = process.argv.indexOf(name);
  while (index >= 0) {
    const value = process.argv[index + 1];
    if (!value) {
      console.error(`${name} требует значение`);
      process.exit(2);
    }
    values.push(value);
    index = process.argv.indexOf(name, index + 2);
  }
  return values;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function unknownArgs(allowed: string[]): string[] {
  const rest = process.argv.slice(2);
  const unknown: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg?.startsWith('--')) {
      continue; // подкоманда и значения флагов не проверяются
    }
    if (!allowed.includes(arg)) {
      unknown.push(arg);
      continue;
    }
    if (arg !== '--expect-regression') {
      index += 1; // известный флаг без значения — пропускаем его значение
    }
  }
  return unknown;
}

function usage(): never {
  console.error(
    'Использование: node tools/check-mutation-ratchet.main.ts <check|fetch-state|decide|apply|publish> [аргументы]',
  );
  process.exit(2);
}

const command = process.argv[2];
const allowedByCommand: { [name: string]: string[] | undefined } = {
  check: [
    '--web',
    '--contracts',
    '--config-web',
    '--config-contracts',
    '--break-override',
    '--expect-regression',
  ],
  'fetch-state': ['--out', '--exclude-run'],
  decide: [
    '--web',
    '--contracts',
    '--config-web',
    '--config-contracts',
    '--prev',
    '--state-out',
    '--proposal-out',
    '--head-sha',
    '--run-id',
    '--date',
  ],
  apply: ['--proposal', '--config-web', '--config-contracts'],
  publish: ['--proposal', '--config-web', '--config-contracts'],
};

if (command === undefined || !(command in allowedByCommand)) {
  usage();
}
const unknown = unknownArgs(allowedByCommand[command] ?? []);
if (unknown.length > 0) {
  console.error(`${command}: неизвестные аргументы: ${unknown.join(', ')}`);
  process.exit(2);
}

const defaultConfigWeb = DOMAINS.find((spec) => spec.domain === 'web')?.configPath ?? '';
const defaultConfigContracts =
  DOMAINS.find((spec) => spec.domain === 'contracts')?.configPath ?? '';

if (command === 'check') {
  const configWeb = parseFlag(['--config-web']) ?? defaultConfigWeb;
  const configContracts = parseFlag(['--config-contracts']) ?? defaultConfigContracts;
  const reportWeb =
    parseFlag(['--web']) ?? DOMAINS.find((spec) => spec.domain === 'web')?.reportPath ?? '';
  const reportContracts =
    parseFlag(['--contracts']) ??
    DOMAINS.find((spec) => spec.domain === 'contracts')?.reportPath ??
    '';
  let breaks: Breaks;
  try {
    breaks = resolveBreaks(
      configWeb,
      configContracts,
      parseBreakOverrides(parseAllFlags('--break-override')),
    );
  } catch (error) {
    console.error(`✗ check: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  const violations = checkDomains([
    domainInput('web', reportWeb, breaks.web),
    domainInput('contracts', reportContracts, breaks.contracts),
  ]);
  for (const violation of violations) {
    console.error(`✗ ${violation.domain}: ${violation.kind} — ${violation.message}`);
  }
  const verdict = checkVerdict(violations, hasFlag('--expect-regression'));
  if (!verdict.pass) {
    if (verdict.reason !== undefined) {
      console.error(`✗ ${verdict.reason}`);
    }
    process.exit(1);
  }
  console.log(
    hasFlag('--expect-regression')
      ? 'инверсия подтверждена: завышенный порог даёт нарушение — детектор жив'
      : 'счёты web и контрактов не ниже порогов',
  );
  process.exit(0);
}

if (command === 'fetch-state') {
  const out = parseFlag(['--out']);
  if (!out) {
    console.error('fetch-state: нужен --out DIR');
    process.exit(2);
  }
  const excludeRun = parseFlag(['--exclude-run']);
  let runs: RunInfo[];
  try {
    runs = successfulNightlyRuns();
  } catch (error) {
    console.error(
      `✗ mutation-ratchet: gh run list не удался — ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
  const candidates = runs.filter((run) => String(run.id) !== excludeRun);
  const withArtifact = candidates.filter((run) => hasStateArtifact(run.id));
  if (withArtifact.length === 0) {
    console.log('mutation-ratchet: состояние прошлых прогонов не найдено — первый запуск (none)');
    process.exit(3);
  }
  const downloadDir = mkdtempSync(join(tmpdir(), 'mutation-ratchet-state-'));
  try {
    let foundRun: RunInfo | undefined;
    let state: unknown;
    for (const run of withArtifact) {
      rmSync(downloadDir, { recursive: true, force: true });
      mkdirSync(downloadDir, { recursive: true });
      try {
        gh(['run', 'download', String(run.id), '-n', STATE_ARTIFACT_NAME, '-D', downloadDir]);
        state = RatchetStateSchema.parse(
          JSON.parse(readFileSync(join(downloadDir, STATE_FILE_NAME), 'utf8')),
        );
        foundRun = run;
        break;
      } catch (error) {
        console.error(
          `артефакт прогона ${run.id} не читается (${error instanceof Error ? error.message : String(error)}) — пробуем старше`,
        );
      }
    }
    if (foundRun === undefined || state === undefined) {
      console.error('✗ mutation-ratchet: ни один артефакт состояния не читается (fail-closed)');
      process.exit(1);
    }
    mkdirSync(out, { recursive: true });
    const target = join(out, STATE_FILE_NAME);
    writeFileSync(target, JSON.stringify(state, null, 2));
    console.log(`mutation-ratchet: состояние от прогона ${foundRun.id} — ${target}`);
    process.exit(0);
  } finally {
    rmSync(downloadDir, { recursive: true, force: true });
  }
}

if (command === 'decide') {
  const configWeb = parseFlag(['--config-web']) ?? defaultConfigWeb;
  const configContracts = parseFlag(['--config-contracts']) ?? defaultConfigContracts;
  const reportWeb =
    parseFlag(['--web']) ?? DOMAINS.find((spec) => spec.domain === 'web')?.reportPath ?? '';
  const reportContracts =
    parseFlag(['--contracts']) ??
    DOMAINS.find((spec) => spec.domain === 'contracts')?.reportPath ??
    '';
  const stateOut = parseFlag(['--state-out']);
  const proposalOut = parseFlag(['--proposal-out']);
  const sha = parseFlag(['--head-sha']);
  const runIdRaw = parseFlag(['--run-id']);
  const date = parseFlag(['--date']) ?? new Date().toISOString();
  if (!stateOut || !sha || !runIdRaw) {
    console.error('decide: нужны --state-out DIR, --head-sha, --run-id');
    process.exit(2);
  }
  if (!SHA_RE.test(sha)) {
    console.error(`decide: --head-sha не hex40: ${sha}`);
    process.exit(2);
  }
  const runId = Number(runIdRaw);
  if (!Number.isInteger(runId) || runId <= 0) {
    console.error(`decide: --run-id не положительное целое: ${runIdRaw}`);
    process.exit(2);
  }
  let breaks: Breaks;
  let prev = null;
  try {
    breaks = resolveBreaks(configWeb, configContracts, {});
    const prevDir = parseFlag(['--prev']);
    if (prevDir) {
      const prevPath = join(prevDir, STATE_FILE_NAME);
      prev = RatchetStateSchema.parse(JSON.parse(readFileSync(prevPath, 'utf8')));
    }
  } catch (error) {
    console.error(`✗ decide: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  const scores: Breaks = {
    web: requireScore(parseReportFile(reportWeb), reportWeb, 'web'),
    contracts: requireScore(parseReportFile(reportContracts), reportContracts, 'contracts'),
  };
  const result = decide({
    current: scores,
    break: breaks,
    prev,
    sha,
    runId,
    date,
  });
  mkdirSync(stateOut, { recursive: true });
  writeFileSync(join(stateOut, STATE_FILE_NAME), JSON.stringify(result.state, null, 2));
  if (proposalOut !== undefined) {
    if (result.proposals.length > 0) {
      const proposalFile = {
        schema: 'mutation-ratchet-proposal/1',
        sha,
        runId,
        proposals: result.proposals,
      };
      writeFileSync(proposalOut, JSON.stringify(proposalFile, null, 2));
      console.log(`mutation-ratchet: предложение храповика — ${proposalOut}`);
    } else {
      // файл может остаться от предыдущего шага джобы — отсутствие предложения
      // обязано выглядеть как отсутствие файла
      rmSync(proposalOut, { force: true });
    }
  }
  for (const note of result.notes) {
    console.log(`mutation-ratchet: ${note}`);
  }
  console.log(`mutation-ratchet: состояние записано (${stateOut}/${STATE_FILE_NAME})`);
  process.exit(0);
}

if (command === 'apply') {
  const proposalPath = parseFlag(['--proposal']);
  if (!proposalPath) {
    console.error('apply: нужен --proposal FILE');
    process.exit(2);
  }
  try {
    const proposal = ProposalFileSchema.parse(JSON.parse(readFileSync(proposalPath, 'utf8')));
    const configWeb = parseFlag(['--config-web']) ?? defaultConfigWeb;
    const configContracts = parseFlag(['--config-contracts']) ?? defaultConfigContracts;
    const configPaths = { web: configWeb, contracts: configContracts };
    const currentBreaks: Breaks = {
      web: readBreakFromConfig(configWeb, 'web'),
      contracts: readBreakFromConfig(configContracts, 'contracts'),
    };
    validateProposals(proposal.proposals, configPaths, currentBreaks);
    for (const entry of proposal.proposals) {
      const path = configPaths[entry.domain];
      writeFileSync(
        path,
        replaceBreakInConfigText(readFileSync(path, 'utf8'), entry.from, entry.to, path),
      );
      console.log(`apply: ${entry.domain} ${entry.configPath}: break ${entry.from} → ${entry.to}`);
    }
    if (proposal.proposals.length === 0) {
      console.log('apply: предложений нет — конфиги не тронуты');
    }
  } catch (error) {
    console.error(`✗ apply: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  process.exit(0);
}

// ─── publish (e82): публикация предложения — коммит, push ветки, PR ───
// По образцу tools/check-test-count.ts --pr (e40): либо действие выполнено,
// либо шаг красный с причиной дословно и действием человека. До e82 логика
// жила inline в nightly.yml и глушила отказы (`git push … || true`,
// `gh pr create … || echo «PR храповика уже открыт — ветка обновлена»`):
// create отклоняет настройка Actions, и ночи с предложением уходили зелёным
// шагом без PR. Остаточный риск тот же, что у e40: если main менял порог
// после основания открытой PR-ветки — конфликт покажет сам PR, шаг об этом
// не знает.
const RATCHET_BRANCH = 'chore/mutation-ratchet-web-contracts';
const TRACKING_REF = `refs/remotes/nightly-ratchet/${RATCHET_BRANCH}`;
const COMMIT_MESSAGE = 'chore: поднятие мутационного порога break web и контрактов (nightly, b2.4)';
const PR_TITLE = 'chore: поднятие мутационного порога break web и контрактов (nightly)';
const PR_BODY =
  'Автоматическое поднятие thresholds.break web и контрактов после зелёного nightly (b2.4, З7): правило ADR 0009 «Пороги» от устойчивого счёта, только вверх. Порог может только ужесточаться — каждое повышение проходит приёмку человека: label `gate-change-approved` после последнего push (force-repush ветки снимает label на synchronize, ADR 0002).';
// Push делает github.token, а события от него не рождают workflow run (как у
// базлайнов visual, ADR 0015): на новом коммите обязательные checks (gate,
// gate-integrity) сами не появятся, и PR не смержить. Поднятие при этом
// опубликовано — вывод обязан назвать это и действие человека.
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

// Команда без оболочки (argv-массивом): статус и оба потока — для вывода
// дословно. Имя не `run`: в fetch-state так названы параметры колбэков (no-shadow).
function capture(
  program: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  input?: string,
): CommandResult {
  const result = spawnSync(program, args, { encoding: 'utf8', env, input, timeout: 120_000 });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    spawnError: result.error?.message ?? '',
  };
}

// Управляющие символы экранируются (log/markdown injection), префикс у строк
// вывода команды не даёт строке начаться с `::`.
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

// Вывод команды дословно, построчно.
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

// Заголовок авторизации для конфиг-окружения git (блок e67): basic от пары
// «x-access-token:<токен>». Пустой токен — пустая строка.
function authorizationHeader(token: string): string {
  return token === ''
    ? ''
    : `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
}

// Конфиг-окружение дочернего git (блок e67): заголовок авторизации для github.com
// идёт переменными GIT_CONFIG_* — только процессам, которые ходят на remote, и
// на время команды; в argv, в env шага и в .git/config токена нет. Чужие записи
// конфиг-окружения не затираются — новая идёт после них.
function gitAuthEnv(token: string): NodeJS.ProcessEnv {
  const count = Number.parseInt(process.env['GIT_CONFIG_COUNT'] ?? '0', 10);
  if (!Number.isInteger(count) || count < 0) {
    throw new PublishFailure(
      'это шаг nightly-джобы «mutation ratchet (b2.4)», локально его не запускают.',
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
  return capture('git', ['-c', 'credential.helper=', ...args], gitAuth);
}

/** Предложение из файла decide; файла нет — null. Битый файл — красный, а не «нет предложения» (З11). */
function readProposal(proposalPath: string, configPaths: BreaksConfigPaths): ProposalFile | null {
  if (!existsSync(proposalPath)) {
    return null;
  }
  try {
    const proposal = ProposalFileSchema.parse(JSON.parse(readFileSync(proposalPath, 'utf8')));
    const currentBreaks: Breaks = {
      web: readBreakFromConfig(configPaths.web, 'web'),
      contracts: readBreakFromConfig(configPaths.contracts, 'contracts'),
    };
    validateProposals(proposal.proposals, configPaths, currentBreaks);
    return proposal;
  } catch (error) {
    throw new PublishFailure('ветка не тронута', [
      `✗ предложение ${proposalPath} не читается или не подходит к конфигам — ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
}

// Коммит через plumbing (решение e40): рабочее дерево, индекс и HEAD не
// трогаются, в коммит попадает дерево родителя с поднятыми порогами — ровно
// предложенные конфиги. База замены — порог в дереве родителя, а не `from`
// предложения: под открытым PR родитель — топ ветки, и порог там может быть
// выше сегодняшнего предложения (вчера счёт был выше); такой домен не трогаем
// — храповик не двигает порог вниз. null — поднимать нечего.
function commitRaisedThresholdsOn(
  parent: string,
  proposals: ProposalFile['proposals'],
  configPaths: BreaksConfigPaths,
): string | null {
  const untouched = 'ветка не тронута';
  const scratch = mkdtempSync(join(tmpdir(), 'mutation-ratchet-'));
  const indexEnv: NodeJS.ProcessEnv = { ...process.env, GIT_INDEX_FILE: join(scratch, 'index') };
  try {
    must(untouched, 'git read-tree', capture('git', ['read-tree', parent], indexEnv));
    let raised = false;
    for (const entry of proposals) {
      const path = configPaths[entry.domain];
      const shown = capture('git', ['show', `${parent}:${path}`]);
      if (shown.status !== 0) {
        throw new PublishFailure(untouched, commandFailed(`git show ${path}`, shown));
      }
      const parsed = StrykerThresholdsSchema.safeParse(parseJson(shown.stdout, path, untouched));
      if (!parsed.success) {
        throw new PublishFailure(untouched, [
          `✗ ${path}: в дереве родителя нет thresholds.break — ${parsed.error.message}`,
        ]);
      }
      const base = parsed.data.thresholds.break;
      if (base >= entry.to) {
        console.log(
          `publish: ${entry.domain} ${path}: порог в дереве родителя ${base} уже не ниже предложенного ${entry.to} — конфиг не тронут`,
        );
        continue;
      }
      const text = replaceBreakInConfigText(shown.stdout, base, entry.to, path);
      // Режим файла — как у родителя (100644); новых файлов предложение не создаёт.
      const mode =
        must(untouched, 'git ls-tree', capture('git', ['ls-tree', parent, '--', path])).split(
          /\s+/,
        )[0] ?? '100644';
      const blob = must(
        untouched,
        'git hash-object',
        capture('git', ['hash-object', '-w', '--stdin'], indexEnv, text),
      );
      must(
        untouched,
        'git update-index',
        capture(
          'git',
          ['update-index', '--add', '--cacheinfo', `${mode},${blob},${path}`],
          indexEnv,
        ),
      );
      console.log(`publish: ${entry.domain} ${path}: break ${base} → ${entry.to}`);
      raised = true;
    }
    if (!raised) {
      return null;
    }
    const tree = must(untouched, 'git write-tree', capture('git', ['write-tree'], indexEnv));
    return must(
      untouched,
      'git commit-tree',
      capture('git', [
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

function parseJson(text: string, path: string, untouched: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new PublishFailure(untouched, [
      `✗ ${path}: конфиг не читается — ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
}

function publishProposal(proposalPath: string, configPaths: BreaksConfigPaths): number {
  const token = process.env['GH_TOKEN'] ?? '';
  const repository = process.env['GITHUB_REPOSITORY'] ?? '';
  if (token === '' || repository === '') {
    throw new PublishFailure(
      'это шаг nightly-джобы «mutation ratchet (b2.4)», локально его не запускают.',
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

  const proposal = readProposal(proposalPath, configPaths);
  if (proposal === null || proposal.proposals.length === 0) {
    console.log('Устойчивого превышения нет — PR храповика не нужен.');
    return 0;
  }

  // «Уже открыт» узнаётся до create — отказ create за него не выдаётся.
  const listed = must(
    `${untouched} — проверь GH_TOKEN и права job (pull-requests: read).`,
    'gh pr list',
    capture('gh', listArgs),
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
      capture('git', ['rev-parse', '--verify', `${TRACKING_REF}^{commit}`]),
    );
  }
  const commit = commitRaisedThresholdsOn(parent, proposal.proposals, configPaths);
  if (commit === null) {
    if (open === null) {
      // Родитель — main, предложение считается от его же порогов: так бывает
      // только при расхождении checkout в job с предложением.
      throw new PublishFailure(untouched, [
        '✗ предложение не выше порогов HEAD — проверь состояние checkout в job.',
      ]);
    }
    console.log(
      `PR #${open.number} уже открыт — ветка ${RATCHET_BRANCH} не тронута: порог ветки уже не ниже предложенного: ${clean(open.url)}`,
    );
    return 0;
  }

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

  const created = capture('gh', [
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
    `${PR_BODY}\n\nПредложение nightly (прогон ${proposal.runId}, база ${proposal.sha}):\n${JSON.stringify(proposal.proposals, null, 2)}`,
  ]);
  if (created.status === 0) {
    console.log(`PR храповика создан: ${clean(created.stdout.trim())}`);
    console.log(CI_NOTE);
    return 0;
  }
  // PR могли открыть между list и create — перепроверяем, а не гадаем.
  const rechecked = capture('gh', listArgs);
  if (rechecked.status === 0) {
    try {
      const raced = parseOpenPullRequest(rechecked.stdout);
      if (raced !== null) {
        console.log(
          `PR #${raced.number} уже открыт — ${branchState} (commit ${commit.slice(0, 12)}): ${clean(raced.url)}`,
        );
        console.log(CI_NOTE);
        return 0;
      }
    } catch {
      // Ответ не читается — ниже честный отказ с причиной create дословно.
    }
  }
  throw new PublishFailure(
    `${branchState} — PR открывает человек:\n  gh pr create --base main --head ${RATCHET_BRANCH} --title "${PR_TITLE}"`,
    [...commandFailed('gh pr create', created), CI_NOTE],
  );
}

if (command === 'publish') {
  const configPaths: BreaksConfigPaths = {
    web: parseFlag(['--config-web']) ?? defaultConfigWeb,
    contracts: parseFlag(['--config-contracts']) ?? defaultConfigContracts,
  };
  const proposalPath = parseFlag(['--proposal']) ?? 'state/proposal.json';
  try {
    process.exit(publishProposal(proposalPath, configPaths));
  } catch (error) {
    if (error instanceof PublishFailure) {
      for (const line of error.lines) {
        console.log(line);
      }
      console.log(`Дальше человек: ${error.action}`);
    } else {
      console.log(`✗ publish: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(1);
  }
}

// недостижимо: все команды обработаны выше, неизвестная — usage()
usage();
