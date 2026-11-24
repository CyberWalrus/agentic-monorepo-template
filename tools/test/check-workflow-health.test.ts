/**
 * Канарейка e26: сводный check здоровья workflow детектирует «workflow не
 * стартовал» (синтетическая фикстура escaped-defect 2026-11-21), красный
 * прогон на head SHA, устаревший schedule и не даёт ложных красных на
 * paths-фильтрах и молодых workflow; fail-loud без данных API (З11); проводка
 * хост-воркфлоу, deny/KNOWN_GATES и ссылки реестра escaped-defects на месте.
 *
 * Канарейка e39 (самоссылка): чекер не судит о собственном хосте — красный
 * прошлый прогон хоста не нарушение, красный прогон любого иного workflow —
 * нарушение, как прежде; хост — ровно один workflow, и это SELF_HOST_WORKFLOW
 * (иначе петля «красная ночь красит ночи» возвращается на новом месте).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';

import {
  SELF_HOST_WORKFLOW,
  loadScope,
  parseWorkflowTriggers,
  scopeOfWork,
} from '../check-workflow-health.ts';

vi.setConfig({ testTimeout: 30_000 });

const repoDir = resolve(import.meta.dirname, '..', '..');
const tool = join(repoDir, 'tools', 'check-workflow-health.ts');
const tmp = mkdtempSync(join(tmpdir(), 'e26-workflow-health-'));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const DAY_MS = 24 * 60 * 60_000;
const iso = (daysAgo: number): string => new Date(Date.now() - daysAgo * DAY_MS).toISOString();
const HEAD_SHA = 'e26abc1234567890fedcba9876543210abcdef12';

interface FixtureWorkflow {
  id: number;
  path: string;
  created_at: string;
  state?: string;
}

interface FixtureRun {
  id: number;
  workflow_id: number;
  head_branch: string;
  head_sha: string;
  event: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  run_started_at: string;
}

interface TreeOptions {
  /** Содержимое файлов .github/workflows: имя → текст. */
  workflows: Record<string, string>;
  apiWorkflows: FixtureWorkflow[];
  headRuns?: FixtureRun[];
  pushRuns?: FixtureRun[];
  scheduleRuns?: FixtureRun[];
}

let runSeq = 0;
function runOf(workflowId: number, overrides: Partial<FixtureRun> = {}): FixtureRun {
  runSeq += 1;
  return {
    id: runSeq,
    workflow_id: workflowId,
    head_branch: 'main',
    head_sha: HEAD_SHA,
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    created_at: iso(1),
    run_started_at: iso(1),
    ...overrides,
  };
}

function setupTree(name: string, options: TreeOptions): { root: string; api: string } {
  const root = join(tmp, name);
  const wfDir = join(root, '.github', 'workflows');
  const api = join(root, 'api');
  mkdirSync(wfDir, { recursive: true });
  mkdirSync(api, { recursive: true });
  for (const [file, text] of Object.entries(options.workflows)) {
    writeFileSync(join(wfDir, file), text);
  }
  writeFileSync(join(api, 'head.json'), JSON.stringify({ sha: HEAD_SHA }));
  writeFileSync(join(api, 'workflows.json'), JSON.stringify(options.apiWorkflows));
  writeFileSync(join(api, 'head-runs.json'), JSON.stringify(options.headRuns ?? []));
  writeFileSync(join(api, 'push-runs.json'), JSON.stringify(options.pushRuns ?? []));
  writeFileSync(join(api, 'schedule-runs.json'), JSON.stringify(options.scheduleRuns ?? []));
  return { root, api };
}

function runChecker(
  api: string,
  extra: string[] = [],
): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync(
    'node',
    [
      tool,
      '--workflows-dir',
      join(api, '..', '.github', 'workflows'),
      '--fixture-api',
      api,
      ...extra,
    ],
    { encoding: 'utf8', timeout: 60_000 },
  );
  return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
}

const CI_PUSH = [
  'name: CI',
  'on:',
  '  push:',
  '    branches: [main]',
  '',
  'jobs:',
  '  static:',
  '    runs-on: ubuntu-latest',
].join('\n');
const SCHEDULE_WF = [
  'name: Nightly',
  'on:',
  '  schedule:',
  "    - cron: '0 3 * * *'",
  '  workflow_dispatch:',
  '',
  'jobs:',
  '  job1:',
  '    runs-on: ubuntu-latest',
].join('\n');
/** Собственный хост чекера (e39): push на main, schedule и dispatch. */
const HEALTH_WF = [
  'name: Workflow health',
  'on:',
  '  push:',
  '    branches: [main]',
  '  schedule:',
  "    - cron: '40 4 * * *'",
  '  workflow_dispatch:',
  '',
  'jobs:',
  '  workflow-health:',
  '    runs-on: ubuntu-latest',
].join('\n');
/**
 * Путь хоста литералом: фикстура остаётся валидной и на чекере без константы —
 * до правки тест красный по причине самоссылки, а не fail-loud фикстуры.
 */
const HOST_PATH = '.github/workflows/workflow-health.yml';
const PR_ONLY = [
  'name: Preview',
  'on:',
  '  pull_request:',
  '',
  'jobs:',
  '  job1:',
  '    runs-on: ubuntu-latest',
].join('\n');
const PUSH_PATHS = [
  'name: Evals',
  'on:',
  '  push:',
  '    branches: [main]',
  '    paths:',
  "      - 'tools/**'",
  '  schedule:',
  "    - cron: '0 5 * * 1'",
  '',
  'jobs:',
  '  job1:',
  '    runs-on: ubuntu-latest',
].join('\n');

it('синтетическая фикстура «workflow не стартовал» — красный с причиной (критерий приёмки e26)', () => {
  // Escaped-defect 2026-11-21: файл workflow есть (push на main), прогонов нет.
  const tree = setupTree('not-started', {
    workflows: { 'ci.yml': CI_PUSH },
    apiWorkflows: [{ id: 1, path: '.github/workflows/ci.yml', created_at: iso(30) }],
  });
  const run = runChecker(tree.api);
  expect(run.status).toBe(1);
  expect(run.stderr).toContain('не стартовал на head SHA');
  expect(run.stderr).toContain('ci.yml');
});

it('чистая main: все в области стартовали и зелёные — exit 0 (критерий приёмки e26)', () => {
  const tree = setupTree('clean', {
    workflows: { 'ci.yml': CI_PUSH, 'nightly.yml': SCHEDULE_WF },
    apiWorkflows: [
      { id: 1, path: '.github/workflows/ci.yml', created_at: iso(30) },
      { id: 2, path: '.github/workflows/nightly.yml', created_at: iso(30) },
    ],
    headRuns: [runOf(1)],
    scheduleRuns: [runOf(2, { event: 'schedule', created_at: iso(1), run_started_at: iso(1) })],
  });
  const run = runChecker(tree.api);
  expect(run.status).toBe(0);
  expect(run.stdout).toContain('все стартовали и зелёные');
});

it('красный прогон на head SHA — красный с conclusion; dispatch-success не маскирует', () => {
  const tree = setupTree('red-head', {
    workflows: { 'ci.yml': CI_PUSH },
    apiWorkflows: [{ id: 1, path: '.github/workflows/ci.yml', created_at: iso(30) }],
    // Удачный ручной dispatch на том же SHA не доказывает здоровье push-контура.
    headRuns: [runOf(1, { conclusion: 'failure' }), runOf(1, { event: 'workflow_dispatch' })],
  });
  const run = runChecker(tree.api);
  expect(run.status).toBe(1);
  expect(run.stderr).toContain('красный на head SHA');
  expect(run.stderr).toContain('conclusion=failure');
});

it('push с paths-фильтром: зелёный прогон на старом SHA, на head прогонов нет — зелёный', () => {
  const tree = setupTree('paths-green', {
    workflows: { 'evals.yml': PUSH_PATHS },
    apiWorkflows: [{ id: 1, path: '.github/workflows/evals.yml', created_at: iso(30) }],
    pushRuns: [
      runOf(1, {
        head_sha: 'older1234567890abcdef1234567890abcdef12',
        created_at: iso(3),
        run_started_at: iso(3),
      }),
    ],
    scheduleRuns: [runOf(1, { event: 'schedule', created_at: iso(1), run_started_at: iso(1) })],
  });
  const run = runChecker(tree.api);
  expect(run.status).toBe(0);
});

it('push с paths-фильтром: последний завершённый push-прогон красный — красный', () => {
  const tree = setupTree('paths-red', {
    workflows: { 'evals.yml': PUSH_PATHS },
    apiWorkflows: [{ id: 1, path: '.github/workflows/evals.yml', created_at: iso(30) }],
    pushRuns: [
      runOf(1, {
        head_sha: 'older1234567890abcdef1234567890abcdef12',
        conclusion: 'failure',
        created_at: iso(3),
        run_started_at: iso(3),
      }),
    ],
    scheduleRuns: [runOf(1, { event: 'schedule', created_at: iso(1), run_started_at: iso(1) })],
  });
  const run = runChecker(tree.api);
  expect(run.status).toBe(1);
  expect(run.stderr).toContain('последний завершённый push-прогон красный');
});

it('schedule-прогон старше окна свежести — красный', () => {
  const tree = setupTree('stale-schedule', {
    workflows: { 'nightly.yml': SCHEDULE_WF },
    apiWorkflows: [{ id: 2, path: '.github/workflows/nightly.yml', created_at: iso(30) }],
    scheduleRuns: [runOf(2, { event: 'schedule', created_at: iso(20), run_started_at: iso(20) })],
  });
  const run = runChecker(tree.api);
  expect(run.status).toBe(1);
  expect(run.stderr).toContain('старше окна свежести');
});

it('красный свежий schedule-прогон — красный (находка ревью e26)', () => {
  const tree = setupTree('red-schedule', {
    workflows: { 'nightly.yml': SCHEDULE_WF },
    apiWorkflows: [{ id: 2, path: '.github/workflows/nightly.yml', created_at: iso(30) }],
    scheduleRuns: [
      runOf(2, {
        event: 'schedule',
        conclusion: 'failure',
        created_at: iso(1),
        run_started_at: iso(1),
      }),
    ],
  });
  const run = runChecker(tree.api);
  expect(run.status).toBe(1);
  expect(run.stderr).toContain('красный schedule-прогон');
  expect(run.stderr).toContain('conclusion=failure');
});

it('startup_failure невалидного schedule-воркфлоу — красный', () => {
  const tree = setupTree('startup-failure', {
    workflows: { 'nightly.yml': SCHEDULE_WF },
    apiWorkflows: [{ id: 2, path: '.github/workflows/nightly.yml', created_at: iso(30) }],
    scheduleRuns: [
      runOf(2, {
        event: 'schedule',
        conclusion: 'startup_failure',
        created_at: iso(1),
        run_started_at: iso(1),
      }),
    ],
  });
  const run = runChecker(tree.api);
  expect(run.status).toBe(1);
  expect(run.stderr).toContain('conclusion=startup_failure');
});

it('push с paths: прогонов нет никогда (created_at вне окна), свежий зелёный schedule — зелёный (кейс ревью e26)', () => {
  // Отсутствие push-прогонов у paths-фильтрованного workflow — легитимное
  // состояние «paths не совпали», а не «не стартовал»: окно created_at здесь
  // не аргумент (до фикса ревью этот кейс был ложным красным).
  const tree = setupTree('paths-no-runs-old', {
    workflows: { 'evals.yml': PUSH_PATHS },
    apiWorkflows: [{ id: 1, path: '.github/workflows/evals.yml', created_at: iso(30) }],
    scheduleRuns: [runOf(1, { event: 'schedule', created_at: iso(1), run_started_at: iso(1) })],
  });
  const run = runChecker(tree.api);
  expect(run.status).toBe(0);
});

it('незавершённый старый schedule-прогон — красный «застрял»', () => {
  const tree = setupTree('pending-schedule', {
    workflows: { 'nightly.yml': SCHEDULE_WF },
    apiWorkflows: [{ id: 2, path: '.github/workflows/nightly.yml', created_at: iso(30) }],
    scheduleRuns: [
      runOf(2, {
        event: 'schedule',
        status: 'in_progress',
        conclusion: null,
        created_at: iso(2),
        run_started_at: iso(2),
      }),
    ],
  });
  const run = runChecker(tree.api);
  expect(run.status).toBe(1);
  expect(run.stderr).toContain('schedule-прогон не завершился');
});

it('молодой workflow без прогонов (created_at в окне) — зелёный: ложных красных нет', () => {
  const tree = setupTree('young', {
    workflows: { 'evals.yml': PUSH_PATHS, 'nightly.yml': SCHEDULE_WF },
    apiWorkflows: [
      { id: 1, path: '.github/workflows/evals.yml', created_at: iso(1) },
      { id: 2, path: '.github/workflows/nightly.yml', created_at: iso(1) },
    ],
  });
  const run = runChecker(tree.api);
  expect(run.status).toBe(0);
});

it('PR-only workflow вне области: без прогонов не красит сводный check', () => {
  const tree = setupTree('pr-only', {
    workflows: { 'preview.yml': PR_ONLY, 'ci.yml': CI_PUSH },
    apiWorkflows: [
      { id: 1, path: '.github/workflows/preview.yml', created_at: iso(30) },
      { id: 2, path: '.github/workflows/ci.yml', created_at: iso(30) },
    ],
    headRuns: [runOf(2)],
  });
  const run = runChecker(tree.api);
  expect(run.status).toBe(0);
  expect(run.stdout).not.toContain('preview.yml');
});

it('незавершённый молодой прогон head SHA — зелёный: ночной прогон попал в окно CI', () => {
  const tree = setupTree('pending-young', {
    workflows: { 'ci.yml': CI_PUSH },
    apiWorkflows: [{ id: 1, path: '.github/workflows/ci.yml', created_at: iso(30) }],
    headRuns: [
      runOf(1, {
        status: 'in_progress',
        conclusion: null,
        created_at: iso(0.02),
        run_started_at: iso(0.02),
      }),
    ],
  });
  const run = runChecker(tree.api);
  expect(run.status).toBe(0);
  expect(run.stdout).toContain('прогон в процессе');
});

it('незавершённый старый прогон head SHA — красный «застрял» (fail-closed, З11)', () => {
  const tree = setupTree('pending-stale', {
    workflows: { 'ci.yml': CI_PUSH },
    apiWorkflows: [{ id: 1, path: '.github/workflows/ci.yml', created_at: iso(30) }],
    headRuns: [
      runOf(1, {
        status: 'in_progress',
        conclusion: null,
        created_at: iso(2),
        run_started_at: iso(2),
      }),
    ],
  });
  const run = runChecker(tree.api);
  expect(run.status).toBe(1);
  expect(run.stderr).toContain('застрял');
});

it('workflow не active — вне области, не красит', () => {
  const tree = setupTree('disabled', {
    workflows: { 'ci.yml': CI_PUSH },
    apiWorkflows: [
      { id: 1, path: '.github/workflows/ci.yml', created_at: iso(30), state: 'disabled_manually' },
    ],
  });
  const run = runChecker(tree.api);
  expect(run.status).toBe(0);
});

it('fail-loud (З11): фикстуры API нет — exit 2, а не зелёный', () => {
  const tree = setupTree('loud', {
    workflows: { 'ci.yml': CI_PUSH },
    apiWorkflows: [{ id: 1, path: '.github/workflows/ci.yml', created_at: iso(30) }],
  });
  rmSync(join(tree.api, 'head-runs.json'));
  const run = runChecker(tree.api);
  expect(run.status).toBe(2);
  expect(run.stderr).toContain('fail-loud');
});

// --- Самоссылка (e39) -----------------------------------------------------------

it('самоссылка (e39): красный прошлый schedule-прогон собственного хоста — не нарушение (критерий приёмки e39)', () => {
  // Ночь N чекер красил сам себя; с тех пор остальные workflow зелёные. Прошлая
  // ночь хоста красна только поэтому — для хоста это след собственного
  // вердикта, а не «персистентно красный schedule». Хост вне области сверки.
  const tree = setupTree('self-host-red-past', {
    workflows: { 'nightly.yml': SCHEDULE_WF, 'workflow-health.yml': HEALTH_WF },
    apiWorkflows: [
      { id: 2, path: '.github/workflows/nightly.yml', created_at: iso(30) },
      { id: 3, path: HOST_PATH, created_at: iso(30) },
    ],
    headRuns: [runOf(3)],
    scheduleRuns: [
      runOf(2, { event: 'schedule', created_at: iso(1), run_started_at: iso(1) }),
      runOf(3, {
        event: 'schedule',
        conclusion: 'failure',
        created_at: iso(1),
        run_started_at: iso(1),
      }),
    ],
  });
  const run = runChecker(tree.api);
  expect(run.status).toBe(0);
  expect(run.stderr).not.toContain(SELF_HOST_WORKFLOW);
  expect(run.stdout).toContain(SELF_HOST_WORKFLOW);
  expect(run.stdout).toContain('собственный хост');
});

it('самоссылка (e39): красный schedule-прогон любого иного workflow — нарушение, как прежде', () => {
  const tree = setupTree('self-host-other-red', {
    workflows: { 'nightly.yml': SCHEDULE_WF, 'workflow-health.yml': HEALTH_WF },
    apiWorkflows: [
      { id: 2, path: '.github/workflows/nightly.yml', created_at: iso(30) },
      { id: 3, path: HOST_PATH, created_at: iso(30) },
    ],
    headRuns: [runOf(3)],
    scheduleRuns: [
      runOf(2, {
        event: 'schedule',
        conclusion: 'failure',
        created_at: iso(1),
        run_started_at: iso(1),
      }),
      runOf(3, { event: 'schedule', created_at: iso(1), run_started_at: iso(1) }),
    ],
  });
  const run = runChecker(tree.api);
  expect(run.status).toBe(1);
  expect(run.stderr).toContain('.github/workflows/nightly.yml: красный schedule-прогон');
  expect(run.stderr).not.toContain(SELF_HOST_WORKFLOW);
});

it('push-прогон чекера (--own-event push): сосед на head SHA ещё не создан — «в процессе», не «не стартовал» (e39)', () => {
  // Все прогоны на head SHA создаёт тот же push, что и прогон чекера: в момент
  // проверки сосед может быть ещё не создан. Красить это — ложный шум на каждом
  // мерже. В schedule- и dispatch-прогоне соседей создаёт не то же событие:
  // отсутствие прогонов — класс «не стартовал» (escaped-defect 2026-11-21).
  const tree = setupTree('push-race', {
    workflows: { 'ci.yml': CI_PUSH },
    apiWorkflows: [{ id: 1, path: '.github/workflows/ci.yml', created_at: iso(30) }],
    headRuns: [],
  });
  const pushRun = runChecker(tree.api, ['--own-event', 'push']);
  expect(pushRun.status).toBe(0);
  expect(pushRun.stdout).toContain('ci.yml — в области, прогон ещё не создан (push-прогон чекера)');
  for (const ownEvent of ['schedule', 'workflow_dispatch', '']) {
    const run = runChecker(tree.api, ['--own-event', ownEvent]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('не стартовал на head SHA');
  }
});

it('push-прогон чекера: мгновенно красный сосед на head SHA (startup_failure) — нарушение', () => {
  // Отступление только для «прогонов нет»; завершённый красный прогон чекер
  // видит и на push — сигнал о сломанном main приходит в день поломки.
  const tree = setupTree('push-startup-failure', {
    workflows: { 'ci.yml': CI_PUSH },
    apiWorkflows: [{ id: 1, path: '.github/workflows/ci.yml', created_at: iso(30) }],
    headRuns: [runOf(1, { conclusion: 'startup_failure' })],
  });
  const run = runChecker(tree.api, ['--own-event', 'push']);
  expect(run.status).toBe(1);
  expect(run.stderr).toContain('conclusion=startup_failure');
});

it('парсер триггеров и область на реальных workflow репозитория', () => {
  const wfDir = join(repoDir, '.github', 'workflows');
  const scopeOf = (name: string) => {
    const parsed = parseWorkflowTriggers(readFileSync(join(wfDir, name), 'utf8'));
    return parsed === null ? null : scopeOfWork(parsed, `.github/workflows/${name}`);
  };
  // push на main без paths — проверка head SHA.
  const ci = scopeOf('ci.yml');
  expect(ci?.pushHeadSha).toBe(true);
  expect(ci?.pushPaths).toBe(false);
  expect(ci?.schedule).toBe(false);
  // push на main c paths + schedule — без head-SHA-требования, с окном.
  const evals = scopeOf('evals.yml');
  expect(evals?.pushPaths).toBe(true);
  expect(evals?.pushHeadSha).toBe(false);
  expect(evals?.schedule).toBe(true);
  // push + schedule.
  const security = scopeOf('security.yml');
  expect(security?.pushHeadSha).toBe(true);
  expect(security?.schedule).toBe(true);
  // Хост чекера (e39): push на main + schedule.
  const health = scopeOf('workflow-health.yml');
  expect(health?.pushHeadSha).toBe(true);
  expect(health?.schedule).toBe(true);
  // Только schedule.
  const nightly = scopeOf('nightly.yml');
  expect(nightly?.schedule).toBe(true);
  expect(nightly?.pushHeadSha).toBe(false);
  // PR/dispatch-воркфлоу вне области.
  expect(scopeOf('canaries.yml')).toBeNull();
  expect(scopeOf('agent-review.yml')).toBeNull();
  expect(scopeOf('gate-integrity.yml')).toBeNull();
  expect(scopeOf('preview.yml')).toBeNull();
  expect(scopeOf('visual-approve.yml')).toBeNull();
});

it('область на реальных workflow: собственный хост вне области сверки (e39)', () => {
  const wfDir = join(repoDir, '.github', 'workflows');
  const { scope, selfHosted } = loadScope(wfDir);
  expect(selfHosted).toEqual([SELF_HOST_WORKFLOW]);
  const files = scope.map((entry) => entry.file);
  expect(files).not.toContain(SELF_HOST_WORKFLOW);
  expect(files).toContain('.github/workflows/nightly.yml');
});

it('проводка (e39): хост чекера — ровно workflow-health.yml, nightly его больше не содержит', () => {
  // Шаг переедет в другой файл, а SELF_HOST_WORKFLOW останется прежним — петля
  // «красная ночь красит ночи» вернётся на новом месте.
  const wfDir = join(repoDir, '.github', 'workflows');
  const hosts = readdirSync(wfDir)
    .filter((name) =>
      readFileSync(join(wfDir, name), 'utf8').includes('node tools/check-workflow-health.ts'),
    )
    .toSorted();
  expect(hosts).toEqual([SELF_HOST_WORKFLOW.slice('.github/workflows/'.length)]);

  const nightly = readFileSync(join(wfDir, 'nightly.yml'), 'utf8');
  expect(nightly).not.toContain('node tools/check-workflow-health.ts');
  const nightlyReport = nightly.slice(nightly.indexOf('name: report failure'));
  expect(nightlyReport).not.toContain('workflow-health');

  const health = readFileSync(join(repoDir, SELF_HOST_WORKFLOW), 'utf8');
  expect(health).toContain('GH_TOKEN');
  expect(health).toContain('OWN_EVENT: ${{ github.event_name }}');
  expect(health).toContain('--own-event "$OWN_EVENT"');
  // Красный прогон заводит issue собственным job report: вне required checks
  // молчаливый красный — тот же класс escaped-defect, что закрыл e26.
  const needsBlock = health.slice(health.indexOf('name: report failure'));
  expect(needsBlock).toContain('gh issue create');
  expect(health).toContain('needs: [workflow-health]');

  const protectedRaw: unknown = JSON.parse(
    readFileSync(join(repoDir, 'tools', 'protected-paths.json'), 'utf8'),
  );
  const denyList = (): string[] => {
    if (typeof protectedRaw !== 'object' || protectedRaw === null || Array.isArray(protectedRaw)) {
      throw new Error('protected-paths.json не объект');
    }
    const record: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(protectedRaw)) {
      record[key] = value;
    }
    const deny = record['deny'];
    if (!Array.isArray(deny)) {
      throw new Error('protected-paths.json без deny[]');
    }
    return deny.filter((entry): entry is string => typeof entry === 'string');
  };
  // Новый файл гейт-контура закрыт blanket-записью `.github/**` — отдельной
  // записи не нужно; чекер в deny, как и прежде.
  expect(denyList().includes('.github/**')).toBe(true);
  expect(denyList().includes('tools/check-workflow-health.ts')).toBe(true);

  const toolClass = readFileSync(join(repoDir, 'tools', 'check-tool-class.ts'), 'utf8');
  expect(toolClass).toContain("'tools/check-workflow-health.ts'");

  const escaped = readFileSync(join(repoDir, 'docs', 'escaped-defects.md'), 'utf8');
  expect(escaped).toMatch(/2026-11-21.*e26/);
  expect(escaped).toMatch(/2026-11-24.*e39/);
});
