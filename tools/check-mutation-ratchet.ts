/**
 * Храповик мутационных порогов web и контрактов (b2.4, З7). Чистое ядро без
 * IO — импортируется тестами; CLI — tools/check-mutation-ratchet.main.ts
 * (шов check-perf-trend(.main).ts). Порог break ставит оператор один раз по
 * правилу ADR 0009 («Пороги»: фактический счёт, округлённый вниз, минус 5
 * п.п.), дальше порог двигает только автоматика вверх: nightly предлагает
 * PR, когда счёт пакета выше порога в двух последних зелёных прогонах
 * подряд («устойчивое превышение»; зелёность job-scoped — артефакт
 * состояния пишется только от успеха собственных шагов, как perf-baseline).
 * Предлагаемое значение — то же правило от минимума двух счётов, и только
 * если оно выше текущего порога: вниз храповик не двигает.
 *
 * База счёта — total по всем валидным мутантам, формула mutation-testing-
 * metrics (killed+timeout)/(killed+timeout+survived+noCoverage). Формула
 * одна с телеметрией c9.4 — импорт mutationScoreFromMutants из
 * tools/telemetry-report.ts (deny-файл; импорт из tools/ в tools/
 * допустим), вторую копию не плодим (находка план-ревью b2.4). Не covered:
 * thresholds.break Stryker судит total, порог от covered красил бы джобу с
 * первого прогона (39 мутантов web без покрытия node-проекта, журнал b2.2).
 *
 * Права джобы nightly (fetch-state идёт в артефактное API, PR — push):
 * actions: read + contents: write + pull-requests: write. Красная джоба
 * заводит issue через report.needs (ночной контур L5, З11).
 *
 * pnpm tool-class:check держит этот файл в deny и KNOWN_GATES (ADR 0014).
 */
import * as z from 'zod';

import { mutationScoreFromMutants } from './telemetry-report.ts';

export interface DomainSpec {
  domain: 'web' | 'contracts';
  /** Путь отчёта mutation.json относительно корня репозитория. */
  reportPath: string;
  /** Путь конфига Stryker относительно корня репозитория. */
  configPath: string;
  /** Имя артефайта ночного прогонов (mutation-full остаётся api-only для телеметрии c9.4). */
  artifactName: string;
}

export const DOMAINS: readonly DomainSpec[] = [
  {
    domain: 'web',
    reportPath: 'apps/web/reports/mutation/mutation.json',
    configPath: 'apps/web/stryker.conf.json',
    artifactName: 'mutation-full-web',
  },
  {
    domain: 'contracts',
    reportPath: 'packages/contracts/reports/mutation/mutation.json',
    configPath: 'packages/contracts/stryker.conf.json',
    artifactName: 'mutation-full-contracts',
  },
];

/** Форма json-репорта Stryker (как MutationFileSchema телеметрии — там схема не экспортируется). */
export const MutationReportSchema = z.object({
  files: z.record(z.string(), z.object({ mutants: z.array(z.object({ status: z.string() })) })),
});
export type MutationReport = z.infer<typeof MutationReportSchema>;

/** Конфиг Stryker в той части, что читает храповик. */
export const StrykerThresholdsSchema = z.object({
  thresholds: z.object({ break: z.number() }),
});

// sha приходит из артефакта прошлого прогона (недоверенные данные) и
// попадает в тексты PR — строго hex40, как meta.json у perf-базлайна.
const SHA_RE = /^[0-9a-f]{40}$/;

export const RatchetStateSchema = z.object({
  schema: z.literal('mutation-ratchet-state/1'),
  sha: z.string().regex(SHA_RE),
  runId: z.number().int().positive(),
  date: z.string().datetime(),
  scores: z.object({ web: z.number(), contracts: z.number() }),
  breakAtDecision: z.object({ web: z.number(), contracts: z.number() }),
});
export type RatchetState = z.infer<typeof RatchetStateSchema>;

export const ProposalFileSchema = z.object({
  schema: z.literal('mutation-ratchet-proposal/1'),
  sha: z.string().regex(SHA_RE),
  runId: z.number().int().positive(),
  proposals: z.array(
    z.object({
      domain: z.enum(['web', 'contracts']),
      configPath: z.string(),
      from: z.number(),
      to: z.number().int(),
    }),
  ),
});
export type ProposalFile = z.infer<typeof ProposalFileSchema>;

/** Счёт total по всем валидным мутантам отчёта. Пустой отчёт — ошибка: храповик не молча ослепнуть (З11). */
export function scoreFromReport(report: MutationReport): number {
  const statuses = Object.values(report.files).flatMap((entry) =>
    entry.mutants.map((mutant) => mutant.status),
  );
  if (statuses.length === 0) {
    throw new Error('в отчёте ни одного мутанта — счёт не определён');
  }
  return mutationScoreFromMutants(statuses).score;
}

export interface Breaks {
  web: number;
  contracts: number;
}

export type ParsedDomain =
  | { kind: 'ok'; score: number }
  | { kind: 'missing' }
  | { kind: 'broken'; message: string };

export type ViolationKind = 'missing-report' | 'broken-report' | 'score-below-break';

export interface Violation {
  domain: string;
  kind: ViolationKind;
  message: string;
}

/**
 * Зубья порога: счёт ниже break — нарушение. Отсутствующий или битый отчёт —
 * тоже нарушение (fail-closed: отсутствующий файл не может молча пройти).
 * score == break проходит — Stryker красит только при score < break.
 */
export function checkDomains(inputs: Array<DomainCheckInput>): Violation[] {
  const violations: Violation[] = [];
  for (const input of inputs) {
    if (input.parsed.kind === 'missing') {
      violations.push({
        domain: input.domain,
        kind: 'missing-report',
        message: 'отчёта нет — храповик не имеет права молча ослепнуть (З11)',
      });
    } else if (input.parsed.kind === 'broken') {
      violations.push({
        domain: input.domain,
        kind: 'broken-report',
        message: `отчёт не читается — ${input.parsed.message}`,
      });
    } else if (input.parsed.score < input.break) {
      violations.push({
        domain: input.domain,
        kind: 'score-below-break',
        message: `счёт ${input.parsed.score} ниже порога ${input.break}`,
      });
    }
  }
  return violations;
}

export interface DomainCheckInput {
  domain: string;
  break: number;
  parsed: ParsedDomain;
}

/**
 * Вердикт проверки. Обычный вызов: зелёный, когда нарушений нет.
 * --expect-regression (канарейка): зелёный только когда нарушение именно
 * «счёт ниже порога» найдено; структурные нарушения (нет/бит отчёт) инверсией
 * не считаются — канарейка обязана доказать детектор порога, а не слепоту.
 */
export function checkVerdict(
  violations: Violation[],
  expectRegression: boolean,
): { pass: boolean; reason?: string } {
  if (!expectRegression) {
    return { pass: violations.length === 0 };
  }
  const structural = violations.filter((violation) => violation.kind !== 'score-below-break');
  if (structural.length > 0) {
    return { pass: false, reason: 'структурные нарушения (нет/бит отчёт) инверсией не считаются' };
  }
  if (violations.length === 0) {
    return { pass: false, reason: 'канарейка не ловит: завышенный порог не дал нарушения' };
  }
  return { pass: true };
}

/**
 * Решение храповика. Состояние пишется всегда (оно — «первый из двух
 * прогонов» для следующего запуска); предложение появляется, когда счёт
 * домена выше порога и в прошлом состоянии, и сейчас, и правило ADR 0009 от
 * минимума двух счётов даёт значение строго выше текущего порога.
 */
export function decide(input: DecideInput): DecideResult {
  const state: RatchetState = {
    schema: 'mutation-ratchet-state/1',
    sha: input.sha,
    runId: input.runId,
    date: input.date,
    scores: { web: input.current.web, contracts: input.current.contracts },
    breakAtDecision: { web: input.break.web, contracts: input.break.contracts },
  };
  const proposals: ProposalFile['proposals'] = [];
  const notes: string[] = [];
  for (const spec of DOMAINS) {
    const domain = spec.domain;
    const current = input.current[domain];
    const currentBreak = input.break[domain];
    const prevScore = input.prev?.scores[domain];
    if (prevScore === undefined) {
      notes.push(`${domain}: прошлого состояния нет — окно устойчивости не набрано`);
      continue;
    }
    if (!(prevScore > currentBreak) || !(current > currentBreak)) {
      notes.push(
        `${domain}: устойчивого превышения нет (prev ${prevScore}, curr ${current}, break ${currentBreak})`,
      );
      continue;
    }
    const to = Math.floor(Math.min(prevScore, current)) - 5;
    if (!(to > currentBreak)) {
      notes.push(
        `${domain}: правило ADR 0009 даёт ${to} — не выше текущего порога ${currentBreak}, храповик не двигается`,
      );
      continue;
    }
    proposals.push({ domain, configPath: spec.configPath, from: currentBreak, to });
  }
  return { state, proposals, notes };
}

export interface DecideInput {
  current: Breaks;
  break: Breaks;
  prev: RatchetState | null;
  sha: string;
  runId: number;
  date: string;
}

export interface DecideResult {
  state: RatchetState;
  proposals: ProposalFile['proposals'];
  notes: string[];
}

/**
 * Защита apply перед записью конфигов (proposal — недоверенный вход джобы,
 * хотя пишется ею же): путь конфига известен, from совпадает с текущим
 * порогом (иначе PR строится на устаревшей базе), to — строго вверх.
 */
export function validateProposals(
  proposals: ProposalFile['proposals'],
  configPaths: BreaksConfigPaths,
  currentBreaks: Breaks,
): void {
  const known = new Set(DOMAINS.map((spec) => spec.configPath));
  for (const proposal of proposals) {
    if (!known.has(proposal.configPath)) {
      throw new Error(`предложение ${proposal.domain}: неизвестный конфиг ${proposal.configPath}`);
    }
    const currentBreak = currentBreaks[proposal.domain];
    if (proposal.from !== currentBreak) {
      throw new Error(
        `предложение ${proposal.domain}: база from=${proposal.from} не совпадает с текущим порогом ${currentBreak}`,
      );
    }
    if (!(proposal.to > proposal.from)) {
      throw new Error(
        `предложение ${proposal.domain}: ${proposal.from} → ${proposal.to} — храповик не двигает порог вниз`,
      );
    }
  }
}

export interface BreaksConfigPaths {
  web: string;
  contracts: string;
}
