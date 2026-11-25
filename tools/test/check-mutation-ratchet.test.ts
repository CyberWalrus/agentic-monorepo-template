/**
 * Тесты храповика мутационных порогов (b2.4): ядро (счёт, зубья порога,
 * вердикт канарейки, решение, защита apply) — напрямую; CLI check/decide/
 * apply — спавном на фикстурах во временных каталогах. fetch-state (gh API)
 * в юнит-тестах не вызывается — только отказ по неизвестным аргументам.
 * Публикация (publish, e82) — исполнением текста шага «PR with raised
 * thresholds» из nightly.yml в подставном репозитории; проводка джоб
 * (Chromium для pre-push, needs канарейки) — чтением nightly.yml.
 * Проверки на PR автоматики (e85): шаг диспатчит ci.yml после create и после
 * push под открытым PR — отказ диспатча красит шаг; подставной gh отказывает
 * по файлу dispatch-refused, команду вне списка — кодом 99.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';

import {
  checkDomains,
  checkVerdict,
  decide,
  DOMAINS,
  type MutationReport,
  MutationReportSchema,
  ProposalFileSchema,
  RatchetStateSchema,
  scoreFromReport,
  STATE_ARTIFACT_NAME,
  STATE_FILE_NAME,
  StrykerThresholdsSchema,
  validateProposals,
} from '../check-mutation-ratchet.ts';

vi.setConfig({ testTimeout: 30_000 });

const repoDir = resolve(import.meta.dirname, '..', '..');
const cli = join(repoDir, 'tools', 'check-mutation-ratchet.main.ts');

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixtureDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `b24-ratchet-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

function reportJson(counts: {
  killed: number;
  timeout: number;
  survived: number;
  noCoverage: number;
}): string {
  const mutants: Array<{ status: string }> = [];
  for (let i = 0; i < counts.killed; i += 1) mutants.push({ status: 'Killed' });
  for (let i = 0; i < counts.timeout; i += 1) mutants.push({ status: 'Timeout' });
  for (let i = 0; i < counts.survived; i += 1) mutants.push({ status: 'Survived' });
  for (let i = 0; i < counts.noCoverage; i += 1) mutants.push({ status: 'NoCoverage' });
  const report: MutationReport = { files: { 'src/a.ts': { mutants } } };
  return JSON.stringify(report);
}

function writeReport(dir: string, name: string, content: string): string {
  const path = join(dir, name);
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('node', [cli, ...args], { encoding: 'utf8' });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

// ─── Ядро: счёт ───

it('scoreFromReport: формула (killed+timeout)/(killed+timeout+survived+noCoverage), база total', () => {
  const report = MutationReportSchema.parse(
    JSON.parse(reportJson({ killed: 8, timeout: 2, survived: 3, noCoverage: 1 })),
  );
  // 10/14 × 100 = 71.43 — covered был бы 83.33, порог ставится от total
  expect(scoreFromReport(report)).toBe(71.43);
});

it('scoreFromReport: пустой отчёт — ошибка (храповик не слепнет молча)', () => {
  const report = MutationReportSchema.parse({ files: { 'src/a.ts': { mutants: [] } } });
  expect(() => scoreFromReport(report)).toThrow('ни одного мутанта');
});

// ─── Ядро: зубья порога ───

it('checkDomains: ниже порога — нарушение, равенство порога проходит, нет/бит отчёта — структурные нарушения', () => {
  const below = checkDomains([{ domain: 'web', break: 67, parsed: { kind: 'ok', score: 66.99 } }]);
  expect(below).toEqual([
    { domain: 'web', kind: 'score-below-break', message: expect.stringContaining('66.99') },
  ]);
  expect(checkDomains([{ domain: 'web', break: 67, parsed: { kind: 'ok', score: 67 } }])).toEqual(
    [],
  );
  const missing = checkDomains([{ domain: 'web', break: 67, parsed: { kind: 'missing' } }]);
  expect(missing[0]?.kind).toBe('missing-report');
  const broken = checkDomains([
    { domain: 'web', break: 67, parsed: { kind: 'broken', message: 'Unexpected token' } },
  ]);
  expect(broken[0]?.kind).toBe('broken-report');
});

// ─── Ядро: вердикт канарейки ───

it('checkVerdict: обычный вызов зелёный без нарушений; инверсия зелёная только на «счёт ниже порога»', () => {
  expect(checkVerdict([], false).pass).toBe(true);
  expect(
    checkVerdict([{ domain: 'web', kind: 'score-below-break', message: 'x' }], false).pass,
  ).toBe(false);
  expect(
    checkVerdict([{ domain: 'web', kind: 'score-below-break', message: 'x' }], true).pass,
  ).toBe(true);
  // структурное нарушение инверсией не считается
  const structural = checkVerdict([{ domain: 'web', kind: 'missing-report', message: 'x' }], true);
  expect(structural.pass).toBe(false);
  expect(structural.reason).toContain('структурные');
  // пустой список при --expect-regression — «канарейка не ловит»
  const blind = checkVerdict([], true);
  expect(blind.pass).toBe(false);
  expect(blind.reason).toContain('не ловит');
});

// ─── Ядро: решение храповика ───

const baseInput = {
  break: { web: 67, contracts: 80 },
  sha: SHA_B,
  runId: 222,
  date: '2026-11-22T03:00:00.000Z',
};

it('decide: без прошлого состояния состояние пишется, предложений нет', () => {
  const result = decide({ ...baseInput, current: { web: 72.36, contracts: 85.71 }, prev: null });
  expect(result.proposals).toEqual([]);
  expect(result.notes.some((note) => note.includes('не набрано'))).toBe(true);
  expect(RatchetStateSchema.parse(result.state)).toEqual(result.state);
});

it('decide: устойчивое превышение — предложение по правилу ADR 0009 от минимума двух счётов', () => {
  const prev = RatchetStateSchema.parse({
    schema: 'mutation-ratchet-state/1',
    sha: SHA_A,
    runId: 111,
    date: '2026-11-21T03:00:00.000Z',
    scores: { web: 74.9, contracts: 85.71 },
    breakAtDecision: { web: 67, contracts: 80 },
  });
  const result = decide({ ...baseInput, current: { web: 74.5, contracts: 85.71 }, prev });
  expect(result.proposals).toEqual([
    {
      domain: 'web',
      configPath: DOMAINS.find((spec) => spec.domain === 'web')?.configPath,
      from: 67,
      to: 69,
    },
  ]);
});

it('decide: домен без окна не предлагает, домен с окном предлагает; правило ровно в порог — не двигает', () => {
  const prev = RatchetStateSchema.parse({
    schema: 'mutation-ratchet-state/1',
    sha: SHA_A,
    runId: 111,
    date: '2026-11-21T03:00:00.000Z',
    scores: { web: 74.5, contracts: 66 }, // contracts ниже break 80 — окна нет
    breakAtDecision: { web: 67, contracts: 80 },
  });
  const result = decide({ ...baseInput, current: { web: 74.5, contracts: 85.71 }, prev });
  // web: 74.5/74.5 выше 67 → floor(74.5) − 5 = 69 > 67 — предложение есть;
  // contracts: prev 66 < 80 — «устойчивого превышения нет»
  expect(result.proposals).toEqual([
    {
      domain: 'web',
      configPath: DOMAINS.find((spec) => spec.domain === 'web')?.configPath,
      from: 67,
      to: 69,
    },
  ]);
  expect(
    result.notes.some(
      (note) => note.startsWith('contracts:') && note.includes('устойчивого превышения нет'),
    ),
  ).toBe(true);

  // правило от минимума даёт ровно текущий порог (72.36 → 67) — не предложение
  const prevSame = { ...prev, scores: { web: 74.5, contracts: 85.71 } };
  const same = decide({ ...baseInput, current: { web: 72.36, contracts: 85.71 }, prev: prevSame });
  expect(same.proposals).toEqual([]);
  expect(same.notes.some((note) => note.includes('храповик не двигается'))).toBe(true);
});

it('ProposalFileSchema/RatchetStateSchema: недоверенные входы со сломанным sha отклоняются', () => {
  expect(
    RatchetStateSchema.safeParse({
      schema: 'mutation-ratchet-state/1',
      sha: 'not-hex',
      runId: 1,
      date: '2026-11-21T03:00:00.000Z',
      scores: { web: 1, contracts: 1 },
      breakAtDecision: { web: 1, contracts: 1 },
    }).success,
  ).toBe(false);
  expect(
    ProposalFileSchema.safeParse({
      schema: 'mutation-ratchet-proposal/1',
      sha: SHA_A,
      runId: 1,
      proposals: [{ domain: 'web', configPath: 'x', from: 67, to: 67.5 }],
    }).success,
  ).toBe(false); // to обязан быть целым (округление вниз правила)
});

// ─── Ядро: защита apply ───

it('validateProposals: только вверх, база from совпадает с текущим порогом, конфиг известен', () => {
  const configPaths = {
    web: 'apps/web/stryker.conf.json',
    contracts: 'packages/contracts/stryker.conf.json',
  };
  expect(() =>
    validateProposals(
      [{ domain: 'web', configPath: configPaths.web, from: 67, to: 69 }],
      configPaths,
      {
        web: 67,
        contracts: 80,
      },
    ),
  ).not.toThrow();
  expect(() =>
    validateProposals(
      [{ domain: 'web', configPath: configPaths.web, from: 67, to: 66 }],
      configPaths,
      {
        web: 67,
        contracts: 80,
      },
    ),
  ).toThrow('не двигает порог вниз');
  expect(() =>
    validateProposals(
      [{ domain: 'web', configPath: configPaths.web, from: 66, to: 69 }],
      configPaths,
      {
        web: 67,
        contracts: 80,
      },
    ),
  ).toThrow('не совпадает с текущим порогом');
  expect(() =>
    validateProposals(
      [{ domain: 'web', configPath: 'tools/evil.json', from: 67, to: 69 }],
      configPaths,
      { web: 67, contracts: 80 },
    ),
  ).toThrow('неизвестный конфиг');
});

// ─── CLI: check ───

it('check: зелёный на счётах выше порогов из конфигов', () => {
  const dir = fixtureDir('check-green');
  const web = writeReport(
    dir,
    'web/reports/mutation/mutation.json',
    reportJson({ killed: 72, timeout: 1, survived: 10, noCoverage: 8 }),
  );
  const contracts = writeReport(
    dir,
    'contracts/reports/mutation/mutation.json',
    reportJson({ killed: 48, timeout: 1, survived: 2, noCoverage: 5 }),
  );
  const configWeb = writeReport(
    dir,
    'web.conf.json',
    JSON.stringify({ thresholds: { break: 67 } }),
  );
  const configContracts = writeReport(
    dir,
    'contracts.conf.json',
    JSON.stringify({ thresholds: { break: 80 } }),
  );
  const result = runCli([
    'check',
    '--web',
    web,
    '--contracts',
    contracts,
    '--config-web',
    configWeb,
    '--config-contracts',
    configContracts,
  ]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('не ниже порогов');
});

it('check: счёт ниже порога красит (exit 1)', () => {
  const dir = fixtureDir('check-red');
  // 35/78 = 44.87 — ниже порога 67
  const web = writeReport(
    dir,
    'web/reports/mutation/mutation.json',
    reportJson({ killed: 35, timeout: 0, survived: 20, noCoverage: 23 }),
  );
  const result = runCli([
    'check',
    '--web',
    web,
    '--break-override',
    'web=67',
    '--break-override',
    'contracts=80',
  ]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('score-below-break');
});

it('check: отсутствующий отчёт — красный (fail-closed), битый отчёт — красный', () => {
  const dir = fixtureDir('check-missing');
  const result = runCli([
    'check',
    '--web',
    join(dir, 'nope.json'),
    '--break-override',
    'web=1',
    '--break-override',
    'contracts=1',
  ]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('missing-report');

  const junk = writeReport(dir, 'junk/mutation.json', '{not json');
  const result2 = runCli([
    'check',
    '--web',
    junk,
    '--break-override',
    'web=1',
    '--break-override',
    'contracts=1',
  ]);
  expect(result2.status).toBe(1);
  expect(result2.stderr).toContain('broken-report');
});

it('check: канарейка — завышенный порог обязан дать нарушение (инверсия зелёная), честные пороги — «не ловит»', () => {
  const dir = fixtureDir('check-canary');
  const web = writeReport(
    dir,
    'web/reports/mutation/mutation.json',
    reportJson({ killed: 72, timeout: 1, survived: 10, noCoverage: 8 }),
  );
  const good = [
    'check',
    '--web',
    web,
    '--contracts',
    web,
    '--break-override',
    'web=1000',
    '--break-override',
    'contracts=1000',
    '--expect-regression',
  ];
  expect(runCli(good).status).toBe(0);
  const blind = runCli([
    'check',
    '--web',
    web,
    '--contracts',
    web,
    '--break-override',
    'web=50',
    '--break-override',
    'contracts=50',
    '--expect-regression',
  ]);
  expect(blind.status).toBe(1);
  expect(blind.stderr).toContain('не ловит');
});

it('check: неизвестный аргумент — exit 2', () => {
  expect(runCli(['check', '--evil']).status).toBe(2);
});

// ─── CLI: decide ───

function writePrev(dir: string, scores: { web: number; contracts: number }): string {
  const prevDir = join(dir, 'prev');
  mkdirSync(prevDir, { recursive: true });
  writeFileSync(
    join(prevDir, 'ratchet-state.json'),
    JSON.stringify({
      schema: 'mutation-ratchet-state/1',
      sha: SHA_A,
      runId: 111,
      date: '2026-11-21T03:00:00.000Z',
      scores,
      breakAtDecision: { web: 67, contracts: 80 },
    }),
  );
  return prevDir;
}

it('decide: устойчивое превышение пишет состояние и предложение; без окна — только состояние', () => {
  const dir = fixtureDir('decide');
  const web = writeReport(
    dir,
    'web/reports/mutation/mutation.json',
    reportJson({ killed: 74, timeout: 0, survived: 9, noCoverage: 8 }),
  );
  const contracts = writeReport(
    dir,
    'contracts/reports/mutation/mutation.json',
    reportJson({ killed: 48, timeout: 1, survived: 2, noCoverage: 5 }),
  );
  const configWeb = writeReport(
    dir,
    'web.conf.json',
    JSON.stringify({ thresholds: { break: 67 } }),
  );
  const configContracts = writeReport(
    dir,
    'contracts.conf.json',
    JSON.stringify({ thresholds: { break: 80 } }),
  );
  // web: 74/91 = 81.32 → floor 81 − 5 = 76 > 67; contracts: 49/56 = 87.5 →
  // floor 87 − 5 = 82 > 80; prev 89.16/89.16 выше порогов — окно набрано
  const args = [
    'decide',
    '--web',
    web,
    '--contracts',
    contracts,
    '--config-web',
    configWeb,
    '--config-contracts',
    configContracts,
    '--prev',
    writePrev(dir, { web: 89.16, contracts: 89.16 }),
    '--state-out',
    join(dir, 'state'),
    '--proposal-out',
    join(dir, 'state', 'proposal.json'),
    '--head-sha',
    SHA_B,
    '--run-id',
    '222',
    '--date',
    '2026-11-22T03:00:00.000Z',
  ];
  const result = runCli(args);
  expect(result.status).toBe(0);
  const proposal = ProposalFileSchema.parse(
    JSON.parse(readFileSync(join(dir, 'state', 'proposal.json'), 'utf8')),
  );
  expect(proposal.proposals.map((entry) => entry.to)).toEqual([76, 82]);
  expect(readFileSync(join(dir, 'state', 'ratchet-state.json'), 'utf8')).toContain(
    'mutation-ratchet-state/1',
  );

  const noWindow = runCli([
    ...args.slice(0, args.indexOf('--prev')),
    ...args.slice(args.indexOf('--prev') + 2),
  ]);
  expect(noWindow.status).toBe(0);
  // без окна proposal.json не пишется — отсутствие файла и есть «предложений нет»
  expect(() => readFileSync(join(dir, 'state', 'proposal.json'), 'utf8')).toThrow('ENOENT');
});

it('decide: не-hex sha — exit 2', () => {
  const dir = fixtureDir('decide-bad-sha');
  const result = runCli([
    'decide',
    '--state-out',
    join(dir, 'state'),
    '--head-sha',
    'nothex',
    '--run-id',
    '1',
  ]);
  expect(result.status).toBe(2);
});

// ─── CLI: apply ───

it('apply: поднимает порог в конфиге; вниз и по устаревшей базе — отказ без записи', () => {
  const dir = fixtureDir('apply');
  const proposalPath = (to: number, from: number): string =>
    writeReport(
      dir,
      `proposal-${to}-${from}.json`,
      JSON.stringify({
        schema: 'mutation-ratchet-proposal/1',
        sha: SHA_B,
        runId: 222,
        proposals: [{ domain: 'web', configPath: 'apps/web/stryker.conf.json', from, to }],
      }),
    );
  const configWeb = writeReport(
    dir,
    'web.conf.json',
    JSON.stringify({ thresholds: { break: 67 } }),
  );
  const configContracts = writeReport(
    dir,
    'contracts.conf.json',
    JSON.stringify({ thresholds: { break: 80 } }),
  );

  const up = runCli([
    'apply',
    '--proposal',
    proposalPath(69, 67),
    '--config-web',
    configWeb,
    '--config-contracts',
    configContracts,
  ]);
  expect(up.status).toBe(0);
  // точная замена: остальной байт-в-байт текст конфига не тронут
  expect(readFileSync(configWeb, 'utf8')).toBe('{"thresholds":{"break":69}}');

  const down = runCli([
    'apply',
    '--proposal',
    proposalPath(66, 69),
    '--config-web',
    configWeb,
    '--config-contracts',
    configContracts,
  ]);
  expect(down.status).toBe(1);
  expect(readFileSync(configWeb, 'utf8')).toBe('{"thresholds":{"break":69}}');

  const stale = runCli([
    'apply',
    '--proposal',
    proposalPath(72, 67),
    '--config-web',
    configWeb,
    '--config-contracts',
    configContracts,
  ]);
  expect(stale.status).toBe(1);
  expect(stale.stderr).toContain('не совпадает с текущим порогом');
  expect(readFileSync(configWeb, 'utf8')).toBe('{"thresholds":{"break":69}}');
});

it('apply: формат конфига сохраняется — меняется только число, oxfmt --check проходит', () => {
  const dir = fixtureDir('apply-format');
  // Копия РЕАЛЬНОГО конфига репо: короткие массивы oxfmt держит в одну строку,
  // JSON.stringify их разворачивал бы и красил format:check PR храповика
  // (находка ревью PR #142).
  const original = readFileSync(join(repoDir, 'apps', 'web', 'stryker.conf.json'), 'utf8');
  // Порог прочитанного конфига — из файла (той же схемой, что читает его CLI),
  // а не литералом: 67 был верен, пока храповик не поднял порог (PR #289), и
  // apply отказывал «ровно одно значение break=67 … найдено 0» — тест красил
  // собственный PR храповика (e83).
  const current = StrykerThresholdsSchema.parse(JSON.parse(original)).thresholds.break;
  const configContracts = writeReport(
    dir,
    'contracts.conf.json',
    JSON.stringify({ thresholds: { break: 80 } }),
  );
  // Тот же прогон на двух порогах: фактическом и на два зубца выше (ветка
  // храповика после первого срабатывания). Литерал, равный порогу main, красит
  // тест уже на main, а не на следующем поднятии порога.
  const appliedConfigs: string[] = [];
  for (const raised of [0, 2]) {
    const from = current + raised;
    const to = from + 2;
    const base = original.replace(`"break": ${current}`, `"break": ${from}`);
    const configWeb = writeReport(dir, `web-${raised}.conf.json`, base);
    const proposalPath = writeReport(
      dir,
      `proposal-${raised}.json`,
      JSON.stringify({
        schema: 'mutation-ratchet-proposal/1',
        sha: SHA_B,
        runId: 222,
        proposals: [{ domain: 'web', configPath: 'apps/web/stryker.conf.json', from, to }],
      }),
    );
    const result = runCli([
      'apply',
      '--proposal',
      proposalPath,
      '--config-web',
      configWeb,
      '--config-contracts',
      configContracts,
    ]);
    expect(result.status).toBe(0);
    expect(readFileSync(configWeb, 'utf8')).toBe(
      base.replace(`"break": ${from}`, `"break": ${to}`),
    );
    appliedConfigs.push(configWeb);
  }
  const oxfmt = spawnSync('pnpm', ['exec', 'oxfmt', '--check', ...appliedConfigs], {
    encoding: 'utf8',
  });
  expect(oxfmt.status).toBe(0);
});

it('apply: не единственное вхождение break — отказ без записи', () => {
  const dir = fixtureDir('apply-ambiguous');
  const configWeb = writeReport(
    dir,
    'web.conf.json',
    '{"thresholds": {"break": 67}, "note": {"break": 67}}',
  );
  const configContracts = writeReport(
    dir,
    'contracts.conf.json',
    JSON.stringify({ thresholds: { break: 80 } }),
  );
  const proposalPath = writeReport(
    dir,
    'proposal.json',
    JSON.stringify({
      schema: 'mutation-ratchet-proposal/1',
      sha: SHA_B,
      runId: 222,
      proposals: [{ domain: 'web', configPath: 'apps/web/stryker.conf.json', from: 67, to: 69 }],
    }),
  );
  const result = runCli([
    'apply',
    '--proposal',
    proposalPath,
    '--config-web',
    configWeb,
    '--config-contracts',
    configContracts,
  ]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('ожидалось ровно одно значение break=67');
  expect(readFileSync(configWeb, 'utf8')).toBe(
    '{"thresholds": {"break": 67}, "note": {"break": 67}}',
  );
});

// ─── CLI: fetch-state — только разбор аргументов (gh API в юнит-тестах не зовётся) ───

it('fetch-state: неизвестный аргумент — exit 2; без --out — exit 2', () => {
  expect(runCli(['fetch-state', '--evil']).status).toBe(2);
  expect(runCli(['fetch-state']).status).toBe(2);
});

// ─── Workflow ↔ константы: соответствие имён upload ↔ download ↔ read (e33) ───
// Разводка текста workflow и чекера — тот самый дрейф, что ослепил храповик в
// первом же прогоне (nightly 45013082390): upload-artifact с одним каталогом в
// path кладёт его содержимое в КОРЕНЬ артефакта, поэтому отчёт после `gh run
// download -D work/web/reports/mutation` лежит в work/web/reports/mutation/
// mutation.json, и путь чтения обязан быть зеркалом reportPath из DOMAINS под
// work/, а имена артефактов — константами из одного места.

it('nightly.yml: имена артефактов и пути чтения — из констант чекера (upload ↔ download ↔ read)', () => {
  const workflow = readFileSync(join(repoDir, '.github', 'workflows', 'nightly.yml'), 'utf8');

  for (const spec of DOMAINS) {
    const uploadDir = spec.reportPath.slice(0, spec.reportPath.lastIndexOf('/')) + '/';
    // work-зеркало reportPath: work + reportPath без первого сегмента каталога
    const readPath = `work${spec.reportPath.slice(spec.reportPath.indexOf('/'))}`;
    const downloadDir = readPath.slice(0, readPath.lastIndexOf('/'));

    // upload в mutation-full: имя артефакта — константа DOMAINS.artifactName,
    // path — каталог отчёта (его содержимое и есть артефакт)
    expect(workflow).toContain(`with: { name: ${spec.artifactName}, path: ${uploadDir} }`);

    // download ровно в двух джобах (mutation-ratchet и mutation-canary):
    // имя из DOMAINS.artifactName, каталог — work-зеркало
    const downloadLine = `gh run download "\${{ github.run_id }}" -n ${spec.artifactName} -D ${downloadDir}`;
    expect(workflow.split(downloadLine).length - 1).toBe(2);

    // пути чтения чекера: download-dir + имя файла отчёта — check, decide и canary
    const readArg = `--${spec.domain} ${readPath}`;
    expect(workflow.split(readArg).length - 1).toBe(3);
  }

  // артефакт состояния: имя и файл — те же константы, что читает fetch-state
  expect(workflow).toContain(
    `with: { name: ${STATE_ARTIFACT_NAME}, path: state/${STATE_FILE_NAME} }`,
  );
});

// ─── e82: публикация храповика — шаг «PR with raised thresholds» ───
// Канарейки «PR создан или громкая ошибка» по образцу e40
// (tools/test/test-count-ratchet.test.ts): шаг исполняется тем текстом, что
// читает runner из nightly.yml, — в подставном репозитории: bare-репозиторий
// вместо github.com (url.insteadOf подменяет URL команды), подставной gh на
// PATH, git на PATH — обёртка, пишущая argv и конфиг-окружение каждого вызова.
// Замаскированный `|| echo` ловится исполнением шага, а не поиском подстроки:
// ночь 25.11 (45619705671) ушла зелёным шагом без PR.

const indentOf = (line: string): number => line.length - line.trimStart().length;

function nightlyLines(): string[] {
  return readFileSync(join(repoDir, '.github', 'workflows', 'nightly.yml'), 'utf8').split('\n');
}

/** Индекс строки `- name: <шаг>` в nightly.yml; нет — ошибка фикстуры. */
function stepStart(stepName: string): number {
  const start = nightlyLines().findIndex((line) => line.trim() === `- name: ${stepName}`);
  if (start === -1) {
    throw new Error(`step "${stepName}" not found in nightly.yml`);
  }
  return start;
}

/** Текст шага (`run:`) из nightly.yml — тот самый, который исполняет runner. */
function stepScript(stepName: string): string {
  const lines = nightlyLines();
  const start = stepStart(stepName);
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

/** Строки шага без комментариев: от `- name:` до конца шага. */
function stepCodeLines(stepName: string): string[] {
  const lines = nightlyLines();
  const start = stepStart(stepName);
  const stepIndent = indentOf(lines[start] ?? '');
  const block: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim() !== '' && indentOf(line) <= stepIndent) {
      break;
    }
    if (!line.trimStart().startsWith('#')) {
      block.push(line);
    }
  }
  return block;
}

/** Блок джобы nightly.yml — от её ключа до начала следующей джобы. */
function jobLines(jobName: string): string[] {
  const lines = nightlyLines();
  const start = lines.findIndex((line) => line === `  ${jobName}:`);
  if (start === -1) {
    throw new Error(`job "${jobName}" not found in nightly.yml`);
  }
  const end = lines.findIndex((line, index) => index > start && /^ {2}\S/.test(line));
  return lines.slice(start, end === -1 ? lines.length : end);
}

/** Блок джобы без строк-комментариев: комментарий — не шаг, не needs и не if. */
function jobCodeLines(jobName: string): string[] {
  return jobLines(jobName).filter((line) => !line.trimStart().startsWith('#'));
}

/**
 * `needs` джобы — только записи массива (в квадратных скобках или списком
 * `- …`), без комментариев: причина, записанная у needs комментарием, — не
 * запись.
 */
function jobNeeds(jobName: string): string[] {
  const lines = jobCodeLines(jobName);
  const start = lines.findIndex((line) => /^ {4}needs:/.test(line));
  if (start === -1) {
    return [];
  }
  const body: string[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    // Комментарий в конце строки («needs: [a]  # …») — тоже не запись.
    const code = line.replace(/\s+#.*$/, '').trim();
    if (index > start && code !== '' && indentOf(line) <= 4) {
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

/** Ключи job nightly.yml — строки `  <name>:` после `jobs:`. */
function jobNames(): string[] {
  const lines = nightlyLines();
  return lines.slice(lines.indexOf('jobs:') + 1).flatMap((line) => {
    const match = /^ {2}([A-Za-z0-9_-]+):$/.exec(line);
    return match?.[1] === undefined ? [] : [match[1]];
  });
}

/** Джоба подключает $.github/actions/setup с `playwright: 'true'`. */
function setupHasPlaywright(jobName: string): boolean {
  const lines = jobCodeLines(jobName);
  const index = lines.findIndex((line) => line.trim() === '- uses: $/.github/actions/setup');
  return index !== -1 && /^with: \{ playwright: 'true' \}$/.test(lines[index + 1]?.trim() ?? '');
}

it('проводка e82: джоба nightly.yml, которая делает push, ставит Chromium (setup с playwright)', () => {
  // Push в тексте джобы или в скрипте, который она вызывает: обоим нужно
  // право contents: write — по нему джоба и распознаётся. Push поднимает
  // pre-push хук (lefthook.yml), а turbo test включает @repo/ui#test — vitest
  // browser mode; без Chromium хук отклоняет push (e31 — test-count-ratchet,
  // e82 — mutation ratchet: ночь 25.11, "Executable doesn't exist").
  const pushing = jobNames().filter((job) => {
    const code = jobCodeLines(job).join('\n');
    return /\bgit push\b/.test(code) || /^ {6}contents: write\b/m.test(code);
  });
  // Канарейка не пустая: обе храповиковые джобы в ней.
  expect(pushing).toEqual(expect.arrayContaining(['mutation-ratchet', 'test-count-ratchet']));
  for (const job of pushing) {
    expect({ job, chromium: setupHasPlaywright(job) }).toEqual({ job, chromium: true });
  }
});

it('проводка e82: канарейка храповика исполняется и при красном шаге публикации — needs ровно [mutation-full], без if', () => {
  // needs: [mutation-ratchet] без условия пропускала канарейку (skipped) в
  // обеих красных ночах 25.11 — ровно когда храповик активен. Канарейке нужны
  // только отчёты mutation-full; возврат зависимости — красный.
  expect(jobNeeds('mutation-canary')).toEqual(['mutation-full']);
  expect(jobNeeds('mutation-canary')).not.toContain('mutation-ratchet');
  expect(jobCodeLines('mutation-canary').filter((line) => /^ {4}if:/.test(line))).toEqual([]);
  // Красная канарейка по-прежнему заводит issue «Nightly failed»; красный шаг
  // публикации храповика — тоже (job report слушает обе джобы).
  expect(jobNeeds('report')).toContain('mutation-canary');
  expect(jobNeeds('report')).toContain('mutation-ratchet');
});

it('текст шага публикации — без глушения: ни `|| true`, ни `|| echo`, ни continue-on-error', () => {
  const text = stepCodeLines('PR with raised thresholds').join('\n');
  expect(text).toContain('check-mutation-ratchet.main.ts publish');
  expect(text).not.toContain('|| true');
  expect(text).not.toContain('|| echo');
  expect(text).not.toContain('continue-on-error');
});

it('проводка e85: джоба мутационного храповика имеет право actions: write — без него диспатч ci.yml отклоняют', () => {
  expect(jobCodeLines('mutation-ratchet').join('\n')).toMatch(/^ {6}actions: write\b/m);
});

const BRANCH = 'chore/mutation-ratchet-web-contracts';
// Скрипт ходит на github.com; insteadOf в подставном клоне уводит команду в
// bare-репозиторий. Токен в URL не ходит (e67): авторизация — конфиг-окружением
// git (GIT_CONFIG_*), заголовок скрипт собирает из GH_TOKEN.
const REMOTE_URL = 'https://github.com/org/repo.git';
const TOKEN = 'tok';
/** Так шаг ходил на remote до e82 — токен в argv. */
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
const NETWORK_FAILURE =
  "fatal: unable to access 'https://github.com/org/repo.git': simulated network failure";
/** Отказ диспатча: у джобы нет права actions: write. */
const DISPATCH_REFUSED =
  'gh: HTTP 403: Resource not accessible by integration (https://api.github.com/repos/org/repo/actions/workflows/ci%2Eyml/dispatches)';
/** Вызов диспатча ci.yml на ветку храповика — как его пишет подставной gh в calls.log. */
const DISPATCH_CALL = `workflow run ci.yml --repo org/repo --ref ${BRANCH}`;
const CONFIG_PATH = {
  web: 'apps/web/stryker.conf.json',
  contracts: 'packages/contracts/stryker.conf.json',
} as const;
/** Пороги на main фикстуры; предложение всегда выше — храповик идёт вверх. */
const MAIN_BREAKS = { web: 67, contracts: 40 } as const;
const PR_OPEN = JSON.stringify([{ number: 7, url: 'https://github.com/org/repo/pull/7' }]);

interface Proposal {
  domain: 'web' | 'contracts';
  from: number;
  to: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
# Подставной gh (e82): вызовы — в calls.log, ответы — файлами $FAKE_GH_DIR.
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
  throw new Error('git не найден в PATH — фикстура e82 не соберётся.');
}

const FAKE_GIT = `#!/bin/sh
# Обёртка git (e82): argv и конфиг-окружение вызова — в git-calls.log, затем настоящий git.
# Токен фикстуры фиктивный, поэтому значение конфигурации пишется целиком.
printf 'argv:%s\\nconfig:%s|%s|%s\\n' "$*" "\${GIT_CONFIG_COUNT:-}" "\${GIT_CONFIG_KEY_0:-}" "\${GIT_CONFIG_VALUE_0:-}" >> "$FAKE_GH_DIR/git-calls.log"
if [ -f "$FAKE_GH_DIR/remote-fails" ]; then
  case "$*" in
    *" ls-remote "*|*" fetch --no-tags "*)
      echo "${NETWORK_FAILURE}" >&2
      exit 128
      ;;
  esac
fi
exec "${realGit}" "$@"
`;

const prTmp = mkdtempSync(join(tmpdir(), 'e82-ratchet-pr-'));
afterAll(() => {
  rmSync(prTmp, { recursive: true, force: true });
});

let prCounter = 0;

interface RatchetRepo {
  /** Клон на main: здесь ночная джоба исполняет шаг. */
  dir: string;
  /** Bare-репозиторий — «remote» вместо github.com. */
  remote: string;
  /** Состояние подставного gh: pr-list.json, create-refused, list-fails, remote-fails, dispatch-refused. */
  ghState: string;
  /** Одна ночь: конфиги — как на main, предложение храповика (пусто — файла нет). */
  night(proposations: Proposal[]): void;
  runStep(): { status: number | null; output: string };
  ghCalls(): string[];
  /** Вызовы git, порождённые шагом: argv и конфиг-окружение каждого. */
  gitCalls(): { argv: string; config: string }[];
  remoteTip(): string;
  remoteBreaks(): { web: number; contracts: number };
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
  for (const domain of ['web', 'contracts'] as const) {
    const path = CONFIG_PATH[domain];
    mkdirSync(resolve(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), `{"thresholds": {"break": ${MAIN_BREAKS[domain]}}}\n`);
  }
  gitText(dir, ['add', '.']);
  gitText(dir, ['commit', '-qm', 'base']);
  // Скрипт шага — настоящий чекер репозитория (символическая ссылка вместо
  // копии CLI, ядра и телеметрии): исправление проверяется на том коде, что
  // уйдёт в main.
  symlinkSync(join(repoDir, 'tools'), join(dir, 'tools'), 'dir');
  writeFileSync(join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
  writeFileSync(join(bin, 'git'), FAKE_GIT, { mode: 0o755 });
  writeFileSync(join(ghState, 'pr-list.json'), '[]');
  const remoteBreak = (path: string): number => {
    const parsed: unknown = JSON.parse(gitText(dir, ['show', `FETCH_HEAD:${path}`]));
    return isRecord(parsed) &&
      isRecord(parsed['thresholds']) &&
      typeof parsed['thresholds']['break'] === 'number'
      ? parsed['thresholds']['break']
      : Number.NaN;
  };
  return {
    dir,
    remote,
    ghState,
    night(proposals) {
      // Конфиги — как на main. Шаг рабочее дерево не трогает; файлы пишутся
      // напрямую, без git checkout: каждая ночь — запуск шага, а бюджет шага
      // test:hooks на CI и без того близок (38 с из 50 с, артефакт 45619705671).
      for (const domain of ['web', 'contracts'] as const) {
        writeFileSync(
          join(dir, CONFIG_PATH[domain]),
          `{"thresholds": {"break": ${MAIN_BREAKS[domain]}}}\n`,
        );
      }
      mkdirSync(join(dir, 'state'), { recursive: true });
      const file = join(dir, 'state', 'proposal.json');
      if (proposals.length === 0) {
        rmSync(file, { force: true });
        return;
      }
      writeFileSync(
        file,
        JSON.stringify({
          schema: 'mutation-ratchet-proposal/1',
          sha: SHA_A,
          runId: 1,
          proposals: proposals.map(({ domain, from, to }) => ({
            domain,
            configPath: CONFIG_PATH[domain],
            from,
            to,
          })),
        }),
      );
    },
    runStep() {
      const script = join(root, 'step.sh');
      writeFileSync(script, stepScript('PR with raised thresholds'));
      // Как runner на linux: bash --noprofile --norc -eo pipefail <script>.
      const run = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          ...neutralEnv(),
          PATH: `${bin}${delimiter}${process.env['PATH'] ?? ''}`,
          GH_TOKEN: TOKEN,
          GITHUB_REPOSITORY: 'org/repo',
          FAKE_GH_DIR: ghState,
        },
      });
      return { status: run.status, output: `${run.stdout}${run.stderr}` };
    },
    ghCalls() {
      return readLog(join(ghState, 'calls.log'));
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
    remoteBreaks() {
      gitText(dir, ['fetch', '-q', REMOTE_URL, `refs/heads/${BRANCH}`]);
      return { web: remoteBreak(CONFIG_PATH.web), contracts: remoteBreak(CONFIG_PATH.contracts) };
    },
  };
}

/**
 * Фикстура-«история»: одна на группу ночей, тесты файла идут по порядку.
 * Каждая ночь — исполнение шага (node, git, gh); отдельный репозиторий на
 * каждый тест стоил бы ещё ~10 запусков шага — бюджет шага test:hooks на CI
 * близок (38 с из 50 с до e82, артефакт nightly 45619705671).
 */
const stories = new Map<string, RatchetRepo>();

function story(name: string): RatchetRepo {
  let repo = stories.get(name);
  if (repo === undefined) {
    repo = ratchetRepo();
    stories.set(name, repo);
  }
  return repo;
}

/** argv вызовов git истории с ночи `since` (журнал вызовов накопительный). */
function gitCallsSince(repo: RatchetRepo, since: number): string {
  return repo
    .gitCalls()
    .slice(since)
    .map(({ argv }) => argv)
    .join('\n');
}

it('create отказал, и это не «уже открыт» — шаг красный: exit 1, причина дословно, действие человека', () => {
  // История «без PR», ночь 1: ветки на remote ещё нет.
  const repo = story('без PR');
  writeFileSync(join(repo.ghState, 'create-refused'), '');
  repo.night([{ domain: 'web', from: 67, to: 69 }]);

  const run = repo.runStep();

  expect(run.status).toBe(1);
  expect(run.output).toContain(REFUSED);
  // Первая ночь: ветки на remote не было — действие человека называет «создана».
  expect(run.output).toContain(
    'ветка chore/mutation-ratchet-web-contracts создана — PR открывает человек',
  );
  expect(run.output).toContain(
    'gh pr create --base main --head chore/mutation-ratchet-web-contracts',
  );
  expect(run.output).not.toContain('уже открыт');
  // Сообщение говорит правду: ветка и правда создана — с поднятым порогом.
  expect(repo.remoteBreaks()).toEqual({ web: 69, contracts: 40 });
  // Коммит собран plumbing-ом: рабочее дерево, индекс и HEAD шага не тронуты —
  // checkout остаётся на main (прежде шаг уходил в ветку храповика).
  expect(gitText(repo.dir, ['status', '--porcelain', '--untracked-files=no'])).toBe('');
  expect(gitText(repo.dir, ['branch', '--show-current'])).toBe('main');
  // PR откроет человек — его событие opened запустит проверки само: ни диспатча
  // (e85: диспатч — только с существующим PR), ни заметки о запуске CI; вывод
  // называет обязательный label.
  expect(repo.ghCalls().join('\n')).not.toContain('workflow run');
  expect(run.output).not.toContain('CI (ci.yml)');
  expect(run.output).toContain('событие opened запустит ci.yml и gate-integrity.yml');
});

it('create удался — PR создан, CI запущен диспатчем на ветку храповика, шаг зелёный', () => {
  // История «с PR», ночь 1: ветка с поднятыми порогами уходит на remote, PR
  // создаёт сам шаг (дальше — фон открытого PR).
  const repo = story('с PR');
  repo.night([
    { domain: 'web', from: 67, to: 69 },
    { domain: 'contracts', from: 40, to: 44 },
  ]);

  const run = repo.runStep();

  expect(run.status).toBe(0);
  expect(run.output).toContain('PR храповика создан: https://github.com/org/repo/pull/42');
  expect(run.output).toContain('CI (ci.yml) на head SHA запущен диспатчем');
  expect(run.output).toContain('gate-integrity и bundle-approval автоматика не запускает');
  expect(run.output).toContain('gate-change-approved');
  const calls = repo.ghCalls();
  // Диспатч — ровно один и после create: диспатч ветки без PR гонял бы CI впустую.
  expect(calls.filter((call) => call.startsWith('workflow run'))).toEqual([DISPATCH_CALL]);
  const createAt = calls.findIndex((call) => call.startsWith('pr create'));
  expect(createAt).toBeGreaterThanOrEqual(0);
  expect(createAt).toBeLessThan(calls.indexOf(DISPATCH_CALL));
  // «PR не одобряет сам себя» (e85, п. 4): с включённой настройкой право
  // pull-requests: write позволяет и одобрить PR — шаг зовёт gh только этими
  // командами (подставной gh отвечает 99 на любую другую). Тело PR в логе
  // многострочное — судим по строкам, начинающимся с подкоманды gh.
  expect(
    calls.filter(
      (line) =>
        /^(pr|api|workflow)\b/.test(line) &&
        !/^(pr list|pr create|workflow run ci\.yml) /.test(line),
    ),
  ).toEqual([]);
  // Токен — только в env шага: в argv вызовов gh его нет.
  expect(calls.join('\n')).not.toContain(TOKEN);
  expect(repo.remoteBreaks()).toEqual({ web: 69, contracts: 44 });
});

it('диспатч ci.yml отказал после create — шаг красный: PR создан, причина дословно, команда человека (e85)', () => {
  // Своя фикстура: первая ночь с отказом диспатча — у джобы нет права actions: write.
  const repo = ratchetRepo();
  writeFileSync(join(repo.ghState, 'dispatch-refused'), '');
  repo.night([{ domain: 'web', from: 67, to: 69 }]);

  const run = repo.runStep();

  expect(run.status).toBe(1);
  // PR создан и поднятие опубликовано — вывод говорит правду о состоянии.
  expect(run.output).toContain('PR храповика создан: https://github.com/org/repo/pull/42');
  expect(repo.remoteBreaks()).toEqual({ web: 69, contracts: 40 });
  // «PR создан или громкая ошибка» распространён на запуск CI: отказ — не
  // зелёный шаг с PR без проверок, а причина дословно и действие человека.
  expect(run.output).toContain('CI (ci.yml) на head SHA не запущен');
  expect(run.output).toContain(DISPATCH_REFUSED);
  expect(run.output).not.toContain('CI (ci.yml) на head SHA запущен диспатчем');
  expect(run.output).toContain(`Дальше человек: запусти CI на ветке PR — gh ${DISPATCH_CALL}`);
  // Остаточное событие для gate-integrity названо и в красном выводе.
  expect(run.output).toContain('gate-change-approved');
  expect(repo.ghCalls().filter((call) => call.startsWith('workflow run'))).toEqual([DISPATCH_CALL]);
});

it('PR уже открыт — ветка обновлена без удаления, create не вызывается, шаг зелёный', () => {
  // История «с PR», ночь 2: человек открыл PR, счёт вырос — предложение выше
  // порога ветки.
  const repo = story('с PR');
  const nightOne = repo.remoteTip();
  const callsAfterNightOne = repo.ghCalls().length;
  const gitAfterNightOne = repo.gitCalls().length;

  writeFileSync(join(repo.ghState, 'pr-list.json'), PR_OPEN);
  repo.night([{ domain: 'web', from: 67, to: 71 }]);

  const run = repo.runStep();

  expect(run.status).toBe(0);
  expect(run.output).toContain(
    'PR #7 уже открыт — ветка chore/mutation-ratchet-web-contracts обновлена',
  );
  expect(run.output).toContain('https://github.com/org/repo/pull/7');
  // Push сделал github.token — события от него workflow не рождают: шаг сам
  // запускает CI на новом head SHA (e85, маршрут (а)) и называет остаточное
  // событие человека для доверенного gate-integrity (маршрут (б1)) —
  // обязательный label, — а не молчит за зелёным exit 0.
  expect(run.output).toContain('CI (ci.yml) на head SHA запущен диспатчем');
  expect(run.output).toContain('gate-integrity и bundle-approval автоматика не запускает');
  expect(run.output).toContain('событие labeled');
  expect(run.output).toContain('снять и поставить');
  // Журналы вызовов накопительные: смотрим только на эту ночь.
  const nightTwo = repo.ghCalls().slice(callsAfterNightOne);
  expect(nightTwo.join('\n')).not.toContain('pr create');
  expect(nightTwo.filter((call) => call.startsWith('workflow run'))).toEqual([DISPATCH_CALL]);
  expect(gitCallsSince(repo, gitAfterNightOne)).not.toContain('--delete');
  // Коммит лёг на топ ветки: удаление закрыло бы PR.
  expect(gitText(repo.dir, ['rev-parse', '--verify', `${repo.remoteTip()}^`])).toBe(nightOne);
  expect(repo.remoteBreaks()).toEqual({ web: 71, contracts: 44 });
});

it('PR уже открыт, порог ветки выше предложения — не понижается, ветка не тронута, шаг зелёный', () => {
  // История «с PR», ночь 3: счёт упал — предложение от порога main (69) ниже
  // порога ветки (71).
  const repo = story('с PR');
  const nightOne = repo.remoteTip();
  const gitAfterNightOne = repo.gitCalls().length;
  const callsAfterNightOne = repo.ghCalls().length;

  repo.night([{ domain: 'web', from: 67, to: 69 }]);

  const run = repo.runStep();

  expect(run.status).toBe(0);
  expect(run.output).toContain('PR #7 уже открыт');
  // Сообщение говорит правду: ветку не трогали — «обновлена» была бы ложью.
  expect(run.output).toContain('ветка chore/mutation-ratchet-web-contracts не тронута');
  expect(run.output).not.toContain('обновлена');
  // Нового head SHA нет — диспатча нет; остаточное событие всё равно названо.
  expect(repo.ghCalls().slice(callsAfterNightOne).join('\n')).not.toContain('workflow run');
  expect(run.output).toContain('gate-change-approved');
  expect(repo.remoteTip()).toBe(nightOne);
  expect(repo.remoteBreaks()).toEqual({ web: 71, contracts: 44 });
  expect(gitCallsSince(repo, gitAfterNightOne)).not.toContain('push');
});

it('push отклонён — шаг красный с причиной дословно, без «уже открыт» и без create', () => {
  // История «первые ночи», ночь 1: ветки на remote нет, remote отклоняет push.
  const repo = story('первые ночи');
  const hook = join(repo.remote, 'hooks', 'pre-receive');
  writeFileSync(hook, '#!/bin/sh\necho "remote: rejected by test pre-receive" >&2\nexit 1\n', {
    mode: 0o755,
  });
  repo.night([{ domain: 'web', from: 67, to: 69 }]);

  const run = repo.runStep();

  expect(run.status).toBe(1);
  expect(run.output).toContain('rejected by test pre-receive');
  expect(run.output).not.toContain('уже открыт');
  // Сообщение говорит правду о ветке: ветки на remote нет, и действие человека
  // называет её состояние — «обновлена» была бы ложью.
  expect(run.output).toContain(
    'ветка chore/mutation-ratchet-web-contracts не создана: поднятие не потеряно',
  );
  expect(run.output).not.toContain('ветка chore/mutation-ratchet-web-contracts обновлена');
  expect(repo.remoteTip()).toBe('');
  expect(repo.ghCalls().join('\n')).not.toContain('pr create');
});

it('ветка прошлой ночи осталась без PR — заменена коммитом поверх текущего main', () => {
  // История «без PR», ночь 2: create так и отклоняют, PR по ветке нет.
  const repo = story('без PR');
  const nightOne = repo.remoteTip();

  // main уехал вперёд (squash-merge чужого PR), PR по ветке так и нет.
  writeFileSync(join(repo.dir, 'other.txt'), 'x');
  gitText(repo.dir, ['add', 'other.txt']);
  gitText(repo.dir, ['commit', '-qm', 'main moved']);
  const mainHead = gitText(repo.dir, ['rev-parse', 'HEAD']);
  repo.night([{ domain: 'web', from: 67, to: 70 }]);
  const run = repo.runStep();

  expect(run.status).toBe(1);
  // Сообщение говорит правду: действие человека называет состояние ветки по
  // факту — «удалена и не пересоздана» рядом с командой на уже пересозданную
  // ветку читалось бы как потерянное поднятие.
  expect(run.output).toContain(
    'ветка chore/mutation-ratchet-web-contracts заменена коммитом поверх main — PR открывает человек',
  );
  expect(run.output).not.toContain('не пересоздана');

  const tip = repo.remoteTip();
  expect(tip).not.toBe(nightOne);
  expect(gitText(repo.dir, ['rev-parse', '--verify', `${tip}^`])).toBe(mainHead);
  expect(repo.remoteBreaks()).toEqual({ web: 70, contracts: 40 });
});

it('gh pr list не ответил — шаг красный, ветка не тронута, create не вызывался', () => {
  // История «первые ночи», ночь 2.
  const repo = story('первые ночи');
  writeFileSync(join(repo.ghState, 'list-fails'), '');
  repo.night([{ domain: 'web', from: 67, to: 69 }]);

  const run = repo.runStep();

  expect(run.status).toBe(1);
  expect(run.output).toContain('HTTP 502');
  expect(run.output).not.toContain('уже открыт');
  expect(repo.remoteTip()).toBe('');
  expect(repo.ghCalls().join('\n')).not.toContain('pr create');
});

it('remote не отвечает (ls-remote, fetch) — шаг красный с причиной дословно, без create', () => {
  // История «без PR», ночь 3: шаг спрашивает remote через ls-remote.
  const first = story('без PR');
  writeFileSync(join(first.ghState, 'remote-fails'), '');
  const ghBefore = first.ghCalls().length;
  first.night([{ domain: 'web', from: 67, to: 69 }]);
  const lsRemote = first.runStep();

  expect(lsRemote.status).toBe(1);
  expect(lsRemote.output).toContain('git ls-remote — код 128');
  expect(lsRemote.output).toContain(NETWORK_FAILURE);
  expect(lsRemote.output).not.toContain('уже открыт');
  expect(first.ghCalls().slice(ghBefore).join('\n')).not.toContain('pr create');

  // История «с PR», ночь 4: шаг получает топ ветки через fetch.
  const second = story('с PR');
  writeFileSync(join(second.ghState, 'remote-fails'), '');
  second.night([{ domain: 'web', from: 67, to: 73 }]);
  const fetch = second.runStep();

  expect(fetch.status).toBe(1);
  expect(fetch.output).toContain('git fetch — код 128');
  expect(fetch.output).toContain(NETWORK_FAILURE);
});

it('предложения нет — шаг зелёный, gh и remote не тронуты', () => {
  const repo = ratchetRepo();
  repo.night([]);

  const run = repo.runStep();

  expect(run.status).toBe(0);
  expect(run.output).toContain('Устойчивого превышения нет — PR храповика не нужен.');
  expect(repo.ghCalls()).toEqual([]);
  expect(repo.gitCalls()).toEqual([]);
  expect(repo.remoteTip()).toBe('');
});

it('токен не в argv git: авторизация — конфиг-окружением, и только у команд на remote (e67)', () => {
  // Вызовы git обеих историй за все ночи: без PR — ls-remote и push (ночь 1),
  // ls-remote, push --delete и push (ночь 2); с PR — fetch и push.
  const calls = [...story('без PR').gitCalls(), ...story('с PR').gitCalls()];
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
  // (show, read-tree, commit-tree) токена не получает.
  expect(calls.filter(({ config }) => config === AUTH_CONFIG)).toEqual(onRemote);
});
