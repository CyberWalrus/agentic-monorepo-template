import { describe, expect, it } from 'vitest';

import { buildAgentInvocation, parseAgentResult } from '../evals/agent.ts';

const greenResult = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 12,
  duration_ms: 123_456,
  model: 'claude-test',
  result: 'готово',
  usage: {
    input_tokens: 1000,
    output_tokens: 200,
    cache_creation_input_tokens: 300,
    cache_read_input_tokens: 4000,
    server_tool_use: { web_search_requests: 2 },
  },
};

const asRun = (stdout: string) => ({ code: 0, stdout, stderr: '', timedOut: false });

describe('parseAgentResult', () => {
  it('extracts all four metric sources from the claude result JSON', () => {
    const metrics = parseAgentResult(asRun(JSON.stringify(greenResult)));

    expect(metrics).toMatchObject({
      iterations: 12,
      tokens: 1000 + 200 + 300 + 4000 + 2,
      cliTimeMs: 123_456,
      model: 'claude-test',
      isError: false,
      resultText: 'готово',
    });
  });

  it('flags an agent-reported error', () => {
    const metrics = parseAgentResult(
      asRun(JSON.stringify({ ...greenResult, is_error: true, result: 'упёрся в гейт' })),
    );

    expect(metrics.isError).toBe(true);
    expect(metrics.resultText).toBe('упёрся в гейт');
  });

  it('tolerates CLI noise around the JSON payload', () => {
    const noisy = `Warning: something\n${JSON.stringify(greenResult)}\n`;
    const metrics = parseAgentResult(asRun(noisy));

    expect(metrics.iterations).toBe(12);
  });

  it('reports missing usage and turns as null, not zero', () => {
    const metrics = parseAgentResult(asRun(JSON.stringify({ type: 'result', is_error: false })));

    expect(metrics.iterations).toBeNull();
    expect(metrics.tokens).toBeNull();
    expect(metrics.cliTimeMs).toBeNull();
  });

  it('fails loudly when no JSON payload is present', () => {
    expect(() => parseAgentResult(asRun('upstream error, no json'))).toThrow(/JSON/);
  });
});

describe('buildAgentInvocation', () => {
  it('builds the claude headless command without a model', () => {
    expect(buildAgentInvocation('claude')).toEqual({
      command: 'claude',
      args: ['-p', '--output-format', 'json', '--dangerously-skip-permissions'],
    });
  });

  it('appends the model flag when a model is pinned', () => {
    const invocation = buildAgentInvocation('claude', 'claude-test');

    expect(invocation.args.at(-2)).toBe('--model');
    expect(invocation.args.at(-1)).toBe('claude-test');
  });

  it('rejects an unknown preset loudly', () => {
    expect(() => buildAgentInvocation('mystery-agent')).toThrow(/mystery-agent/);
  });
});
