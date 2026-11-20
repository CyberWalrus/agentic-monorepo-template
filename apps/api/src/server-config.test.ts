import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertTestApiNotInProduction,
  loadServerEnv,
  resolveServerStorage,
} from './server-config.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('loadServerEnv', () => {
  it('parses a complete environment into a typed object', () => {
    const env = loadServerEnv({
      PORT: '3901',
      HOST: '0.0.0.0',
      ENABLE_TEST_API: '1',
      INSTANCE_ID: 'run-1',
      DATABASE_URL: 'postgres://localhost:5432/demo',
      NODE_ENV: 'test',
    });

    expect(env).toStrictEqual({
      port: 3901,
      host: '0.0.0.0',
      instanceId: 'run-1',
      databaseUrl: 'postgres://localhost:5432/demo',
      enableTestApi: true,
      testApiWithDatabase: false,
    });
  });

  it('defaults flags to false and absent optional values to undefined', () => {
    const env = loadServerEnv({ PORT: '3901' });

    expect(env).toStrictEqual({
      port: 3901,
      host: '127.0.0.1',
      instanceId: undefined,
      databaseUrl: undefined,
      enableTestApi: false,
      testApiWithDatabase: false,
    });
  });

  it('defaults HOST to the loopback so a local server never binds all interfaces', () => {
    expect(loadServerEnv({ PORT: '3901' }).host).toBe('127.0.0.1');
  });

  it('accepts the container host from the environment', () => {
    expect(loadServerEnv({ PORT: '3901', HOST: '0.0.0.0' }).host).toBe('0.0.0.0');
    expect(loadServerEnv({ PORT: '3901', HOST: 'api.internal' }).host).toBe('api.internal');
  });

  it('rejects an empty HOST', () => {
    expect(() => loadServerEnv({ PORT: '3901', HOST: '' })).toThrow(/HOST is empty/);
  });

  it('rejects HOST with whitespace', () => {
    expect(() => loadServerEnv({ PORT: '3901', HOST: ' 0.0.0.0' })).toThrow(
      /HOST must not contain whitespace/,
    );
    expect(() => loadServerEnv({ PORT: '3901', HOST: '0.0.0.0\n' })).toThrow(
      /HOST must not contain whitespace/,
    );
  });

  it('reads process.env by default', () => {
    vi.stubEnv('PORT', '3901');

    expect(loadServerEnv().port).toBe(3901);
  });

  it('treats an empty INSTANCE_ID as absent', () => {
    expect(loadServerEnv({ PORT: '3901', INSTANCE_ID: '' }).instanceId).toBeUndefined();
  });

  it('treats an empty DATABASE_URL as absent so storage stays in-memory', () => {
    const env = loadServerEnv({ PORT: '3901', DATABASE_URL: '' });

    expect(env.databaseUrl).toBeUndefined();
    expect(resolveServerStorage(env)).toEqual({ kind: 'memory' });
  });

  it('accepts the word form of the flags, not only "1"', () => {
    const env = loadServerEnv({
      PORT: '3901',
      ENABLE_TEST_API: 'true',
      ENABLE_TEST_API_WITH_DATABASE: 'true',
    });

    expect(env.enableTestApi).toBe(true);
    expect(env.testApiWithDatabase).toBe(true);
  });

  it('accepts the word form of the off state', () => {
    expect(loadServerEnv({ PORT: '3901', ENABLE_TEST_API: '0' }).enableTestApi).toBe(false);
    expect(loadServerEnv({ PORT: '3901', ENABLE_TEST_API: 'false' }).enableTestApi).toBe(false);
  });

  it('rejects word forms outside the pinned boolean vocabulary', () => {
    expect(() => loadServerEnv({ PORT: '3901', ENABLE_TEST_API: 'enabled' })).toThrow(
      /ENABLE_TEST_API/,
    );
    expect(() => loadServerEnv({ PORT: '3901', ENABLE_TEST_API: 'yes' })).toThrow(
      /ENABLE_TEST_API/,
    );
  });

  it('rejects a missing PORT with the setup hint', () => {
    expect(() => loadServerEnv({})).toThrow(/PORT is missing.*pnpm dev/s);
  });

  it('rejects an empty PORT', () => {
    expect(() => loadServerEnv({ PORT: '' })).toThrow(/PORT is empty/);
  });

  it('rejects a non-numeric PORT', () => {
    expect(() => loadServerEnv({ PORT: 'abc' })).toThrow(/PORT is not a positive integer/);
  });

  it('rejects a non-positive PORT', () => {
    expect(() => loadServerEnv({ PORT: '0' })).toThrow(/PORT must be greater than zero/);
  });

  it('rejects a PORT with a trailing non-numeric suffix', () => {
    expect(() => loadServerEnv({ PORT: '12abc' })).toThrow(/PORT is not a positive integer/);
  });

  it('rejects a PORT with a leading non-numeric prefix', () => {
    expect(() => loadServerEnv({ PORT: 'abc12' })).toThrow(/PORT is not a positive integer/);
  });

  it('rejects an unknown flag value instead of treating it as off', () => {
    expect(() => loadServerEnv({ PORT: '3901', ENABLE_TEST_API: '2' })).toThrow(/ENABLE_TEST_API/);
  });

  it('rejects an unknown NODE_ENV so a typo cannot silence the production guard', () => {
    expect(() => loadServerEnv({ PORT: '3901', NODE_ENV: 'prod' })).toThrow(/NODE_ENV/);
  });

  it('accepts the canonical NODE_ENV values', () => {
    expect(() => loadServerEnv({ PORT: '3901', NODE_ENV: 'development' })).not.toThrow();
    expect(() => loadServerEnv({ PORT: '3901', NODE_ENV: 'production' })).not.toThrow();
  });

  it('refuses the test API in production through the schema guard', () => {
    expect(() =>
      loadServerEnv({ PORT: '3901', ENABLE_TEST_API: '1', NODE_ENV: 'production' }),
    ).toThrow(/- ENABLE_TEST_API: ENABLE_TEST_API must never be set in production/);
  });

  it('lists every invalid variable in one failure', () => {
    expect(() => loadServerEnv({ PORT: 'abc', ENABLE_TEST_API: '2', NODE_ENV: 'prod' })).toThrow(
      /PORT is not a positive integer[\s\S]*\n[\s\S]*ENABLE_TEST_API[\s\S]*\n[\s\S]*NODE_ENV/,
    );
  });

  it('keeps secret values out of the failure message', () => {
    let thrown: unknown;
    try {
      loadServerEnv({
        PORT: 'abc',
        DATABASE_URL: 'postgres://user:supersecret@host.example:5432/db',
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : '';

    expect(message).toMatch(/Invalid server environment[\s\S]*PORT/);
    expect(message).not.toContain('supersecret');
    expect(message).not.toContain('postgres://');
  });
});

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

describe('assertTestApiNotInProduction', () => {
  // Второй рубеж запрета (c1.7): createApp зовёт его для входов мимо
  // loadServerEnv. Читает живой process.env — заглушка вместо источника.
  it('throws in production, with the same message as the schema guard', () => {
    vi.stubEnv('NODE_ENV', 'production');

    expect(() => assertTestApiNotInProduction(true)).toThrow(
      'ENABLE_TEST_API must never be set in production',
    );
  });

  it('allows the test API outside production and when not enabled', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(() => assertTestApiNotInProduction(true)).not.toThrow();

    vi.stubEnv('NODE_ENV', 'test');
    expect(() => assertTestApiNotInProduction(true)).not.toThrow();

    vi.stubEnv('NODE_ENV', 'production');
    expect(() => assertTestApiNotInProduction(false)).not.toThrow();
  });

  it('treats an unset NODE_ENV as not production', () => {
    vi.stubEnv('NODE_ENV', undefined);

    expect(() => assertTestApiNotInProduction(true)).not.toThrow();
  });
});
