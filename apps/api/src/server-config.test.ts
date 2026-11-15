import { describe, expect, it } from 'vitest';

import { resolveServerStorage } from './server-config.ts';

describe('resolveServerStorage', () => {
  it('keeps in-memory storage when DATABASE_URL is absent', () => {
    expect(
      resolveServerStorage({
        databaseUrl: undefined,
        enableTestApi: true,
        testApiWithDatabase: false,
      }),
    ).toEqual({ kind: 'memory' });
  });

  it('keeps in-memory storage when DATABASE_URL is empty', () => {
    expect(
      resolveServerStorage({ databaseUrl: '', enableTestApi: false, testApiWithDatabase: false }),
    ).toEqual({ kind: 'memory' });
  });

  it('switches to Postgres when DATABASE_URL is set', () => {
    expect(
      resolveServerStorage({
        databaseUrl: 'postgres://localhost:5432/demo',
        enableTestApi: false,
        testApiWithDatabase: false,
      }),
    ).toEqual({ kind: 'postgres', connectionString: 'postgres://localhost:5432/demo' });
  });

  it('refuses the test API against a real database without the explicit opt-in flag', () => {
    expect(() =>
      resolveServerStorage({
        databaseUrl: 'postgres://localhost:5432/demo',
        enableTestApi: true,
        testApiWithDatabase: false,
      }),
    ).toThrow(/ENABLE_TEST_API_WITH_DATABASE=1/);
  });

  it('allows the test API against a real database with the explicit opt-in flag', () => {
    expect(
      resolveServerStorage({
        databaseUrl: 'postgres://localhost:5432/demo',
        enableTestApi: true,
        testApiWithDatabase: true,
      }),
    ).toEqual({ kind: 'postgres', connectionString: 'postgres://localhost:5432/demo' });
  });
});
