/**
 * CLI ночного тренд-сравнения (A6 PR-3): подкоманды fetch-baseline / compare /
 * write-meta. Подробности и коды выходов — в шапке tools/check-perf-trend.ts
 * (чистое ядро: сравнение и решение по базлайну, импортируется тестами).
 * Entry отделён от ядра, чтобы импорт из тестов не исполнял CLI (как хуки:
 * protect-paths.ts + protect-paths.main.ts).
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod';

import {
  compareReports,
  decideBaseline,
  type BaselineMeta,
  type CompareVerdict,
} from './check-perf-trend.ts';
import { PerfReportSchema, type PerfReport } from './perf-metrics.ts';
import { loadPerfBudgets } from './perf-budgets.ts';
import { maintainersOf } from './gate-approval-core.ts';

const BASELINE_ARTIFACT = 'perf-baseline';
const REGRESSION_LABEL = 'perf-regression';
const ISSUE_TITLE_REGRESSION = 'Nightly perf trend: regression vs baseline';
const ISSUE_TITLE_STALE = 'Nightly perf trend: baseline is stale';
const SHA_RE = /^[0-9a-f]{40}$/;

// meta.json живёт в артефакте GitHub — недоверенные данные: sha строго hex40,
// прежде чем попасть в тексты issue и диапазоны (находка arch-ревью A6.1).
const BaselineMetaSchema = z.object({
  sha: z.string().regex(SHA_RE),
  runId: z.number().int().positive(),
  createdAt: z.string().datetime(),
});

function parseMeta(raw: unknown, source: string): BaselineMeta {
  const parsed = BaselineMetaSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `${source}: битый meta.json (${parsed.error.issues[0]?.path.join('.')}): ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

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

/** Успешные nightly-прогоны, новейшие первыми. */
function successfulNightlyRuns(): RunInfo[] {
  const raw = ghJson([
    'run',
    'list',
    '--workflow',
    'Nightly',
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

function hasBaselineArtifact(runId: number): boolean {
  const raw: unknown = ghJson(['api', `repos/${repoFromEnv()}/actions/runs/${runId}/artifacts`]);
  const artifacts = isRecord(raw) && Array.isArray(raw['artifacts']) ? raw['artifacts'] : [];
  return artifacts.some(
    (a) => isRecord(a) && a['name'] === BASELINE_ARTIFACT && a['expired'] !== true,
  );
}

// ─── Issues: дедуп по label, комментарий к существующему, фолбэк по заголовку ───

function ownersMention(): string {
  const maintainers = maintainersOf(['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']);
  return (
    [...maintainers].map((login) => `@${login}`).join(' ') || '(владельцы CODEOWNERS не найдены)'
  );
}

function createOrCommentIssue(title: string, body: string, withLabel: boolean): void {
  const existing = ghJson([
    'issue',
    'list',
    '--state',
    'open',
    '--search',
    `in:title "${title}"`,
    '--json',
    'number,title',
  ]);
  const match = Array.isArray(existing)
    ? existing.find((entry) => isRecord(entry) && entry['title'] === title)
    : undefined;
  const number =
    isRecord(match) && typeof match['number'] === 'number' ? match['number'] : undefined;
  if (number !== undefined) {
    gh(['issue', 'comment', String(number), '--body', body]);
    console.log(`issue #${number}: добавлен комментарий (дедуп по заголовку)`);
    return;
  }
  const args = ['issue', 'create', '--title', title, '--body', body];
  if (withLabel) {
    args.push('--label', REGRESSION_LABEL);
  }
  try {
    const url = gh(args);
    console.log(`issue создан: ${url}`);
  } catch (error) {
    if (!withLabel) {
      throw error;
    }
    // label может не существовать в копии шаблона: issue важнее label.
    console.error(
      `создание с label ${REGRESSION_LABEL} не удалось (${error instanceof Error ? error.message : String(error)}) — создаём без label`,
    );
    createOrCommentIssue(title, body, false);
  }
}

function issueBody(args: {
  kind: 'regression' | 'stale';
  baseline: BaselineMeta | undefined;
  headSha: string | undefined;
  runUrl: string | undefined;
  detail: string;
}): string {
  const range =
    args.baseline && args.headSha
      ? `${args.baseline.sha.slice(0, 12)}..${args.headSha.slice(0, 12)}`
      : 'диапазон неизвестен';
  return [
    `Nightly perf trend: **${args.kind}**.`,
    '',
    `- Диапазон: \`${range}\``,
    `- Прогон: ${args.runUrl ?? 'URL неизвестен'}`,
    `- Владелец: ${ownersMention()}`,
    '',
    args.detail,
    '',
    'Регрессию чинит код, не порог ([ADR 0006](docs/adr/0006-perf-strategy.md)).',
  ].join('\n');
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
    index += 1; // известный флаг — пропускаем его значение
  }
  return unknown;
}

function loadBaselineDir(dir: string): { perf: PerfReport; meta: BaselineMeta } {
  const perfPath = join(dir, 'perf.json');
  const metaPath = join(dir, 'meta.json');
  if (!existsSync(perfPath) || !existsSync(metaPath)) {
    throw new Error(`${dir}: нет perf.json или meta.json`);
  }
  const perf = PerfReportSchema.safeParse(JSON.parse(readFileSync(perfPath, 'utf8')));
  if (!perf.success) {
    throw new Error(`${perfPath}: отчёт не прошёл схему — ${perf.error.message}`);
  }
  const meta = parseMeta(JSON.parse(readFileSync(metaPath, 'utf8')), metaPath);
  return { perf: perf.data, meta };
}

const trend = loadPerfBudgets().trend;
const command = process.argv[2];
const allowedByCommand: { [command: string]: string[] | undefined } = {
  'fetch-baseline': ['--out', '--exclude-run', '--create-issue', '--run-url', '--help'],
  compare: [
    '--candidate',
    '--baseline',
    '--expect-regression',
    '--create-issue',
    '--head-sha',
    '--run-url',
    '--help',
  ],
  'write-meta': ['--out', '--sha', '--run-id'],
};

if (command === 'fetch-baseline') {
  const unknown = unknownArgs(allowedByCommand['fetch-baseline'] ?? []);
  if (unknown.length > 0) {
    console.error(`fetch-baseline: неизвестные аргументы: ${unknown.join(', ')}`);
    process.exit(2);
  }
  const out = parseFlag(['--out']);
  if (!out) {
    console.error('fetch-baseline: нужен --out DIR');
    process.exit(2);
  }
  const excludeRun = parseFlag(['--exclude-run']);
  const createIssue = hasFlag('--create-issue');
  const runUrl = parseFlag(['--run-url']);

  let runs: RunInfo[];
  try {
    runs = successfulNightlyRuns();
  } catch (error) {
    console.error(
      `✗ perf-trend: gh run list не удался — ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
  const candidates = runs.filter((run) => String(run.id) !== excludeRun);
  let foundRun: RunInfo | undefined;
  for (const run of candidates) {
    if (hasBaselineArtifact(run.id)) {
      foundRun = run;
      break;
    }
  }
  if (!foundRun) {
    console.log(
      'perf-trend: baseline не найден ни у одного успешного прогона — первый запуск (none)',
    );
    process.exit(3);
  }

  const downloadDir = mkdtempSync(join(tmpdir(), 'perf-baseline-'));
  try {
    gh(['run', 'download', String(foundRun.id), '-n', BASELINE_ARTIFACT, '-D', downloadDir]);
    const meta = parseMeta(
      JSON.parse(readFileSync(join(downloadDir, 'meta.json'), 'utf8')),
      'meta.json',
    );
    const perf = PerfReportSchema.safeParse(
      JSON.parse(readFileSync(join(downloadDir, 'perf.json'), 'utf8')),
    );
    if (!perf.success) {
      throw new Error(`базлайн не прошёл схему — ${perf.error.message}`);
    }
    const greenRunsAfter = runs.filter(
      (run) => run.id !== foundRun.id && Date.parse(run.createdAt) > Date.parse(foundRun.createdAt),
    ).length;
    const decision = decideBaseline({
      meta,
      nowMs: Date.now(),
      greenRunsAfter,
      trend,
    });
    if (decision.kind === 'stale' && createIssue) {
      createOrCommentIssue(
        ISSUE_TITLE_STALE,
        issueBody({
          kind: 'stale',
          baseline: meta,
          headSha: undefined,
          runUrl,
          detail: `Базлайн протух: ${decision.reason}. Сравнение пойдёт по старой базе; зелёный прогон обновит базу и снимет stale.`,
        }),
        true,
      );
    }
    mkdirSync(out, { recursive: true });
    renameSync(join(downloadDir, 'perf.json'), join(out, 'perf.json'));
    renameSync(join(downloadDir, 'meta.json'), join(out, 'meta.json'));
    if (decision.kind === 'stale') {
      console.log(`baseline-status: stale — ${decision.reason}`);
    } else {
      console.log(`baseline-status: found (прогон ${meta.runId}, ${meta.sha.slice(0, 12)})`);
    }
    process.exit(0);
  } catch (error) {
    console.error(
      `✗ perf-trend: базлайн не скачался/не прочитался — ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  } finally {
    rmSync(downloadDir, { recursive: true, force: true });
  }
}

if (command === 'compare') {
  const unknown = unknownArgs(allowedByCommand['compare'] ?? []);
  if (unknown.length > 0) {
    console.error(`compare: неизвестные аргументы: ${unknown.join(', ')}`);
    process.exit(2);
  }
  const candidatePath = parseFlag(['--candidate']);
  const baselineDir = parseFlag(['--baseline']);
  const expectRegression = hasFlag('--expect-regression');
  const createIssue = hasFlag('--create-issue');
  const headSha = parseFlag(['--head-sha']);
  const runUrl = parseFlag(['--run-url']);
  if (!candidatePath || !baselineDir) {
    console.error('compare: нужны --candidate PERF.json и --baseline DIR');
    process.exit(2);
  }

  let verdict: CompareVerdict;
  let baselineMeta: BaselineMeta | undefined;
  try {
    const parsed = PerfReportSchema.safeParse(JSON.parse(readFileSync(candidatePath, 'utf8')));
    if (!parsed.success) {
      verdict = { status: 'invalid', reason: `кандидат не прошёл схему — ${parsed.error.message}` };
    } else {
      const baseline = loadBaselineDir(baselineDir);
      baselineMeta = baseline.meta;
      verdict = compareReports(parsed.data, baseline.perf, {
        timeFloorMs: trend.timeFloorMs,
        timePct: trend.timePct,
        clsSlack: trend.clsSlack,
        longTasksSlack: trend.longTasksSlack,
        maxBytesSlackKb: loadPerfBudgets().web.bundle.maxPrGrowthKb,
      });
    }
  } catch (error) {
    verdict = { status: 'invalid', reason: error instanceof Error ? error.message : String(error) };
  }

  if (verdict.status === 'invalid') {
    // Инверсия не действует: сломанный чекер/данные не должен выглядеть «ловит».
    console.error(`✗ perf-trend: invalid — ${verdict.reason}`);
    process.exit(1);
  }
  if (verdict.status === 'ok') {
    console.log('perf-trend: ok — регрессий относительно базы нет');
    if (expectRegression) {
      console.error('✗ perf-canary: сравнение зелёное при внесённой задержке — канарейка не ловит');
      process.exit(1);
    }
    process.exit(0);
  }
  const detail = verdict.failures
    .map((failure) => `- ${failure.metric}: ${failure.detail}`)
    .join('\n');
  console.error(`✗ perf-trend: regression\n${detail}`);
  if (expectRegression) {
    console.log('perf-canary: регрессия поймана — канарейка жива');
    process.exit(0);
  }
  if (createIssue) {
    try {
      createOrCommentIssue(
        ISSUE_TITLE_REGRESSION,
        issueBody({
          kind: 'regression',
          baseline: baselineMeta,
          headSha,
          runUrl,
          detail: `Нарушены допуски:\n${detail}`,
        }),
        true,
      );
    } catch (error) {
      console.error(
        `issue создать не удалось (${error instanceof Error ? error.message : String(error)}) — сравнение остаётся красным`,
      );
    }
  }
  process.exit(1);
}

if (command === 'write-meta') {
  const unknown = unknownArgs(allowedByCommand['write-meta'] ?? []);
  if (unknown.length > 0) {
    console.error(`write-meta: неизвестные аргументы: ${unknown.join(', ')}`);
    process.exit(2);
  }
  const out = parseFlag(['--out']);
  const sha = parseFlag(['--sha']);
  const runId = parseFlag(['--run-id']);
  if (!out || !sha || !runId) {
    console.error('write-meta: нужны --out DIR --sha SHA --run-id ID');
    process.exit(2);
  }
  if (!SHA_RE.test(sha)) {
    console.error(`write-meta: sha должен быть hex40, получено «${sha}»`);
    process.exit(2);
  }
  const meta = BaselineMetaSchema.parse({
    sha,
    runId: Number(runId),
    createdAt: new Date().toISOString(),
  });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  process.exit(0);
}

console.error(
  [
    'Использование: node tools/check-perf-trend.ts <fetch-baseline|compare|write-meta> [аргументы]',
    'Подробности — в шапке файла.',
  ].join('\n'),
);
process.exit(2);
