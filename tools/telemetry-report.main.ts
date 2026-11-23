/**
 * CLI ночной телеметрии (c9.4): сбор данных из уже существующих источников и
 * запись reports/trends.json. Агрегация — tools/telemetry-report.ts (ядро без
 * IO, импортируется тестами; entry отделён от ядра, чтобы импорт из тестов не
 * исполнял CLI — шов check-perf-trend(.main).ts).
 *
 * Режимы:
 *   node tools/telemetry-report.main.ts [--period-days N] [--out файл]
 *        [--summary] [--max-runs N] [--repo owner/name]
 *   node tools/telemetry-report.main.ts --local   # без gh: только локальные источники
 *
 * Источники (ночной режим, план-ревью c9.4):
 *   - время CI: runs workflow ci.yml (pull_request / merge_group), длительность
 *     updated_at − run_started_at, пагинация per_page=100 (урок e16);
 *   - flaky rate: артефакт flaky-rate ночных прогонов (flake.json +
 *     flaky-rate.json — число считает гейт check-flaky-rate.ts через
 *     --rate-out, телеметрия не пересчитывает сама; B1 ревью);
 *   - бюджет verify: артефакт verify-durations-<run_id> (job verify-budgets);
 *   - perf: артефакт perf-trend-<run_id> (perf.json; пишется только при
 *     успешном perf+baseline — отсутствие «нет данных», не «сломано»);
 *   - mutation: артефакт mutation-full (mutation.json, полный домен apps/api);
 *   - отказы: артефакты gate-denials прогонов gate-integrity; отсутствие
 *     артефакта у зелёного прогона = 0 (absent-vs-zero, ревью c9.4), битые
 *     строки журнала не роняют разбор (семантика C9.3);
 *   - evals: артефакты evals-<run_id> (totals отчёта); скипнутый прогон без
 *     секрета ANTHROPIC_API_KEY — «не собирается», не ноль; красный прогон
 *     без артефакта — problem (fail-closed);
 *   - агентные PR: gh pr list --state merged, чекбокс маркера; тела PR в
 *     отчёт и summary не попадают — только счёт (untrusted);
 *   - конфликты задач доски: пары task/* через git merge-tree --write-tree;
 *   - escaped defects: docs/escaped-defects.md, только основная таблица.
 *
 * Fail-closed (З4/З11): несостоявшийся обязательный источник — problem,
 * CLI выходит 1; issue при красном nightly создаёт job report (telemetry в
 * его needs — решение B3 ревью). Ненадёжные входы валидируются Zod до ядра;
 * тексты из артефактов и PR в вывод не вставляются.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as z from 'zod';

import { journalPath, readDenials } from './denial-journal.ts';
import { loadPerfBudgets } from './perf-budgets.ts';
import { parseBudgets } from './verify-budgets-loader.ts';
import {
  buildTrendsReport,
  evalsMissingArtifactPolicy,
  ghRunArtifactsArgs,
  ghWorkflowRunsArgs,
  mutationScoreFromMutants,
  parsePerfPoint,
  DenialRecordSchema,
  MergedPrSchema,
  renderSummary,
  type DenialRecord,
  type EvalsPoint,
  type MergedPr,
  type MutationPoint,
  type NightlyArtifactRun,
  type PerfPoint,
  type RatePoint,
  type TaskConflicts,
  type TelemetryInputs,
  type VerifyPoint,
  type WorkflowRun,
} from './telemetry-report.ts';

/** Дата введения маркера агентного PR (чекбокс в шаблоне, этот PR). */
const AGENT_MARKER_CONVENTION_SINCE = '2026-11-22';

const GhRunSchema = z.object({
  id: z.number(),
  event: z.string(),
  conclusion: z.string().nullable(),
  runStartedAt: z.string().nullable(),
  updatedAt: z.string(),
});
const GhRunsPageSchema = z.object({
  count: z.number().int().nonnegative(),
  runs: z.array(GhRunSchema),
});
const GhArtifactSchema = z.object({ name: z.string(), id: z.number() });
// Форма вывода jq listArtifacts — готовый массив (expired отфильтрованы jq),
// не «страница» {artifacts: [...]}: рассинхрон схемы и jq красил артефакты
// каждого прогона «неожиданный ответ API» (e34, прогон локально с фиксом
// метода: 167 проблем на одном наборе прогонов).
const GhArtifactsPageSchema = z.array(GhArtifactSchema);
const FlakyRateFileSchema = z.object({
  ratePct: z.number(),
  flaky: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
const VerifyDurationsFileSchema = z.object({
  totalMs: z.number().nonnegative(),
  mode: z.literal('full'),
});
const MutationFileSchema = z.object({
  files: z.record(z.string(), z.object({ mutants: z.array(z.object({ status: z.string() })) })),
});
const EvalsTotalsFileSchema = z.object({
  totals: z.object({
    scenarios: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    timeMs: z.number().nonnegative(),
    tokens: z.number().nonnegative(),
  }),
});
const PrListSchema = z.array(
  z.object({ number: z.number(), body: z.string(), mergedAt: z.string() }),
);
const StrykerConfigSchema = z.object({
  thresholds: z.object({ break: z.number() }),
});

interface GhRun {
  id: number;
  event: string;
  conclusion: string;
  runStartedAt: string | null;
  updatedAt: string;
}

/**
 * gh api: параметры `-f` без явного метода переводят запрос в POST —
 * GET-only эндпоинт отвечает 404 (ночь 45013082390, e34: все источники
 * «не собраны», CLI красный). Новые вызовы с `-f` строят argv через билдеры
 * ghWorkflowRunsArgs/ghRunArtifactsArgs (tools/telemetry-report.ts, там же
 * тест-барьер) или явно указывают `-X GET`.
 */
function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Страницы runs с per_page=100 (урок e16: страница 30 роняла гейты).
 * branch: фильтр ветки для workflow, живущих на main (nightly, evals) —
 * без него workflow_dispatch на ветке задачи подсовывал бы веточные прогоны
 * в «свежайшие» и точки тренда (тот же отказ, что A6.1 чинил в
 * check-perf-trend: `--branch main`, находка sanity-ревью).
 */
function listRuns(
  repo: string,
  workflow: string,
  createdSince: string,
  problems: string[],
  branch?: string,
): GhRun[] {
  const runs: GhRun[] = [];
  for (let page = 1; page <= 20; page += 1) {
    let raw: string;
    try {
      raw = gh([
        'api',
        // Билдер держит `-X GET`: с `-f` без явного метода gh шлёт POST и
        // GET-only эндпоинт отвечает 404 (ночь 45013082390, e34).
        ...ghWorkflowRunsArgs(repo, workflow, createdSince, page, branch),
        '--jq',
        '{count: (.workflow_runs|length), runs: [.workflow_runs[] | {id: .id, event: .event, conclusion: .conclusion, runStartedAt: .run_started_at, updatedAt: .updated_at}]}',
      ]);
    } catch (error) {
      problems.push(
        `gh api runs ${workflow} страница ${page} не удалась: ${error instanceof Error ? error.message : String(error)} — источник не собран`,
      );
      return runs;
    }
    const parsed = GhRunsPageSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      problems.push(
        `gh api runs ${workflow} страница ${page}: неожиданный ответ API — источник не собран`,
      );
      return runs;
    }
    for (const run of parsed.data.runs) {
      if (run.conclusion === null) continue; // queued/in_progress — не завершён
      runs.push({
        id: run.id,
        event: run.event,
        conclusion: run.conclusion,
        runStartedAt: run.runStartedAt,
        updatedAt: run.updatedAt,
      });
    }
    if (parsed.data.count < 100) return runs;
  }
  problems.push(`gh api runs ${workflow}: больше 20 страниц — окно усечено`);
  return runs;
}

function listArtifacts(
  repo: string,
  runId: number,
  problems: string[],
): Array<{ name: string; id: number }> {
  let raw: string;
  try {
    raw = gh([
      'api',
      // `-X GET` из билдера: см. gh() — `-f` без явного метода = POST = 404.
      ...ghRunArtifactsArgs(repo, runId),
      '--jq',
      '[.artifacts[] | select(.expired != true) | {name: .name, id: .id}]',
    ]);
  } catch (error) {
    problems.push(
      `gh api artifacts прогона ${runId} не удалась: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
  const parsed = GhArtifactsPageSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    problems.push(`gh api artifacts прогона ${runId}: неожиданный ответ API`);
    return [];
  }
  return parsed.data;
}

/** Скачивает zip артефакта и распаковывает файлы по glob-паттерну (unzip -j). */
function extractArtifactFiles(
  repo: string,
  artifactId: number,
  pattern: string,
  workDir: string,
  problems: string[],
  context: string,
): string[] {
  const zipPath = join(workDir, 'artifact.zip');
  const fd = openSync(zipPath, 'w');
  try {
    execFileSync('gh', ['api', `repos/${repo}/actions/artifacts/${artifactId}/zip`], {
      stdio: ['ignore', fd, 'inherit'],
    });
  } catch (error) {
    problems.push(
      `${context}: скачивание артефакта не удалось: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  } finally {
    closeSync(fd);
  }
  const outDir = mkdtempSync(join(workDir, 'extract-'));
  try {
    // Код 11 unzip — «файл не найден»: отсутствующий файл артефакта, не сбой.
    execFileSync('unzip', ['-o', '-j', zipPath, pattern, '-d', outDir], { stdio: 'ignore' });
  } catch {
    rmSync(zipPath, { force: true });
    rmSync(outDir, { recursive: true, force: true });
    return [];
  }
  rmSync(zipPath, { force: true });
  const files = readdirSync(outDir);
  const contents = files.map((file) => readFileSync(join(outDir, file), 'utf8'));
  rmSync(outDir, { recursive: true, force: true });
  return contents;
}

function findArtifact(
  artifacts: Array<{ name: string; id: number }>,
  match: (name: string) => boolean,
): { name: string; id: number } | null {
  return artifacts.find((artifact) => match(artifact.name)) ?? null;
}

function parseJsonOr<T>(
  schema: z.ZodType<T>,
  raw: string,
  problems: string[],
  context: string,
): T | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    problems.push(`${context}: файл не разбирается как JSON`);
    return null;
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    problems.push(`${context}: неожиданная схема файла`);
    return null;
  }
  return result.data;
}

/** Свежайшие N прогонов каждого окна — бюджет API-вызовов артефактов. */
function selectNewestPerWindow(
  runs: GhRun[],
  maxPerWindow: number,
  sinceMs: number,
  prevSinceMs: number,
  nowMs: number,
): GhRun[] {
  const pick = (windowRuns: GhRun[]): GhRun[] =>
    windowRuns
      .filter((run) => {
        const t = Date.parse(run.updatedAt);
        return Number.isFinite(t) && t >= prevSinceMs && t <= nowMs;
      })
      .toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, maxPerWindow);
  const current = pick(runs.filter((run) => Date.parse(run.updatedAt) >= sinceMs));
  const previous = pick(runs.filter((run) => Date.parse(run.updatedAt) < sinceMs));
  return [...current, ...previous];
}

/** Открытые задачи доски (backlog/*.md, не done/) — идентификаторы. */
function openBoardTaskIds(): string[] {
  return readdirSync('backlog', { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name.replace(/\.md$/, ''))
    .toSorted();
}

function taskConflictsFromGit(problems: string[]): TaskConflicts {
  const fetched = spawnSync(
    'git',
    ['fetch', 'origin', '+refs/heads/task/*:refs/remotes/origin/task/*'],
    {
      stdio: 'ignore',
    },
  );
  // spawnSync.error — undefined при успехе (не null): проверять оба значения.
  const fetchError = fetched.error;
  if ((fetchError !== null && fetchError !== undefined) || fetched.status !== 0) {
    problems.push(
      `git fetch task/* не удался (код ${fetched.status ?? String(fetchError)}) — конфликты считаются по имеющимся ссылкам`,
    );
  }
  const out = execFileSync(
    'git',
    ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin/task/*'],
    {
      encoding: 'utf8',
    },
  );
  const allTaskRefs = out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .toSorted();
  // Задача говорит «конфликты между задачами доски»: пары только открытых
  // задач (backlog/*.md), а не всех исторических веток task/* на remote.
  const boardIds = new Set(openBoardTaskIds());
  const branches = allTaskRefs.filter((ref) => boardIds.has(ref.replace('origin/task/', '')));
  const conflictingPairs: Array<[string, string]> = [];
  for (let i = 0; i < branches.length; i += 1) {
    const a = branches[i];
    if (a === undefined) continue;
    for (let j = i + 1; j < branches.length; j += 1) {
      const b = branches[j];
      if (b === undefined) continue;
      const result = spawnSync('git', ['merge-tree', '--write-tree', a, b], { stdio: 'ignore' });
      const spawnError = result.error;
      if (spawnError !== null && spawnError !== undefined) {
        problems.push(`git merge-tree ${a}..${b} не выполнился: ${String(spawnError)}`);
      } else if (result.status === 1) {
        // merge-tree --write-tree: 1 = конфликт слияния (git >= 2.38).
        conflictingPairs.push([a, b]);
      } else if (result.status !== 0) {
        problems.push(`git merge-tree ${a}..${b} вернул код ${result.status}`);
      }
    }
  }
  return { branches, conflictingPairs };
}

function collectNightly(
  repo: string,
  runs: GhRun[],
  workDir: string,
  maxPerWindow: number,
  sinceMs: number,
  prevSinceMs: number,
  nowMs: number,
  problems: string[],
): {
  artifactRuns: NightlyArtifactRun[];
  flakyPoints: RatePoint[];
  verifyPoints: VerifyPoint[];
  perfPoints: PerfPoint[];
  mutationPoints: MutationPoint[];
} {
  const artifactRuns: NightlyArtifactRun[] = [];
  const flakyPoints: RatePoint[] = [];
  const verifyPoints: VerifyPoint[] = [];
  const perfPoints: PerfPoint[] = [];
  const mutationPoints: MutationPoint[] = [];
  const selected = selectNewestPerWindow(runs, maxPerWindow, sinceMs, prevSinceMs, nowMs);
  for (const run of selected) {
    const artifacts = listArtifacts(repo, run.id, problems);
    const hasFlaky = findArtifact(artifacts, (name) => name === 'flaky-rate') !== null;
    const verifyArtifact = findArtifact(artifacts, (name) => name.startsWith('verify-durations-'));
    const mutationArtifact = findArtifact(artifacts, (name) => name === 'mutation-full');
    artifactRuns.push({
      runId: run.id,
      date: run.updatedAt,
      flakyRate: hasFlaky,
      verifyDurations: verifyArtifact !== null,
      mutationFull: mutationArtifact !== null,
    });
    // flaky rate: число от гейта check-flaky-rate.ts (--rate-out), B1 ревью.
    const flakyArtifact = findArtifact(artifacts, (name) => name === 'flaky-rate');
    if (flakyArtifact !== null) {
      const contents = extractArtifactFiles(
        repo,
        flakyArtifact.id,
        'flaky-rate.json',
        workDir,
        problems,
        `ночной ${run.id}/flaky-rate`,
      );
      const raw = contents[0];
      if (raw !== undefined) {
        const file = parseJsonOr(
          FlakyRateFileSchema,
          raw,
          problems,
          `ночной ${run.id}/flaky-rate.json`,
        );
        if (file !== null) {
          flakyPoints.push({
            runId: run.id,
            date: run.updatedAt,
            ratePct: file.ratePct,
            flaky: file.flaky,
            total: file.total,
          });
        }
      } else {
        problems.push(`ночной ${run.id}: артефакт flaky-rate заявлен, flaky-rate.json не читается`);
      }
    }
    // Бюджет verify (B1): totalSec из verify-durations.
    if (verifyArtifact !== null) {
      const contents = extractArtifactFiles(
        repo,
        verifyArtifact.id,
        'verify-durations.json',
        workDir,
        problems,
        `ночной ${run.id}/verify-durations`,
      );
      const raw = contents[0];
      if (raw !== undefined) {
        const file = parseJsonOr(
          VerifyDurationsFileSchema,
          raw,
          problems,
          `ночной ${run.id}/verify-durations.json`,
        );
        if (file !== null)
          verifyPoints.push({ runId: run.id, date: run.updatedAt, totalSec: file.totalMs / 1000 });
      } else {
        problems.push(`ночной ${run.id}: артефакт verify-durations заявлен, файл не читается`);
      }
    }
    // Perf: отсутствие perf.json у прогона — no-data (артефакт пишется
    // только при успехе perf+baseline), problem не ставится; legacy-форма
    // исторического артефакта — тоже точка вне тренда, не problem (e34).
    const perfArtifact = findArtifact(artifacts, (name) => name.startsWith('perf-trend-'));
    if (perfArtifact !== null) {
      const contents = extractArtifactFiles(
        repo,
        perfArtifact.id,
        '*perf.json',
        workDir,
        problems,
        `ночной ${run.id}/perf-trend`,
      );
      const raw = contents[0];
      if (raw !== undefined) {
        const { point, problem } = parsePerfPoint(raw, run.id, run.updatedAt);
        if (problem !== null) problems.push(problem);
        if (point !== null) perfPoints.push(point);
      }
    }
    // Mutation: полный score домена apps/api.
    if (mutationArtifact !== null) {
      const contents = extractArtifactFiles(
        repo,
        mutationArtifact.id,
        '*mutation.json',
        workDir,
        problems,
        `ночной ${run.id}/mutation-full`,
      );
      const raw = contents[0];
      if (raw !== undefined) {
        const file = parseJsonOr(
          MutationFileSchema,
          raw,
          problems,
          `ночной ${run.id}/mutation.json`,
        );
        if (file !== null) {
          const statuses = Object.values(file.files).flatMap((fileEntry) =>
            fileEntry.mutants.map((mutant) => mutant.status),
          );
          if (statuses.length === 0) {
            problems.push(`ночной ${run.id}/mutation.json: ни одного мутанта`);
          } else {
            mutationPoints.push({
              runId: run.id,
              date: run.updatedAt,
              score: mutationScoreFromMutants(statuses).score,
            });
          }
        }
      } else {
        problems.push(
          `ночной ${run.id}: артефакт mutation-full заявлен, mutation.json не читается`,
        );
      }
    }
  }
  return { artifactRuns, flakyPoints, verifyPoints, perfPoints, mutationPoints };
}

function collectDenials(
  repo: string,
  runs: GhRun[],
  workDir: string,
  problems: string[],
): DenialRecord[] {
  const denials: DenialRecord[] = [];
  // Артефакт gate-denials пишется только if: failure() (gate-integrity.yml) —
  // перебираем только красные прогоны (блокер 4 ревью 2: gate-integrity
  // триггерится на 7 PR-событий, полный перебор уложит job в рейт-лимит);
  // зелёный/отменённый прогон = 0 отказов, absent-vs-zero не меняется.
  const failureRuns = runs.filter((run) => run.conclusion === 'failure');
  for (const run of failureRuns) {
    const artifact = findArtifact(
      listArtifacts(repo, run.id, problems),
      (name) => name === 'gate-denials',
    );
    if (artifact === null) continue; // зелёный прогон = 0 отказов (absent-vs-zero)
    const contents = extractArtifactFiles(
      repo,
      artifact.id,
      'denials.jsonl',
      workDir,
      problems,
      `gate-integrity ${run.id}/gate-denials`,
    );
    const raw = contents[0];
    if (raw === undefined) {
      problems.push(
        `gate-integrity ${run.id}: артефакт gate-denials заявлен, denials.jsonl не читается`,
      );
      continue;
    }
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // битая строка журнала разбор не роняет (C9.3)
      }
      const record = DenialRecordSchema.safeParse(parsed);
      if (record.success) denials.push(record.data);
    }
  }
  return denials;
}

function collectEvals(
  repo: string,
  runs: GhRun[],
  workDir: string,
  maxPerWindow: number,
  sinceMs: number,
  prevSinceMs: number,
  nowMs: number,
  problems: string[],
): EvalsPoint[] {
  const points: EvalsPoint[] = [];
  // Кап свежайших прогонов каждого окна — как у nightly (блокер 4 ревью 2:
  // без капа перебор уложит job в timeout/рейт-лимит на большом окне).
  const selected = selectNewestPerWindow(runs, maxPerWindow, sinceMs, prevSinceMs, nowMs);
  for (const run of selected) {
    if (run.conclusion === 'skipped') {
      // Скип без секрета — «не собирается», не ноль и не проблема (ревью c9.4).
      points.push({
        runId: run.id,
        date: run.updatedAt,
        conclusion: 'skipped',
        scenarios: null,
        passed: null,
        timeMs: null,
        tokens: null,
        neutral: true,
      });
      continue;
    }
    const artifact = findArtifact(listArtifacts(repo, run.id, problems), (name) =>
      name.startsWith('evals-'),
    );
    if (artifact === null) {
      // Ревью 2 (B1): при отсутствии секрета job gate зелёный, job «agent
      // evals» скипнут по has_key — conclusion прогона SUCCESS без артефакта;
      // нейтрально «не собирается». Problem — только у упавшего прогона.
      const neutral = evalsMissingArtifactPolicy(run.conclusion, run.id, problems);
      points.push({
        runId: run.id,
        date: run.updatedAt,
        conclusion: run.conclusion,
        scenarios: null,
        passed: null,
        timeMs: null,
        tokens: null,
        neutral,
      });
      continue;
    }
    const contents = extractArtifactFiles(
      repo,
      artifact.id,
      'report-*.json',
      workDir,
      problems,
      `evals ${run.id}`,
    );
    if (contents.length === 0) {
      problems.push(`evals: прогон ${run.id} (${run.conclusion}) без report-*.json в артефакте`);
      continue;
    }
    for (const raw of contents) {
      const file = parseJsonOr(EvalsTotalsFileSchema, raw, problems, `evals ${run.id}/report`);
      if (file !== null) {
        points.push({
          runId: run.id,
          date: run.updatedAt,
          conclusion: run.conclusion,
          scenarios: file.totals.scenarios,
          passed: file.totals.passed,
          timeMs: file.totals.timeMs,
          tokens: file.totals.tokens,
          neutral: false,
        });
      }
    }
  }
  return points;
}

function readTargets(problems: string[]): TelemetryInputs['targets'] {
  const verifyBudgetsPath = 'verify-budgets.json';
  const strykerPath = 'apps/api/stryker.config.json';
  try {
    const perfBudgets = loadPerfBudgets();
    const verifyBudgets = parseBudgets(JSON.parse(readFileSync(verifyBudgetsPath, 'utf8')));
    const strykerConfig = StrykerConfigSchema.parse(JSON.parse(readFileSync(strykerPath, 'utf8')));
    const perfScenarioMaxMs: Record<string, number> = {};
    for (const [name, scenario] of Object.entries(perfBudgets.web.scenarios)) {
      perfScenarioMaxMs[`scenario:${name}`] = scenario.maxMs;
    }
    return {
      ciP50Min: 10, // vision L3
      mergeQueueP50Min: 15, // vision L4
      flakyPct: 1, // vision G4
      verifyTotalSlowSec: verifyBudgets.totalSlow,
      perfScenarioMaxMs,
      mutationBreak: strykerConfig.thresholds.break,
    };
  } catch (error) {
    problems.push(
      `цели (verify-budgets.json / perf-budgets.json / stryker.config.json) не прочитаны: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      ciP50Min: 10,
      mergeQueueP50Min: 15,
      flakyPct: 1,
      verifyTotalSlowSec: 0,
      perfScenarioMaxMs: {},
      mutationBreak: 0,
    };
  }
}

/**
 * Смёрженные PR окна сбора (блокер 3 ревью 2: без `--search merged:>=` лимит
 * 300 заполнялся бы всей историей через ~месяц и ставил problem каждую ночь —
 * детерминированный ложный красный против З11). mergedSinceIso — дата начала
 * предыдущего окна (YYYY-MM-DD).
 */
function mergedPrsFromGh(mergedSinceIso: string, problems: string[]): MergedPr[] {
  let raw: string;
  try {
    raw = gh([
      'pr',
      'list',
      '--state',
      'merged',
      '--search',
      `merged:>=${mergedSinceIso}`,
      '--limit',
      '300',
      '--json',
      'number,body,mergedAt',
    ]);
  } catch (error) {
    problems.push(
      `gh pr list не удался: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
  const parsed = PrListSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    problems.push('gh pr list: неожиданный ответ API');
    return [];
  }
  const prs: MergedPr[] = parsed.data.map((pr) => {
    const valid = MergedPrSchema.safeParse(pr);
    return valid.success ? valid.data : { number: pr.number, body: '', mergedAt: pr.mergedAt };
  });
  if (prs.length >= 300) {
    problems.push(
      'список смёрженных PR упёрся в лимит 300 внутри окна сбора — доля агентных PR может быть усечена',
    );
  }
  return prs;
}

function argValue(name: string, args: string[]): string {
  const idx = args.indexOf(name);
  return idx >= 0 ? (args[idx + 1] ?? '') : '';
}

function main(): void {
  const args = process.argv.slice(2);
  const local = args.includes('--local');
  const summary = args.includes('--summary');
  const periodDays = Number(argValue('--period-days', args)) || 30;
  const maxPerWindow = Number(argValue('--max-runs', args)) || 20;
  const out = argValue('--out', args) || 'reports/trends.json';
  const nowIso = new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const sinceMs = nowMs - periodDays * 86_400_000;
  const prevSinceMs = sinceMs - periodDays * 86_400_000;
  const workDir = mkdtempSync(join(tmpdir(), 'telemetry-'));
  const problems: string[] = [];

  // Fail-closed без крэша: пустой реестр + problem, если файл не читается.
  let escapedDefectsMarkdown = '## Реестр\n\n';
  try {
    escapedDefectsMarkdown = readFileSync('docs/escaped-defects.md', 'utf8');
  } catch (error) {
    problems.push(
      `escaped-defects.md не читается (${error instanceof Error ? error.message : String(error)}) — метрика не собрана`,
    );
  }
  const taskConflicts = taskConflictsFromGit(problems);
  const targets = readTargets(problems);

  let ciRuns: WorkflowRun[] = [];
  let nightlyArtifactRuns: NightlyArtifactRun[] = [];
  let flakyPoints: RatePoint[] = [];
  let verifyPoints: VerifyPoint[] = [];
  let perfPoints: PerfPoint[] = [];
  let mutationPoints: MutationPoint[] = [];
  let evalsPoints: EvalsPoint[] = [];
  let mergedPrs: MergedPr[] = [];
  let denials: DenialRecord[] = [];
  let denialsSource: string;
  let denialsCoverage: string;

  if (local) {
    // Локальный режим (З5, shift-left): только то, что есть на машине.
    denialsSource = 'локальный журнал отказов (tools/denial-journal.ts)';
    denialsCoverage =
      'локальный журнал одной машины (--local); CI-артефакты gate-denials не загружались; cross-machine агрегация — граница C9.3, ждёт хранилище вне машины (A7); ноль не читается как «попыток нет вообще»';
    for (const record of readDenials(journalPath())) {
      const valid = DenialRecordSchema.safeParse(record);
      if (valid.success) denials.push(valid.data);
    }
  } else {
    let repo = argValue('--repo', args);
    if (repo === '') repo = process.env['GITHUB_REPOSITORY'] ?? '';
    if (repo === '') {
      try {
        repo = gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim();
      } catch (error) {
        problems.push(
          `repo не определён (--repo / GITHUB_REPOSITORY / gh repo view): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const createdSince = new Date(prevSinceMs).toISOString();
    ciRuns = listRuns(repo, 'ci.yml', createdSince, problems).map((run) => ({
      id: run.id,
      event: run.event,
      conclusion: run.conclusion,
      runStartedAt: run.runStartedAt ?? '',
      updatedAt: run.updatedAt,
    }));
    const nightly = collectNightly(
      repo,
      // branch main (B2 ревью 2): workflow_dispatch на ветке задачи не должен
      // подсовывать веточные прогоны в «свежайшие» и точки тренда (A6.1).
      listRuns(repo, 'nightly.yml', createdSince, problems, 'main'),
      workDir,
      maxPerWindow,
      sinceMs,
      prevSinceMs,
      nowMs,
      problems,
    );
    flakyPoints = nightly.flakyPoints;
    verifyPoints = nightly.verifyPoints;
    perfPoints = nightly.perfPoints;
    mutationPoints = nightly.mutationPoints;
    nightlyArtifactRuns = nightly.artifactRuns;
    const giRuns = listRuns(repo, 'gate-integrity.yml', createdSince, problems);
    denials = collectDenials(repo, giRuns, workDir, problems);
    denialsSource = 'CI gate-integrity (артефакты gate-denials)';
    denialsCoverage =
      'только CI-слой: артефакты gate-denials красных прогонов gate-integrity (перебор ограничен failure-прогонами — артефакт пишется только if: failure, ревью 2); отсутствие артефакта у зелёного прогона = 0 отказов того прогона (ревью c9.4: absent-vs-zero); локальные журналы машин не агрегируются (граница C9.3, ждёт хранилище вне машины — A7); ноль не читается как «попыток нет вообще» — это только CI';
    evalsPoints = collectEvals(
      repo,
      listRuns(repo, 'evals.yml', createdSince, problems, 'main'),
      workDir,
      maxPerWindow,
      sinceMs,
      prevSinceMs,
      nowMs,
      problems,
    );
    mergedPrs = mergedPrsFromGh(new Date(prevSinceMs).toISOString().slice(0, 10), problems);
  }

  const inputs: TelemetryInputs = {
    nowIso,
    periodDays,
    targets,
    conventionSinceIso: AGENT_MARKER_CONVENTION_SINCE,
    ciRuns,
    nightlyArtifactRuns,
    flakyPoints,
    verifyPoints,
    perfPoints,
    mutationPoints,
    denials,
    denialsSource,
    denialsCoverage,
    mergedPrs,
    evalsPoints,
    escapedDefectsMarkdown,
    taskConflicts,
    problems,
  };
  const report = buildTrendsReport(inputs);
  rmSync(workDir, { recursive: true, force: true });

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  if (summary && process.env['GITHUB_STEP_SUMMARY'] !== undefined) {
    appendFileSync(process.env['GITHUB_STEP_SUMMARY'], `${renderSummary(report)}\n`);
  }
  console.log(`trends: отчёт ${out} (проблем источников: ${report.problems.length})`);
  // З4/З11: сломанный источник — красный прогон, issue создаёт job report.
  process.exitCode = report.problems.length > 0 ? 1 : 0;
}

main();
