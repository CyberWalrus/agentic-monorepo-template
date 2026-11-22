/**
 * CLI храповика мутационных порогов web и контрактов (b2.4): подкоманды
 * check / fetch-state / decide / apply. Подробности, коды выходов и решения —
 * в шапке tools/check-mutation-ratchet.ts (чистое ядро, импортируется
 * тестами). Entry отделён от ядра, чтобы импорт из тестов не исполнял CLI
 * (как check-perf-trend(.main).ts).
 *
 * Коды выходов fetch-state — как у perf fetch-baseline (nightly.yml): 0 —
 * найден, 3 — ни у одного зелёного прогона (первый запуск), 1 — ошибка API.
 * Артефакты идут от новейшего к старшему: битый по схеме артефакт свежего
 * прогона не клинит канал, берётся предыдущий (находка arch-ревью A6.1).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkDomains,
  checkVerdict,
  decide,
  DOMAINS,
  type Breaks,
  type DomainCheckInput,
  MutationReportSchema,
  ProposalFileSchema,
  RatchetStateSchema,
  type ParsedDomain,
  StrykerThresholdsSchema,
  scoreFromReport,
  validateProposals,
} from './check-mutation-ratchet.ts';

const STATE_ARTIFACT = 'mutation-ratchet-state';
const STATE_FILE = 'ratchet-state.json';
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
      isRecord(artifact) && artifact['name'] === STATE_ARTIFACT && artifact['expired'] !== true,
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
    'Использование: node tools/check-mutation-ratchet.main.ts <check|fetch-state|decide|apply> [аргументы]',
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
        gh(['run', 'download', String(run.id), '-n', STATE_ARTIFACT, '-D', downloadDir]);
        state = RatchetStateSchema.parse(
          JSON.parse(readFileSync(join(downloadDir, STATE_FILE), 'utf8')),
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
    const target = join(out, STATE_FILE);
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
      const prevPath = join(prevDir, STATE_FILE);
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
  writeFileSync(join(stateOut, STATE_FILE), JSON.stringify(result.state, null, 2));
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
  console.log(`mutation-ratchet: состояние записано (${stateOut}/${STATE_FILE})`);
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
      const parsedConfig: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!isRecord(parsedConfig)) {
        throw new Error(`${path}: конфиг не объект`);
      }
      const rawThresholds = parsedConfig['thresholds'];
      const thresholds = isRecord(rawThresholds) ? rawThresholds : {};
      thresholds['break'] = entry.to;
      parsedConfig['thresholds'] = thresholds;
      writeFileSync(path, `${JSON.stringify(parsedConfig, null, 2)}\n`);
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

// недостижимо: все команды обработаны выше, неизвестная — usage()
usage();
