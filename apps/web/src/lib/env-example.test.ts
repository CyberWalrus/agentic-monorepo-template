import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { loadWebProcessEnv, loadWebServerEnv, WEB_ENV_KEYS } from './env.ts';

// C3.1: env.example web полон относительно схем окружения и валиден по ним
// (обе схемы web — SSR и process — живут в одном модуле, C3.0). Формат файла
// держит tools/check-env-example.ts.

const examplePath = join(resolve(import.meta.dirname, '..', '..'), 'env.example');

function parseDotenv(raw: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) parsed[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return parsed;
}

it('env.example web содержит все ключи схем окружения', () => {
  const parsed = parseDotenv(readFileSync(examplePath, 'utf8'));
  const missing = WEB_ENV_KEYS.filter((key) => !(key in parsed));
  expect(`missing: ${missing.join(', ')}`).toBe('missing: ');
});

it('env.example web валиден по process-схеме: loadWebProcessEnv не отказывает', () => {
  expect(() => loadWebProcessEnv(parseDotenv(readFileSync(examplePath, 'utf8')))).not.toThrow();
});

it('env.example web валиден по SSR-схеме: loadWebServerEnv не отказывает', () => {
  expect(() => loadWebServerEnv(parseDotenv(readFileSync(examplePath, 'utf8')))).not.toThrow();
});
