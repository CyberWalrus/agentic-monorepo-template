import { isContractProcedure } from '@orpc/contract';
import { describe, expect, it } from 'vitest';

import { contract } from './index.ts';
import { commonErrors, notFoundError } from './errors.ts';

/** Каталог целиком: каждый объявленный где-то код обязан иметь его текст. */
const catalogMessages: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(commonErrors).map(([code, item]) => [code, item.message ?? '']),
  ),
  NOT_FOUND: notFoundError.message ?? '',
};

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

  it('every declared error message comes from the catalog', () => {
    expect(procedures.length).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const { path, errors } of procedures) {
      for (const [code, item] of Object.entries(errors)) {
        const expected = catalogMessages[code];
        if (expected === undefined) {
          violations.push(`${path}: ${code} is declared outside the catalog`);
        } else if (item.message !== expected) {
          violations.push(`${path}: ${code} message is not the catalog one`);
        }
      }
    }
    expect(violations, 'procedures with off-catalog error declarations').toEqual([]);
  });

  it('NOT_FOUND is declared only where it is possible at all', () => {
    const withNotFound = procedures
      .filter((p) => p.errors['NOT_FOUND'] !== undefined)
      .map((p) => p.path);

    expect(withNotFound).toContain('tasks.toggle');
    // remove без NOT_FOUND: отказ fail-closed без оракула существования (C2.3)
    expect(withNotFound).not.toContain('tasks.remove');
  });
});
