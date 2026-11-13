import { describe, expect, it } from 'vitest';

import { assertOwnServer, readInstanceToken } from '../instance.ts';

const TOKEN = '01234567-89ab-cdef-0123-456789abcdef';
const URL = 'http://localhost:3001/health';

function caughtError(run: () => void): Error {
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof Error) {
      return error;
    }
    throw new Error('expected an Error, got a non-Error throw', { cause: error });
  }
  throw new Error('expected the call to throw');
}

describe('readInstanceToken', () => {
  it('accepts a run token and trims surrounding whitespace', () => {
    expect(readInstanceToken(`${TOKEN}\n`)).toBe(TOKEN);
    // Границы формы: ровно 16 и ровно 64 символа валидны (мутанты {15,63}).
    expect(readInstanceToken('a'.repeat(16))).toBe('a'.repeat(16));
    expect(readInstanceToken(`${TOKEN}${'a'.repeat(28)}`)).toBe(`${TOKEN}${'a'.repeat(28)}`);
  });

  it('rejects tokens that are not run tokens', () => {
    const cases = [
      '',
      'not-a-token',
      `${TOKEN}extra`,
      'a'.repeat(15),
      'a'.repeat(65),
      'token\u0000name',
    ];
    for (const raw of cases) {
      expect(caughtError(() => readInstanceToken(raw)).message).toMatch(/unexpected shape/);
    }
  });
});

describe('assertOwnServer', () => {
  it('accepts the server this run started', () => {
    expect(() =>
      assertOwnServer({ url: URL, expected: TOKEN, health: { status: 'ok', instance: TOKEN } }),
    ).not.toThrow();
  });

  it('rejects a server without an instance id (started outside e2e)', () => {
    for (const health of [
      { status: 'ok', instance: null },
      { status: 'ok', instance: '' },
    ]) {
      const error = caughtError(() => assertOwnServer({ url: URL, expected: TOKEN, health }));
      expect(error.message).toMatch(/no instance id/);
      expect(error.message).toContain(URL);
    }
  });

  it('rejects a foreign instance with both ids in the message', () => {
    const error = caughtError(() =>
      assertOwnServer({
        url: URL,
        expected: TOKEN,
        health: { status: 'ok', instance: 'other-run-token' },
      }),
    );
    expect(error.message).toMatch(/another instance/);
    expect(error.message).toContain('other-run-token');
    expect(error.message).toContain(TOKEN);
  });

  it('rejects an answer that is not a health report', () => {
    for (const health of [undefined, null, 'ok', { instance: TOKEN }, { status: 'error' }]) {
      const error = caughtError(() => assertOwnServer({ url: URL, expected: TOKEN, health }));
      expect(error.message).toMatch(/did not answer with a health report/);
    }
  });

  it('escapes control characters from the answer before printing', () => {
    const error = caughtError(() =>
      assertOwnServer({ url: URL, expected: TOKEN, health: 'ok\u0000injected' }),
    );
    expect(error.message).not.toContain('\u0000');
    expect(error.message).toContain('\\u0');
  });
});
