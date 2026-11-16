import { isProcedure, type AnyProcedure } from '@orpc/server';
import { describe, expect, it } from 'vitest';

import { accessPolicyFromMeta, authorizationMiddleware } from './authorization.ts';
import { router } from './router.ts';

function* collectProcedures(
  node: unknown,
  path: readonly string[] = [],
): Generator<{ path: readonly string[]; procedure: AnyProcedure }> {
  if (isProcedure(node)) {
    yield { path, procedure: node };
    return;
  }
  if (node === null || typeof node !== 'object') {
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    yield* collectProcedures(value, [...path, key]);
  }
}

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
    const bypassed: string[] = [];

    for (const { path, procedure } of collectProcedures(router)) {
      if (!procedure['~orpc'].middlewares.includes(authorizationMiddleware)) {
        bypassed.push(path.join('.'));
      }
    }

    expect(bypassed, `procedures without the middleware:\n${bypassed.join('\n')}`).toEqual([]);
  });
});
