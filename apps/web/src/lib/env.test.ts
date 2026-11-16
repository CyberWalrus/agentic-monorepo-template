import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiBaseUrl, loadWebServerEnv } from './env.ts';

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
