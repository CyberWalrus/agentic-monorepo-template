/**
 * Канарейка d17: обязательные check в снимке `.github/rulesets/main.json` и
 * чек-лист `docs/github-setup.md` не расходятся. Новый check в снимке без
 * строки в документации — красная канарейка, а не тихо потерянный ручной шаг.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

interface RulesetSnapshot {
  rules?: Array<{
    type: string;
    parameters?: { required_status_checks?: Array<{ context: string }> };
  }>;
}

function isRulesetSnapshot(value: unknown): value is RulesetSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  return Array.isArray((value as { rules?: unknown }).rules);
}

const repoDir = resolve(import.meta.dirname, '..', '..');
const snapshot: unknown = JSON.parse(
  readFileSync(join(repoDir, '.github', 'rulesets', 'main.json'), 'utf8'),
);
const setupDoc = readFileSync(join(repoDir, 'docs', 'github-setup.md'), 'utf8');

const contexts = isRulesetSnapshot(snapshot)
  ? (snapshot.rules ?? [])
      .filter((rule) => rule.type === 'required_status_checks')
      .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
      .map((check) => check.context)
  : [];

it('в снимке ruleset main есть обязательные check-и', () => {
  expect(contexts.length).toBeGreaterThan(0);
});

it.each(contexts)('github-setup.md называет обязательный check %s', (context) => {
  expect(setupDoc).toContain(context);
});

it('github-setup.md держит инструкцию ручного добавления bundle-approval, пока его нет в снимке', () => {
  const alreadyInSnapshot = contexts.includes('bundle-approval');
  const documented =
    /bundle-approval[^\n]*добав(ьте|ляется|ляется вручную|ляется вручную шагом)/.test(setupDoc) ||
    /Добавить `bundle-approval` в required checks/.test(setupDoc);
  expect(alreadyInSnapshot || documented).toBe(true);
});
