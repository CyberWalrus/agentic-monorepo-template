/**
 * Канарейка E1: проводка test:hooks под кэшем turbo. turbo.json обязан
 * соответствовать каноническому списку входов (tools/test-hooks-inputs.ts),
 * шаг verify и CI-строка — идти через turbo. Срыв канарейки означает, что
 * изменение где-то из входов больше не даёт cache miss и реальный прогон.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { stripCodeComments } from '../check-tool-class.ts';
import { TEST_HOOKS_INPUTS } from '../test-hooks-inputs.ts';

const repoDir = resolve(import.meta.dirname, '..', '..');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const turbo: unknown = JSON.parse(
  stripCodeComments(readFileSync(join(repoDir, 'turbo.json'), 'utf8')),
);
const rootTask =
  isRecord(turbo) && isRecord(turbo['tasks']) && isRecord(turbo['tasks']['//#test:hooks'])
    ? turbo['tasks']['//#test:hooks']
    : undefined;
const inputs = isRecord(rootTask) ? rootTask['inputs'] : undefined;

it('в turbo.json определена корневая задача //#test:hooks с явными inputs', () => {
  expect(Array.isArray(inputs)).toBe(true);
});

it('inputs //#test:hooks совпадают с каноническим списком (З6)', () => {
  expect(inputs).toEqual([...TEST_HOOKS_INPUTS]);
});

it('шаг test:hooks в verify идёт через turbo (E1)', () => {
  const steps = readFileSync(join(repoDir, 'tools', 'verify-steps.ts'), 'utf8');
  expect(steps).toMatch(/turbo\('test:hooks'\)/);
});

it('job static в ci.yml запускает test:hooks через turbo', () => {
  const ci = readFileSync(join(repoDir, '.github', 'workflows', 'ci.yml'), 'utf8');
  expect(ci).toMatch(/turbo run test:hooks/);
});
