import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { loadServerEnv, SERVER_ENV_KEYS } from './server-config.ts';

// C3.1: env.example полон относительно схемы и валиден по ней. Формат файла
// (KEY=VALUE, без дублей) держит tools/check-env-example.ts, полнота — здесь,
// потому что список ключей знает только env-модуль (импорт из tools запрещён).

const examplePath = join(resolve(import.meta.dirname, '..'), 'env.example');

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

it('env.example api содержит все ключи схемы окружения', () => {
  const parsed = parseDotenv(readFileSync(examplePath, 'utf8'));
  const missing = SERVER_ENV_KEYS.filter((key) => !(key in parsed));
  expect(`missing: ${missing.join(', ')}`).toBe('missing: ');
});

it('env.example api валиден по схеме: loadServerEnv не отказывает', () => {
  expect(() => loadServerEnv(parseDotenv(readFileSync(examplePath, 'utf8')))).not.toThrow();
});
