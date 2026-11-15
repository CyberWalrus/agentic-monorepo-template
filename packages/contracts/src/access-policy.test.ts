import { isContractProcedure } from '@orpc/contract';
import { describe, expect, it } from 'vitest';

import { AccessPolicySchema } from './access-policy.ts';
import { contract } from './index.ts';

interface ProcedureMeta {
  path: string;
  meta: Record<string, unknown>;
}

function collectProcedures(node: unknown, prefix = ''): ProcedureMeta[] {
  if (typeof node !== 'object' || node === null) {
    return [];
  }

  const procedures: ProcedureMeta[] = [];
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isContractProcedure(value)) {
      procedures.push({ path, meta: value['~orpc'].meta });
    } else {
      procedures.push(...collectProcedures(value, path));
    }
  }
  return procedures;
}

describe('AccessPolicySchema', () => {
  it.each([
    ['public', { type: 'public' }],
    ['owner', { type: 'owner' }],
    ['admin', { type: 'admin' }],
  ])('accepts the $1 policy', (_name, policy) => {
    expect(AccessPolicySchema.parse(policy)).toEqual(policy);
  });

  it('rejects an unknown policy type', () => {
    expect(AccessPolicySchema.safeParse({ type: 'root' }).success).toBe(false);
  });

  it('rejects a policy without a type', () => {
    expect(AccessPolicySchema.safeParse({}).success).toBe(false);
  });

  it('rejects a non-object policy', () => {
    expect(AccessPolicySchema.safeParse('public').success).toBe(false);
  });
});

describe('contract access policies', () => {
  const procedures = collectProcedures(contract);

  it('contract exposes at least one procedure', () => {
    expect(procedures.length).toBeGreaterThan(0);
  });

  it('every contract procedure declares a valid access policy', () => {
    for (const { path, meta } of procedures) {
      const result = AccessPolicySchema.safeParse(meta['access']);
      expect(
        result.success,
        `procedure ${path} must declare an access policy (public | owner | admin)`,
      ).toBe(true);
    }
  });
});
