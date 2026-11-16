import { describe, expect, it } from 'vitest';

import { loadWebServerEnv } from './env.ts';

describe('loadWebServerEnv', () => {
  it('parses API_URL into a typed env object', () => {
    expect(loadWebServerEnv({ API_URL: 'http://127.0.0.1:3901' })).toEqual({
      apiUrl: 'http://127.0.0.1:3901',
    });
  });

  it('rejects a missing API_URL with the setup hint', () => {
    expect(() => loadWebServerEnv({})).toThrow(/API_URL is empty or not an absolute URL/);
    expect(() => loadWebServerEnv({})).toThrow(/reports\/ports\.json/);
  });

  it('rejects an empty API_URL', () => {
    expect(() => loadWebServerEnv({ API_URL: '' })).toThrow(
      /API_URL is empty or not an absolute URL/,
    );
  });

  it('rejects a value that is not an absolute URL', () => {
    expect(() => loadWebServerEnv({ API_URL: 'not-a-url' })).toThrow(
      /API_URL is empty or not an absolute URL/,
    );
  });
});
