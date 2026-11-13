/**
 * Гейт A8: Docker-образ Playwright в ci.yml задан той же версией, что
 * `@playwright/test` в каталоге pnpm-workspace.yaml. Renovate обновляет их
 * одной группой, но без гейта расхождение всплывало бы только красной
 * visual-джобой CI или диффами базлайнов у локального `pnpm visual`.
 * Заодно сверяет парную запись каталога `playwright` (одна группа Renovate).
 * Версии сверяются точные: образ тегируется без `^`, диапазон в каталоге
 * допустил бы дрейф внутри диапазона. Аргументы (пути к workspace-файлу и
 * ci.yml) — для тестов; по умолчанию репозиторий.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const problems: string[] = [];

const workspacePath =
  process.argv[2] ?? fileURLToPath(new URL('../pnpm-workspace.yaml', import.meta.url));
const ciPath =
  process.argv[3] ?? fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url));

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    problems.push(
      `${path}: unreadable (${error instanceof Error ? error.message : String(error)})`,
    );
    return null;
  }
}

/**
 * Версия записи каталога. Простой построчный парсер достаточно: за формат
 * каталога следит sherif, а структуру YAML за пределами строк `catalog:`
 * чекер не читает (fail-closed: не нашли строку — красный, не догадка).
 * Ключ в каталоге может быть в кавычках (`'@playwright/test':`) или без
 * (`playwright:`) — обязательность кавычек решает YAML, не чекер.
 */
function catalogVersion(source: string, packageName: string): string | null {
  const escaped = packageName.replaceAll('.', '\\.');
  const pattern = new RegExp(`^\\s*['"]?${escaped}['"]?:\\s*['"]?([^'\\s#]+)['"]?\\s*$`);
  for (const line of source.split('\n')) {
    const match = pattern.exec(line);
    if (match !== null) {
      return match[1] ?? null;
    }
  }
  return null;
}

/** Точная версия без диапазона: образ тегируется точным номером, без `^`. */
function exactVersion(version: string | null): string | null {
  return version !== null && /^\d+\.\d+\.\d+$/.test(version) ? version : null;
}

const workspace = readText(workspacePath);
if (workspace !== null) {
  const testVersion = exactVersion(catalogVersion(workspace, '@playwright/test'));
  if (testVersion === null) {
    problems.push(
      `${workspacePath}: catalog has no exact '@playwright/test' version (expected '1.64.1' form)`,
    );
  }
  const runnerVersion = exactVersion(catalogVersion(workspace, 'playwright'));
  if (runnerVersion === null) {
    problems.push(
      `${workspacePath}: catalog has no exact 'playwright' version (expected '1.64.1' form)`,
    );
  }
  if (testVersion !== null && runnerVersion !== null && testVersion !== runnerVersion) {
    problems.push(
      `catalog: 'playwright' (${runnerVersion}) differs from '@playwright/test' (${testVersion}) — Renovate updates them as one group (C11)`,
    );
  }

  const ci = readText(ciPath);
  if (ci !== null) {
    const images = [...ci.matchAll(/image:\s*mcr\.microsoft\.com\/playwright:v([\d.]+)-noble\b/g)];
    if (images.length === 0) {
      problems.push(`${ciPath}: no "image: mcr.microsoft.com/playwright:v…-noble" found`);
    } else if (images.length > 1) {
      problems.push(
        `${ciPath}: ${images.length} Playwright images found — which one is the source of truth?`,
      );
    } else {
      const imageVersion = images[0]?.[1] ?? null;
      if (imageVersion !== null && testVersion !== null && imageVersion !== testVersion) {
        problems.push(
          `Playwright image in ci.yml is v${imageVersion}-noble but catalog '@playwright/test' is ${testVersion} — update them as one group (Renovate, C11)`,
        );
      }
    }
  }
}

if (problems.length > 0) {
  console.error(
    `visual-image: Playwright image and catalog versions diverge:\n- ${problems.join('\n- ')}`,
  );
  process.exit(1);
}
console.log('visual-image: ci.yml image matches catalog @playwright/test');
