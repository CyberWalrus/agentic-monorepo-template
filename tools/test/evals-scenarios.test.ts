import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  guardViolations,
  parseScenario,
  SCENARIO_NAME_RE,
  type Scenario,
} from '../evals/scenarios.ts';

const scenarioOf = (raw: string, file = 'sc.md'): Scenario => parseScenario(file, raw);

const validScenario = `---
name: due-date
description: Срок задачи
guards-not-present: dueDate, due_date
---

Промпт сценария.
`;

describe('parseScenario', () => {
  it('parses front matter fields and the prompt body', () => {
    const scenario = scenarioOf(validScenario);

    expect(scenario).toEqual({
      name: 'due-date',
      description: 'Срок задачи',
      guardsNotPresent: ['dueDate', 'due_date'],
      prompt: 'Промпт сценария.',
    });
  });

  it('requires front matter', () => {
    expect(() => scenarioOf('Только текст, без front matter')).toThrow(/front matter/);
  });

  it('requires guards: реализованная фича тихо инвертирует смысл метрики', () => {
    const raw = validScenario.replace('guards-not-present: dueDate, due_date\n', '');

    expect(() => scenarioOf(raw)).toThrow(/guards-not-present/);
  });

  it('requires name, description and a non-empty prompt', () => {
    expect(() => scenarioOf(validScenario.replace('name: due-date\n', ''))).toThrow(/name/);
    expect(() => scenarioOf(validScenario.replace('description: Срок задачи\n', ''))).toThrow(
      /description/,
    );
    expect(() => scenarioOf(validScenario.trimEnd().replace('Промпт сценария.', ''))).toThrow(
      /промпт/,
    );
  });

  it('rejects duplicate fields and malformed lines', () => {
    const duplicated = validScenario.replace(
      'description: Срок задачи',
      'description: Раз\ndescription: Два',
    );

    expect(() => scenarioOf(duplicated)).toThrow(/дважды/);
    expect(() => scenarioOf(validScenario.replace('name: due-date', 'name'))).toThrow(
      /ключ: значение/,
    );
  });
});

describe('SCENARIO_NAME_RE', () => {
  it.each([{ name: 'due-date' }, { name: 'a1' }])('accepts $name', ({ name }) => {
    expect(SCENARIO_NAME_RE.test(name)).toBe(true);
  });

  it.each([{ name: 'Due-Date' }, { name: '-lead' }, { name: '' }])('rejects $name', ({ name }) => {
    expect(SCENARIO_NAME_RE.test(name)).toBe(false);
  });
});

describe('guardViolations', () => {
  it('finds a feature identifier already present in product src', () => {
    const root = mkdtempSync(join(tmpdir(), 'evals-guard-tree-'));
    mkdirSync(join(root, 'apps/demo/src'), { recursive: true });
    mkdirSync(join(root, 'packages/lib/src'), { recursive: true });
    writeFileSync(join(root, 'apps/demo/src/task.ts'), 'export const dueDate = null;\n');
    writeFileSync(join(root, 'packages/lib/src/util.ts'), 'export const helper = 1;\n');

    const violations = guardViolations(scenarioOf(validScenario), root);

    expect(violations).toEqual(['dueDate найден в demo/src']);
    rmSync(root, { recursive: true, force: true });
  });

  it('passes a clean tree and ignores non-product dirs', () => {
    const root = mkdtempSync(join(tmpdir(), 'evals-guard-tree-'));
    mkdirSync(join(root, 'tools/evals/scenarios'), { recursive: true });
    writeFileSync(join(root, 'tools/evals/scenarios/due-date.md'), 'dueDate');
    writeFileSync(join(root, 'other.ts'), 'dueDate');

    expect(guardViolations(scenarioOf(validScenario), root)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});
