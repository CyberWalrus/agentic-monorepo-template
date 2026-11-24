/**
 * Классификация прогона раннером канареек (e42): «НЕ УПАЛ» — только когда шаг
 * отработал и не увидел саботажа. Сбой среды (сигнал, холодный старт
 * browser-тестера) — отдельный класс: один повтор, повторный сбой — «СРЕДА, НЕ
 * ВЕРДИКТ». Проводка (worktree, pnpm install, реальный verify) — CI, job canaries.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CANARIES } from '../gate-canaries.ts';
import {
  COLD_BROWSER_START,
  controlRun,
  environmentFailure,
  judgeCanary,
  tripped,
  type CanaryExpectation,
  type VerifyRun,
} from '../run-gate-canaries.ts';

/** Канарейка, на которой ложное «НЕ УПАЛ» повторялось в CI, — из настоящей таблицы. */
const OWNER_CANARY = 'owner-процедура без строки сценария таблицы';

function ownerCanaryOrThrow(): CanaryExpectation {
  const canary = CANARIES.find((item) => item.name === OWNER_CANARY);
  if (canary === undefined) {
    throw new Error(`canary not found in tools/gate-canaries.ts: ${OWNER_CANARY}`);
  }
  return canary;
}

/**
 * Хвост шага `test` дословно из упавшего прогона: job canaries 138067677199,
 * run 45281745218 (PR #198, ветка task/e35), шаг «Run pnpm canaries»,
 * 2026-11-23T22:49:25Z — «canary "owner-процедура без строки сценария таблицы"
 * did not trip its gate». Browser-тест web не импортируется, turbo не доходит
 * до остальных пакетов шага.
 */
const COLD_START_OUTPUT = [
  ' ❯ |browser (chromium)| src/features/tasks/tasks-page.test.tsx (0 test)',
  ' ✓ |browser (chromium)| src/lib/route-states.test.tsx (2 tests) 385ms',
  ' ✓ |node| src/router-gate.test.ts (3 tests) 11ms',
  '',
  '⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯',
  '',
  ' FAIL  |browser (chromium)| src/features/tasks/tasks-page.test.tsx [ src/features/tasks/tasks-page.test.tsx ]',
  'Error: Failed to import test file /tmp/b1-canaries-hXx3P6/apps/web/src/features/tasks/tasks-page.test.tsx',
  'Caused by: TypeError: Failed to fetch dynamically imported module: http://localhost:23315/tmp/b1-canaries-hXx3P6/apps/web/src/features/tasks/tasks-page.test.tsx?import&browserv=1795474162595',
  '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯',
  '',
  ' Test Files  1 failed | 11 passed (12)',
  '      Tests  87 passed (87)',
  '   Start at  22:49:19',
  '   Duration  5.95s (worker 37%, import 28%, transform 19%, tests 16%)',
  '',
  'JSON report written to /tmp/b1-canaries-hXx3P6/apps/web/reports/vitest.json',
  '[ELIFECYCLE] Test failed. See above for more details.',
  '@repo/web#test:  ERROR  command (/tmp/b1-canaries-hXx3P6/apps/web) /home/runner/setup-pnpm/node_modules/.bin/bin/pnpm run test exited (1)',
  '',
  ' Tasks:    3 successful, 5 total',
  'Cached:    2 cached, 5 total',
  '  Time:    7.458s ',
  'Failed:    @repo/web#test',
  '',
  ' ERROR  run failed: command  exited (1)',
].join('\n');

/** Сообщение стража (apps/api/src/owner-access-table.test.ts), когда саботаж пойман. */
const CAUGHT_OUTPUT = [
  ' FAIL  |node| src/owner-access-table.test.ts > owner access table > lists a scenario row for every owner procedure',
  'Error: access scenario row for tasks.evilOwnerProbe is missing',
  ' ❯ src/owner-access-table.test.ts:148:15',
  '',
  ' Test Files  1 failed | 11 passed (12)',
  'Failed:    @repo/api#test',
].join('\n');

/** Шаг отработал и остался зелёным: гейт саботаж не увидел (ослаблен). */
const PASSED_OUTPUT = [
  ' Test Files  12 passed (12)',
  '      Tests  214 passed (214)',
  '   Duration  9.20s (worker 21%, transform 24%, import 28%, tests 27%)',
].join('\n');

/** Шаг красный по посторонней причине — без признаков среды: это вердикт, не сбой среды. */
const UNRELATED_RED_OUTPUT = [
  ' FAIL  |node| src/router-gate.test.ts > router gate > rejects unknown procedure',
  'AssertionError: expected 1 to be 2',
  'Failed:    @repo/api#test',
].join('\n');

/** iframe не готов за connectTimeout — строка @vitest/browser 5.1.1 (orchestrator). */
const NOT_READY_OUTPUT =
  'Error: The iframe "vitest" did not become ready within 30000ms. The tester likely failed to initialize.';

const KILLED_OUTPUT = '@repo/ui#test: :signal SIGTERM';

interface StepOfRun {
  name: string;
  ok: boolean;
  output?: string;
  /** Сообщения diagnostics.findings (b9) — когда хвост вывода их вытеснил. */
  findings?: string[];
}

type StepResult = NonNullable<VerifyRun['json']>['steps'][number];

function stepResult(step: StepOfRun): StepResult {
  const base: StepResult = { name: step.name, ok: step.ok, output: step.output ?? '' };
  if (step.findings === undefined) {
    return base;
  }
  return {
    ...base,
    diagnostics: {
      source: 'vitest-json',
      findings: step.findings.map((message) => ({
        file: 'apps/web/src/features/tasks/tasks-page.test.tsx',
        message,
      })),
    },
  };
}

function runOf(...steps: StepOfRun[]): VerifyRun {
  return {
    json: { ok: steps.every((step) => step.ok), steps: steps.map(stepResult) },
    output: '',
  };
}

/** Прогоны по сценарию: вызов сверх записанного роняет тест (повтор ровно один). */
function scripted(...runs: VerifyRun[]): { runVerify: () => VerifyRun; calls: () => number } {
  let calls = 0;
  return {
    runVerify: () => {
      const next = runs[calls];
      calls += 1;
      if (next === undefined) {
        throw new Error(`verify run #${calls} is not scripted`);
      }
      return next;
    },
    calls: () => calls,
  };
}

describe('environmentFailure: сбоя среды в прогоне', () => {
  it('холодный старт browser-тестера в упавшем шаге — сбой среды (вывод прогона 45281745218)', () => {
    const run = runOf({ name: 'test', ok: false, output: COLD_START_OUTPUT });

    expect(environmentFailure(run)).toBe(
      'step test hit a cold start of the browser tester (Failed to fetch dynamically imported module)',
    );
  });

  it('iframe не готов за connectTimeout — тот же класс', () => {
    const run = runOf({ name: 'test', ok: false, output: NOT_READY_OUTPUT });

    expect(environmentFailure(run)).toBe(
      'step test hit a cold start of the browser tester (did not become ready within)',
    );
  });

  it('убит сигналом — тот же класс', () => {
    const run = runOf({ name: 'test', ok: false, output: KILLED_OUTPUT });

    expect(environmentFailure(run)).toBe('step test was killed by a signal');
  });

  it('признак только в diagnostics.findings (хвост вывода его вытеснил) — сбой среды', () => {
    const run = runOf({
      name: 'test',
      ok: false,
      output: ' Test Files  1 failed | 11 passed (12)',
      findings: [
        'Caused by: TypeError: Failed to fetch dynamically imported module: http://localhost:23315/x.test.tsx',
      ],
    });

    expect(environmentFailure(run)).toContain('cold start of the browser tester');
  });

  it('признак в соседнем упавшем шаге тоже виден: прогон не отработал целиком', () => {
    const run = runOf(
      { name: 'openapi', ok: false, output: 'openapi.json is out of date' },
      { name: 'test', ok: false, output: KILLED_OUTPUT },
    );

    expect(environmentFailure(run)).toBe('step test was killed by a signal');
  });

  it('та же строка в зелёном шаге — не сбой: шаг отработал', () => {
    const run = runOf({ name: 'test', ok: true, output: PASSED_OUTPUT });

    expect(environmentFailure(run)).toBeNull();
  });

  it('упавший шаг без признаков среды — null: общий повтор всех падений не заводим', () => {
    const run = runOf({ name: 'test', ok: false, output: UNRELATED_RED_OUTPUT });

    expect(environmentFailure(run)).toBeNull();
  });

  it('без JSON признак ищется в полном выводе', () => {
    expect(environmentFailure({ json: null, output: `pnpm verify\n${KILLED_OUTPUT}` })).toBe(
      'verify gave no JSON and was killed by a signal',
    );
    expect(
      environmentFailure({ json: null, output: 'pnpm verify\nELIFECYCLE Command failed.' }),
    ).toBeNull();
  });
});

describe('judgeCanary: вердикт канарейки', () => {
  it('саботаж пойман — «красный» за один прогон', () => {
    const runs = scripted(runOf({ name: 'test', ok: false, output: CAUGHT_OUTPUT }));
    const retries: string[] = [];

    const judgment = judgeCanary(ownerCanaryOrThrow(), runs.runVerify, (message) =>
      retries.push(message),
    );

    expect(judgment).toEqual({
      outcome: 'tripped',
      row: `✓ ${OWNER_CANARY.padEnd(30)} → test красный`,
      detail: '',
    });
    expect(runs.calls()).toBe(1);
    expect(retries).toEqual([]);
  });

  it('НЕ УПАЛ: шаг отработал и остался зелёным — без повтора', () => {
    const runs = scripted(runOf({ name: 'test', ok: true, output: PASSED_OUTPUT }));

    const judgment = judgeCanary(ownerCanaryOrThrow(), runs.runVerify, () => {
      throw new Error('no retry expected');
    });

    expect(judgment.outcome).toBe('not-tripped');
    expect(judgment.row).toBe(`✗ ${OWNER_CANARY.padEnd(30)} → test НЕ УПАЛ`);
    expect(judgment.detail).toContain('did not trip its gate');
    expect(runs.calls()).toBe(1);
  });

  it('НЕ УПАЛ: шаг красный по посторонней причине, без признаков среды — вердикт, не повтор', () => {
    const runs = scripted(runOf({ name: 'test', ok: false, output: UNRELATED_RED_OUTPUT }));

    const judgment = judgeCanary(ownerCanaryOrThrow(), runs.runVerify, () => {
      throw new Error('no retry expected');
    });

    expect(judgment.outcome).toBe('not-tripped');
    expect(judgment.row).toContain('НЕ УПАЛ');
    expect(runs.calls()).toBe(1);
  });

  it('НЕ УПАЛ (verify не дал JSON) — прежняя пометка на месте', () => {
    const runs = scripted({ json: null, output: 'ELIFECYCLE Command failed.' });

    const judgment = judgeCanary(ownerCanaryOrThrow(), runs.runVerify, () => {
      throw new Error('no retry expected');
    });

    expect(judgment.row).toBe(`✗ ${OWNER_CANARY.padEnd(30)} → test НЕ УПАЛ (verify не дал JSON)`);
    expect(judgment.detail).toContain('(no json)');
    expect(runs.calls()).toBe(1);
  });

  it('среда → повтор → саботаж пойман: ровно один повтор, вердикт «красный»', () => {
    const runs = scripted(
      runOf({ name: 'test', ok: false, output: COLD_START_OUTPUT }),
      runOf({ name: 'test', ok: false, output: CAUGHT_OUTPUT }),
    );
    const retries: string[] = [];

    const judgment = judgeCanary(ownerCanaryOrThrow(), runs.runVerify, (message) =>
      retries.push(message),
    );

    expect(judgment.outcome).toBe('tripped');
    expect(runs.calls()).toBe(2);
    expect(retries).toHaveLength(1);
    expect(retries[0]).toContain('environment, not a verdict; retrying once');
  });

  it('среда → повтор отработал без саботажа — настоящий «НЕ УПАЛ» за два прогона', () => {
    const runs = scripted(
      runOf({ name: 'test', ok: false, output: COLD_START_OUTPUT }),
      runOf({ name: 'test', ok: true, output: PASSED_OUTPUT }),
    );

    const judgment = judgeCanary(ownerCanaryOrThrow(), runs.runVerify, () => {});

    expect(judgment.outcome).toBe('not-tripped');
    expect(judgment.row).toBe(`✗ ${OWNER_CANARY.padEnd(30)} → test НЕ УПАЛ`);
    expect(runs.calls()).toBe(2);
  });

  it('среда повторно — «СРЕДА, НЕ ВЕРДИКТ», а не «НЕ УПАЛ»: на выводе из п.1 раннер не пишет «НЕ УПАЛ»', () => {
    const twiceCold = runOf({ name: 'test', ok: false, output: COLD_START_OUTPUT });
    const runs = scripted(twiceCold, twiceCold);
    const retries: string[] = [];

    const judgment = judgeCanary(ownerCanaryOrThrow(), runs.runVerify, (message) =>
      retries.push(message),
    );

    expect(judgment.outcome).toBe('environment');
    expect(judgment.row).toBe(
      `✗ ${OWNER_CANARY.padEnd(30)} → test СРЕДА, НЕ ВЕРДИКТ (сбой среды и в повторе)`,
    );
    expect(judgment.row).not.toContain('НЕ УПАЛ');
    expect(judgment.detail).toContain('got no verdict');
    expect(judgment.detail).toContain('step test hit a cold start of the browser tester');
    expect(runs.calls()).toBe(2);
    expect(retries).toHaveLength(1);
  });

  it('сигнал — тот же класс: один повтор, повторный сигнал — «СРЕДА, НЕ ВЕРДИКТ»', () => {
    const killed = runOf({ name: 'test', ok: false, output: KILLED_OUTPUT });
    const runs = scripted(killed, killed);

    const judgment = judgeCanary(ownerCanaryOrThrow(), runs.runVerify, () => {});

    expect(judgment.outcome).toBe('environment');
    expect(judgment.detail).toContain('was killed by a signal');
    expect(runs.calls()).toBe(2);
  });

  it('пойманный саботаж важнее сбоя среды рядом — вердикт без повтора', () => {
    const run = runOf({ name: 'test', ok: false, output: `${CAUGHT_OUTPUT}\n${KILLED_OUTPUT}` });
    const runs = scripted(run);

    const judgment = judgeCanary(ownerCanaryOrThrow(), runs.runVerify, () => {
      throw new Error('no retry expected');
    });

    expect(judgment.outcome).toBe('tripped');
    expect(runs.calls()).toBe(1);
  });

  it('саботаж в diagnostics.findings при сбое среды в хвосте — тоже «красный»', () => {
    const caughtByDiagnostics = runOf({
      name: 'test',
      ok: false,
      output: COLD_START_OUTPUT,
      findings: [
        'apps/api/src/owner-access-table.test.ts:148: access scenario row for tasks.evilOwnerProbe is missing',
      ],
    });
    const runs = scripted(caughtByDiagnostics);

    const judgment = judgeCanary(ownerCanaryOrThrow(), runs.runVerify, () => {
      throw new Error('no retry expected');
    });

    expect(judgment.outcome).toBe('tripped');
    expect(runs.calls()).toBe(1);
  });

  it('regex с флагом g находит саботаж и на повторе: lastIndex не накапливается', () => {
    const stateful = {
      ...ownerCanaryOrThrow(),
      expect: /access scenario row for tasks\.evilOwnerProbe/g,
    };
    const caught = runOf({ name: 'test', ok: false, output: CAUGHT_OUTPUT });

    expect(tripped(stateful, caught)).toBe(true);
    expect(tripped(stateful, caught)).toBe(true);
    const runs = scripted(runOf({ name: 'test', ok: false, output: COLD_START_OUTPUT }), caught);
    expect(judgeCanary(stateful, runs.runVerify, () => {}).outcome).toBe('tripped');
  });

  it('повторов не больше одного: третий прогон не запрашивается', () => {
    const cold = runOf({ name: 'test', ok: false, output: COLD_START_OUTPUT });
    const runs = scripted(cold, cold, runOf({ name: 'test', ok: false, output: CAUGHT_OUTPUT }));

    const judgment = judgeCanary(ownerCanaryOrThrow(), runs.runVerify, () => {});

    expect(judgment.outcome).toBe('environment');
    expect(runs.calls()).toBe(2);
  });
});

describe('controlRun: негатив-контроль', () => {
  const green = runOf({ name: 'lint', ok: true, output: '' });

  it('зелёный контроль — один прогон', () => {
    const runs = scripted(green);

    expect(
      controlRun('lint', runs.runVerify, () => {
        throw new Error('no retry expected');
      }),
    ).toBe(green);
    expect(runs.calls()).toBe(1);
  });

  it('красная база без признака среды — без повтора, прогон возвращается вызывающему', () => {
    const red = runOf({ name: 'lint', ok: false, output: 'lint error' });
    const runs = scripted(red);

    expect(
      controlRun('lint', runs.runVerify, () => {
        throw new Error('no retry expected');
      }),
    ).toBe(red);
    expect(runs.calls()).toBe(1);
  });

  it('сбой среды → повтор → зелёный', () => {
    const runs = scripted(runOf({ name: 'test', ok: false, output: COLD_START_OUTPUT }), green);

    expect(controlRun('test', runs.runVerify, () => {})).toBe(green);
    expect(runs.calls()).toBe(2);
  });

  it('сбой среды дважды — ошибка «СРЕДА, НЕ ВЕРДИКТ» (канарейки не запускаются)', () => {
    const cold = runOf({ name: 'test', ok: false, output: COLD_START_OUTPUT });
    const runs = scripted(cold, cold);

    expect(() => controlRun('test', runs.runVerify, () => {})).toThrow(
      /СРЕДА, НЕ ВЕРДИКТ.*environment failed twice/s,
    );
    expect(runs.calls()).toBe(2);
  });
});

describe('сверка с канарейкой копии', () => {
  it('канарейка копии повторяет холодный старт по тем же маркерам', () => {
    const copyRunner = readFileSync(
      resolve(import.meta.dirname, '..', 'run-template-copy-canary.ts'),
      'utf8',
    );

    for (const marker of COLD_BROWSER_START) {
      expect(copyRunner, `marker: ${marker}`).toContain(marker);
    }
  });
});
