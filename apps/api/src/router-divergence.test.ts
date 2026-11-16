import { describe, expect, it } from 'vitest';

import {
  accessPolicyFromMeta,
  collectProcedures,
  proceduresWithoutAuthorization,
} from './authorization.ts';
import { router } from './router.ts';

describe('router divergence from contract', () => {
  it('every procedure declares a valid access policy', () => {
    const diverged: string[] = [];

    for (const { path, procedure } of collectProcedures(router)) {
      if (!accessPolicyFromMeta(procedure['~orpc'].meta)) {
        diverged.push(`${path.join('.')}: ${JSON.stringify(procedure['~orpc'].meta)}`);
      }
    }

    expect(diverged, `procedures without a valid policy:\n${diverged.join('\n')}`).toEqual([]);
  });

  it('every procedure runs the authorization middleware — no bypass', () => {
    expect(proceduresWithoutAuthorization(router)).toEqual([]);
  });
});
