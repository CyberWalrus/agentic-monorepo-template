/**
 * Гейт примера окружения (C3.1): у каждого приложения есть `env.example`
 * (имя вне шаблона `.env.*` — решение задачи C3.1, чтобы файл мог читать
 * агент внутри существующего запрета чтения `.env.*`), формат `KEY=VALUE`,
 * без export, пробелов вокруг `=`, дублей и пустых имён ключей.
 * Полнота относительно схемы и валидность значений держатся тестами
 * приложений (env-example.test.ts рядом с env-модулем): они импортируют
 * ENV_KEYS из env-модуля — импортировать код приложения из tools нельзя
 * (границы).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const EXAMPLES = [join('apps', 'api', 'env.example'), join('apps', 'web', 'env.example')];

const problems: string[] = [];

for (const path of EXAMPLES) {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    problems.push(`${path}: файл отсутствует (C3.1: у каждого приложения env.example)`);
    continue;
  }
  const seen = new Set<string>();
  for (const [index, line] of raw.split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const lineNo = index + 1;
    if (trimmed.startsWith('export ')) {
      problems.push(`${path}:${lineNo}: export не нужен в env-файле`);
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq <= 0) {
      problems.push(`${path}:${lineNo}: строка не вида KEY=VALUE`);
      continue;
    }
    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
      problems.push(`${path}:${lineNo}: имя ключа не в формате UPPER_SNAKE: ${key}`);
    }
    if (key !== key.trim() || value.startsWith(' ') || value.endsWith(' ')) {
      problems.push(`${path}:${lineNo}: пробелы вокруг = не допускаются`);
    }
    if (seen.has(key)) {
      problems.push(`${path}:${lineNo}: дублирующийся ключ ${key}`);
    }
    seen.add(key);
  }
  if (seen.size === 0) {
    problems.push(`${path}: нет ни одной переменной`);
  }
}

if (problems.length > 0) {
  console.error(`env: пример окружения невалиден (C3.1):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('env: env.example приложений существуют и имеют формат KEY=VALUE');
