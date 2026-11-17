import { isContractProcedure } from '@orpc/contract';
import { describe, expect, it } from 'vitest';

import { contract } from './index.ts';
import { ERROR_MESSAGES } from './errors.ts';

interface ProcedureErrors {
  path: string;
  errors: Record<string, { message?: string }>;
}

function collectProcedures(node: unknown, prefix = ''): ProcedureErrors[] {
  if (typeof node !== 'object' || node === null) {
    return [];
  }

  const procedures: ProcedureErrors[] = [];
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isContractProcedure(value)) {
      procedures.push({ path, errors: value['~orpc'].errorMap ?? {} });
    } else {
      procedures.push(...collectProcedures(value, path));
    }
  }
  return procedures;
}

describe('error catalog is the single source of taxonomy messages', () => {
  const procedures = collectProcedures(contract);

  it('every procedure inherits the common errors from the catalog', () => {
    expect(procedures.length).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const { path, errors } of procedures) {
      if (errors['FORBIDDEN']?.message !== ERROR_MESSAGES.FORBIDDEN) {
        violations.push(`${path}: FORBIDDEN message is not the catalog one`);
      }
      if (errors['INTERNAL_SERVER_ERROR']?.message !== ERROR_MESSAGES.INTERNAL) {
        violations.push(`${path}: INTERNAL_SERVER_ERROR message is not the catalog one`);
      }
    }
    expect(violations, 'procedures with off-catalog common error messages').toEqual([]);
  });

  it('NOT_FOUND is declared only through the catalog where it is possible at all', () => {
    const violations: string[] = [];
    const withNotFound: string[] = [];
    for (const { path, errors } of procedures) {
      const item = errors['NOT_FOUND'];
      if (item === undefined) {
        continue;
      }
      withNotFound.push(path);
      if (item.message !== ERROR_MESSAGES.NOT_FOUND) {
        violations.push(`${path}: NOT_FOUND message is not the catalog one`);
      }
    }
    expect(violations).toEqual([]);
    expect(withNotFound).toContain('tasks.toggle');
    // remove без NOT_FOUND: отказ fail-closed без оракула существования (C2.3)
    expect(withNotFound).not.toContain('tasks.remove');
  });
});
