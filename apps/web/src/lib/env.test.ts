import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiBaseUrl, loadWebProcessEnv, loadWebServerEnv } from './env.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('loadWebServerEnv', () => {
  it('parses API_URL into a typed env object', () => {
    expect(loadWebServerEnv({ API_URL: 'http://127.0.0.1:3901' })).toEqual({
      apiUrl: 'http://127.0.0.1:3901',
    });
  });

  it('rejects a missing API_URL with the setup hint', () => {
    expect(() => loadWebServerEnv({})).toThrow(/API_URL is empty or not an http\(s\) URL/);
    expect(() => loadWebServerEnv({})).toThrow(/reports\/ports\.json/);
  });

  it('rejects an empty API_URL', () => {
    expect(() => loadWebServerEnv({ API_URL: '' })).toThrow(
      /API_URL is empty or not an http\(s\) URL/,
    );
  });

  it('rejects a value that is not an absolute URL', () => {
    expect(() => loadWebServerEnv({ API_URL: 'not-a-url' })).toThrow(
      /API_URL is empty or not an http\(s\) URL/,
    );
  });

  it('rejects a URL outside the http(s) schemes the proxy and fetch need', () => {
    expect(() => loadWebServerEnv({ API_URL: 'postgres://host.example:5432/db' })).toThrow(
      /API_URL is empty or not an http\(s\) URL/,
    );
  });

  it('keeps a rejected API_URL value out of the failure message', () => {
    let thrown: unknown;
    try {
      loadWebServerEnv({ API_URL: 'postgres://user:secret@host.example:5432/db' });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : '';

    expect(message).toMatch(/API_URL is empty or not an http\(s\) URL/);
    expect(message).not.toContain('secret');
    expect(message).not.toContain('postgres://');
  });
});

describe('loadWebProcessEnv', () => {
  it('parses the production-entry environment into a typed object', () => {
    expect(
      loadWebProcessEnv({ PORT: '3900', HOST: '0.0.0.0', API_URL: 'http://127.0.0.1:3901' }),
    ).toEqual({ port: 3900, host: '0.0.0.0', apiUrl: 'http://127.0.0.1:3901' });
  });

  it('defaults HOST to the loopback so a local entry never binds all interfaces', () => {
    expect(loadWebProcessEnv({ PORT: '3900', API_URL: 'http://127.0.0.1:3901' }).host).toBe(
      '127.0.0.1',
    );
  });

  it('rejects a missing PORT with the setup hint', () => {
    expect(() => loadWebProcessEnv({ API_URL: 'http://127.0.0.1:3901' })).toThrow(
      /PORT is missing.*start:prod/s,
    );
  });

  it('rejects an empty, non-numeric and non-positive PORT', () => {
    const apiUrl = { API_URL: 'http://127.0.0.1:3901' };
    expect(() => loadWebProcessEnv({ ...apiUrl, PORT: '' })).toThrow(/PORT is empty/);
    expect(() => loadWebProcessEnv({ ...apiUrl, PORT: 'abc' })).toThrow(
      /PORT is not a positive integer/,
    );
    expect(() => loadWebProcessEnv({ ...apiUrl, PORT: '12abc' })).toThrow(
      /PORT is not a positive integer/,
    );
    expect(() => loadWebProcessEnv({ ...apiUrl, PORT: '0' })).toThrow(
      /PORT must be greater than zero/,
    );
  });

  it('rejects an empty HOST and HOST with whitespace', () => {
    const env = { PORT: '3900', API_URL: 'http://127.0.0.1:3901' };
    expect(() => loadWebProcessEnv({ ...env, HOST: '' })).toThrow(/HOST is empty/);
    expect(() => loadWebProcessEnv({ ...env, HOST: ' 0.0.0.0' })).toThrow(
      /HOST must not contain whitespace/,
    );
  });

  it('rejects a missing or non-http API_URL at startup so the process fails closed', () => {
    expect(() => loadWebProcessEnv({ PORT: '3900' })).toThrow(/API_URL is empty/);
    expect(() => loadWebProcessEnv({ PORT: '3900', API_URL: 'not-a-url' })).toThrow(/API_URL/);
  });

  it('lists every invalid variable in one failure', () => {
    expect(() => loadWebProcessEnv({ PORT: 'abc', HOST: '', API_URL: 'nope' })).toThrow(
      /PORT is not a positive integer[\s\S]*\n[\s\S]*HOST is empty[\s\S]*\n[\s\S]*API_URL/,
    );
  });
});

// В node-проекте vitest флаг SSR подставлен как true: apiBaseUrl идёт по
// серверной ветви, browser-ветвь с location в этом окружении не выполняется.
describe('apiBaseUrl', () => {
  it('returns the API URL from the environment on the server render', () => {
    vi.stubEnv('API_URL', 'http://127.0.0.1:3901');

    expect(apiBaseUrl()).toBe('http://127.0.0.1:3901');
  });

  it('fails loudly when API_URL is missing on the server render', () => {
    vi.stubEnv('API_URL', '');

    expect(() => apiBaseUrl()).toThrow(/API_URL is empty or not an http\(s\) URL/);
  });
});
