/**
 * Тесты храповика мутационных порогов (b2.4): ядро (счёт, зубья порога,
 * вердикт канарейки, решение, защита apply) — напрямую; CLI check/decide/
 * apply — спавном на фикстурах во временных каталогах. fetch-state (gh API)
 * в юнит-тестах не вызывается — только отказ по неизвестным аргументам.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
  const configWeb = writeReport(dir, 'web.conf.json', original);
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
  expect(result.status).toBe(0);
  const applied = readFileSync(configWeb, 'utf8');
  expect(applied).toBe(original.replace('"break": 67', '"break": 69'));
  const oxfmt = spawnSync('pnpm', ['exec', 'oxfmt', '--check', configWeb], { encoding: 'utf8' });
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
