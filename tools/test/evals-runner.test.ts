import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { runEvals, type RunEvalsOptions } from '../evals/run.ts';

// Раннер гоняется на временном мини-репозитории с заглушками агента, установки
// и verify: интеграционный тест обязан оставаться в бюджете test:hooks (50 с,
// находка sanity-ревью плана C9.1) и не касаться .git основного репозитория.
// Реальные прогоны с claude CLI покрывает AC-протокол задачи C9.1.
// Worktree-проверка ниже безопасна от параллели: worktree создают только тесты
// этого файла, vitest гоняет тесты одного файла последовательно.
vi.setConfig({ testTimeout: 30_000 });

const SCENARIO_RAW = `---
name: due-date
description: Срок задачи
guards-not-present: dueDate
---

Промпт сценария.
`;

const AGENT_STUB = `let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  if (!input.includes('Промпт сценария')) {
    console.error('агент не получил промпт через stdin');
    process.exit(3);
  }
  console.log(JSON.stringify({
    type: 'result', is_error: false, num_turns: 7, duration_ms: 4200, model: 'stub',
    usage: { input_tokens: 100, output_tokens: 20 }, result: 'готово',
  }));
});
`;

const BAD_AGENT_STUB = `process.stdout.write('upstream error, no json\\n');
`;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=e@x', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

function makeFakeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'evals-fake-repo-'));
  writeFileSync(join(root, 'README.md'), 'fake repo\n');
  mkdirSync(join(root, 'apps/demo/src'), { recursive: true });
  writeFileSync(join(root, 'apps/demo/src/demo.ts'), 'export const demo = 1;\n');
  mkdirSync(join(root, 'tools/evals/scenarios'), { recursive: true });
  writeFileSync(join(root, 'tools/evals/scenarios/due-date.md'), SCENARIO_RAW);
  git(root, ['init']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'init', '--quiet']);
  return root;
}

/**
 * Поднимает мини-репозиторий, прогоняет runEvals и убирает всё. commitSha и
 * reportDir возвращаются отдельно: корень удалён к моменту ассертов, git там
 * уже не спросить, а отчёт переживает снос репозитория и чистит вызывающий.
 */
async function withFakeRepo(
  overrides: Partial<RunEvalsOptions> = {},
  options: { scenarioRaw?: string; agentStub?: string } = {},
): Promise<{ commitSha: string; reportDir: string; result: Awaited<ReturnType<typeof runEvals>> }> {
  const root = makeFakeRepo();
  const reportDir = mkdtempSync(join(tmpdir(), 'evals-report-dir-'));
  if (options.scenarioRaw !== undefined) {
    writeFileSync(join(root, 'tools/evals/scenarios/due-date.md'), options.scenarioRaw);
  }
  const agentStub = join(root, '.agent-stub.mjs');
  writeFileSync(agentStub, options.agentStub ?? AGENT_STUB);
  try {
    const result = await runEvals({
      root,
      scenarios: [],
      outDir: reportDir,
      timeoutMinutes: 2,
      keepWorktree: false,
      agentPreset: 'claude',
      agentCommand: `node '${agentStub}'`,
      installCommand: 'true',
      verifyCommand: 'true',
      runId: 'test-run',
      ...overrides,
    });
    const commitSha = git(root, ['rev-parse', 'HEAD']);
    return { commitSha, reportDir, result };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function leftoverWorktrees(): number {
  // Префикс worktree: «evals-» + имя мини-репозитория (evals-fake-repo-XXXXXX).
  return readdirSync(tmpdir()).filter((name) => name.startsWith('evals-evals-fake-repo-')).length;
}

describe('runEvals', () => {
  it('green scenario: all four metrics recorded, report written, worktree cleaned', async () => {
    const { commitSha, reportDir, result } = await withFakeRepo();

    expect(result.exitCode).toBe(0);
    expect(result.report.commit).toBe(commitSha);
    expect(result.report.results[0]).toMatchObject({
      scenario: 'due-date',
      pass: true,
      iterations: 7,
      tokens: 120,
      agentExitCode: 0,
      verifyExitCode: 0,
      invalid: null,
      error: null,
    });
    expect(result.report.results[0]?.timeMs).toBeGreaterThan(0);
    expect(result.report.totals).toEqual({
      scenarios: 1,
      passed: 1,
      failed: 0,
      timeMs: expect.any(Number),
      tokens: 120,
    });
    expect(existsSync(result.reportPath)).toBe(true);
    expect(leftoverWorktrees()).toBe(0);
    rmSync(reportDir, { recursive: true, force: true });
  });

  it('red verify makes the scenario fail with a red exit code', async () => {
    const { result } = await withFakeRepo({ verifyCommand: 'exit 7' });

    expect(result.exitCode).toBe(1);
    expect(result.report.results[0]).toMatchObject({
      pass: false,
      verifyExitCode: 7,
      iterations: 7,
    });
  });

  it('an agent without a JSON result is a loud error, verify stays untouched', async () => {
    const { result } = await withFakeRepo({}, { agentStub: BAD_AGENT_STUB });

    expect(result.exitCode).toBe(1);
    expect(result.report.results[0]).toMatchObject({
      pass: null,
      verifyExitCode: null,
      iterations: null,
    });
    expect(result.report.results[0]?.error ?? '').toMatch(/JSON/);
  });

  it('violated guards refuse to run: реализованная фича не измеряется', async () => {
    const root = makeFakeRepo();
    writeFileSync(join(root, 'apps/demo/src/demo.ts'), 'export const existingFeature = 1;\n');
    writeFileSync(
      join(root, 'tools/evals/scenarios/due-date.md'),
      SCENARIO_RAW.replace('guards-not-present: dueDate', 'guards-not-present: existingFeature'),
    );
    try {
      const result = await runEvals({
        root,
        scenarios: [],
        outDir: join(root, 'reports/evals'),
        timeoutMinutes: 2,
        keepWorktree: false,
        agentPreset: 'claude',
        agentCommand: 'true',
        installCommand: 'true',
        verifyCommand: 'true',
        runId: 'test-run-guards',
      });

      expect(result.exitCode).toBe(1);
      expect(result.report.results[0]).toMatchObject({
        pass: null,
        timeMs: null,
        invalid: expect.stringMatching(/guards-not-present нарушены/),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('unknown scenario name fails loudly with the available list', async () => {
    await expect(withFakeRepo({ scenarios: ['no-such-scenario'] })).rejects.toThrow(
      /no-such-scenario/,
    );
  });
});
