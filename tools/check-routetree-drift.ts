/**
 * Гейт дрейфа производного routeTree.gen.ts (b7.1, З10): committed-файл обязан
 * совпадать байт-в-байт со свежей генерацией, выполненной без vite-сборки —
 * шаг verify не может себе позволить сборку (B7: regen через build был
 * командой разрешения конфликта, не проверкой).
 *
 * Механика: `tsr generate` (@tanstack/router-cli) в temp-каталоге с
 * tsr.config.json из абсолютных путей (CLI опций не принимает, конфиг читает
 * из cwd — committed-файл при проверке не трогается), к выводу применяется та
 * же трансформация футера Start, что и в `routes:gen`
 * (apps/web/scripts/routes-gen.ts, withRouteTreeFooter — один источник, З10),
 * дальше сравнение байтов с committed.
 *
 * Сверка версий (З11): CLI жёстко пиннит @tanstack/router-generator своей
 * версии, а vite-сборка использует генератор из чейна react-start
 * (start-plugin-core). Расхождение дало бы дрейф, неотличимый от ручной
 * правки, — гейт сравнивает версии по реальному резолву (realpath-якоря:
 * без разыменования симлинка pnpm createRequire не видит транзитивные
 * пакеты) и при расхождении падает с шагом починки, а не молча.
 *
 * Чистое ядро (generatorVersion, evaluateVersions, evaluateDrift) отделено от
 * CLI guard-ом invokedDirectly: импорт из тестов не спавнит CLI (как в
 * check-required-tasks.ts). Логика канареечится тестами в tools/test/ (З6),
 * проводка — канарейкой «правка committed файла» в gate-canaries.ts (З5).
 *
 *   pnpm routetree:check       шаг verify (fast) и job static CI
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { withRouteTreeFooter } from '../apps/web/scripts/routes-gen.ts';

/** Успешный или сорванный резолв/чтение версии пакета (вход чистой оценки). */
export type VersionResolution = { ok: true; version: string } | { ok: false; stderr: string };

/** Результат спавна генератора (вход чистой оценки). */
export interface GenerationRun {
  /** tsr завершился с кодом 0; срыв спавна и exit ≠ 0 — одна ветка (З4). */
  ok: boolean;
  stderr: string;
  /** Текст свежесгенерированного файла; null — файла нет при exit 0. */
  output: string | null;
}

/** Версия пакета по его package.json (путь уже realpath). */
function versionOf(packageJsonPath: string): VersionResolution {
  try {
    const pkg: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    if (!isRecord(pkg)) {
      return { ok: false, stderr: `${packageJsonPath}: not an object` };
    }
    return typeof pkg['version'] === 'string'
      ? { ok: true, version: pkg['version'] }
      : { ok: false, stderr: `${packageJsonPath}: no version field` };
  } catch (error) {
    return { ok: false, stderr: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Резолв `name` по цепочке якорей от apps/web/node_modules с разыменованием
 * симлинка pnpm: без realpath createRequire ищет в apps/web/node_modules, где
 * транзитивных пакетов нет. Ошибка резолва — проблема, не пустая версия
 * (fail-closed, З4).
 */
function resolveFrom(
  webNodeModules: string,
  anchors: readonly string[],
  name: string,
): VersionResolution {
  try {
    let requireFromAnchor = createRequire(
      realpathSync(join(webNodeModules, anchors[0] ?? '', 'package.json')),
    );
    for (const hop of anchors.slice(1)) {
      requireFromAnchor = createRequire(
        realpathSync(requireFromAnchor.resolve(`${hop}/package.json`)),
      );
    }
    return versionOf(realpathSync(requireFromAnchor.resolve(`${name}/package.json`)));
  } catch (error) {
    return { ok: false, stderr: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Версии @tanstack/router-generator: vite-чейн (react-start →
 * start-plugin-core → router-generator, ровно как резолвит vite при сборке) и
 * CLI (router-cli → router-generator).
 */
export function generatorVersions(webNodeModules: string): {
  chain: VersionResolution;
  cli: VersionResolution;
} {
  return {
    chain: resolveFrom(
      webNodeModules,
      ['@tanstack/react-start', '@tanstack/start-plugin-core'],
      '@tanstack/router-generator',
    ),
    cli: resolveFrom(webNodeModules, ['@tanstack/router-cli'], '@tanstack/router-generator'),
  };
}

/** Проблемы расхождения версий; сообщение называет шаг починки (З11). */
export function evaluateVersions(chain: VersionResolution, cli: VersionResolution): string[] {
  const problems: string[] = [];
  if (!chain.ok) {
    problems.push(`@tanstack/router-generator не резолвится из чейна react-start: ${chain.stderr}`);
  }
  if (!cli.ok) {
    problems.push(
      `@tanstack/router-generator не резолвится из @tanstack/router-cli: ${cli.stderr} — есть ли зависимость в apps/web (pnpm install)?`,
    );
  }
  if (chain.ok && cli.ok && chain.version !== cli.version) {
    problems.push(
      `версии @tanstack/router-generator разошлись: vite-чейн react-start — ${chain.version}, @tanstack/router-cli — ${cli.version}. ` +
        'Подними пин @tanstack/router-cli в catalog: pnpm-workspace.yaml до генераторной версии react-start ' +
        'и свери футер в apps/web/scripts/routes-gen.ts с новым start-plugin-core — иначе гейт дрейфа даёт ложные срабатывания',
    );
  }
  return problems;
}

/**
 * Проблемы дрейфа: срыв генерации и отсутствие committed-файла — красные, а
 * не зелёная пустота (fail-closed, З4); расхождение байтов — дрейф, починка
 * `pnpm regen`, руками файл не правят (З10).
 */
export function evaluateDrift(committed: string | null, generated: GenerationRun): string[] {
  if (!generated.ok) {
    const reason = generated.stderr.trim().split('\n')[0] || 'unknown error';
    return [`tsr generate failed: ${reason}`];
  }
  if (generated.output === null) {
    return [
      'tsr generate отработал, но не создал файл routeTree — проверь tsr.config.json в temp-каталоге гейта',
    ];
  }
  if (committed === null) {
    return ['apps/web/src/routeTree.gen.ts отсутствует — запусти pnpm regen'];
  }
  const expected = withRouteTreeFooter(generated.output);
  if (expected !== committed) {
    return [
      'apps/web/src/routeTree.gen.ts отличается от свежей генерации — запусти pnpm regen, руками производный файл не правят (З10)',
    ];
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Путь до бинаря tsr из bin-поля package.json router-cli (type-guard, без
 * unsafe assertions — линт). Ошибка чтения/формы — проблема, не пустой путь
 * (fail-closed, З4).
 */
export function cliBinPath(
  webNodeModules: string,
): { ok: true; path: string } | { ok: false; stderr: string } {
  try {
    const packageJsonPath = realpathSync(
      join(webNodeModules, '@tanstack/router-cli', 'package.json'),
    );
    const pkg: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    if (!isRecord(pkg)) {
      return { ok: false, stderr: `${packageJsonPath}: not an object` };
    }
    const bin = pkg['bin'];
    if (!isRecord(bin) || typeof bin['tsr'] !== 'string') {
      return { ok: false, stderr: `${packageJsonPath}: no bin.tsr` };
    }
    return { ok: true, path: join(packageJsonPath, '..', bin['tsr']) };
  } catch (error) {
    return { ok: false, stderr: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Спавн tsr generate в зеркальном temp-layout: импорты маршрутов генератор
 * считает относительно расположения generatedRouteTree, поэтому дерево
 * генерируется в <temp>/src/routeTree.gen.ts, а routesDirectory — симлинк на
 * реальные src/routes (<temp>/src/routes). CLI опций не принимает, конфиг —
 * tsr.config.json из cwd; committed-файл при проверке не трогается.
 */
function runTsrGenerate(cliEntry: string, tempRoot: string, generatedPath: string): GenerationRun {
  const result = spawnSync(process.execPath, [cliEntry, 'generate'], {
    cwd: tempRoot,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.error !== undefined) {
    return { ok: false, stderr: String(result.error), output: null };
  }
  const output = existsSync(generatedPath) ? readFileSync(generatedPath, 'utf8') : null;
  return {
    ok: result.status === 0,
    stderr: result.stderr ?? '',
    output,
  };
}

// --- CLI ---------------------------------------------------------------------------

const repoRootFromHere = fileURLToPath(new URL('..', import.meta.url));
const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  const webNodeModules = join(repoRootFromHere, 'apps', 'web', 'node_modules');
  const webRoot = join(repoRootFromHere, 'apps', 'web');

  // Версии до генерации: расхождение красит сразу, генерация не тратится.
  const { chain, cli } = generatorVersions(webNodeModules);
  const versionProblems = evaluateVersions(chain, cli);

  let driftProblems: string[] = [];
  let resolvedCliEntry = '';
  if (versionProblems.length === 0 && chain.ok && cli.ok) {
    const tempDir = mkdtempSync(join(tmpdir(), 'routetree-drift-'));
    try {
      // Зеркальный layout src/: относительные импорты маршрутов ('./routes/…')
      // совпадают с committed-файлом (расположение generatedRouteTree влияет на
      // спекификаторы импортов — без зеркала они уезжают в абсолют).
      mkdirSync(join(tempDir, 'src'));
      symlinkSync(join(webRoot, 'src', 'routes'), join(tempDir, 'src', 'routes'), 'dir');
      const tempTreePath = join(tempDir, 'src', 'routeTree.gen.ts');
      writeFileSync(
        join(tempDir, 'tsr.config.json'),
        JSON.stringify({
          routesDirectory: join(tempDir, 'src', 'routes'),
          generatedRouteTree: tempTreePath,
        }),
      );
      const bin = cliBinPath(webNodeModules);
      if (!bin.ok || !existsSync(bin.path)) {
        driftProblems = [
          `bin tsr @tanstack/router-cli не найден (${bin.ok ? bin.path : bin.stderr}) — проверь установку apps/web`,
        ];
      } else {
        resolvedCliEntry = '@tanstack/router-cli/bin/tsr';
        const committedPath = join(webRoot, 'src', 'routeTree.gen.ts');
        const committed = existsSync(committedPath) ? readFileSync(committedPath, 'utf8') : null;
        driftProblems = evaluateDrift(committed, runTsrGenerate(bin.path, tempDir, tempTreePath));
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  const problems = [...versionProblems, ...driftProblems];
  if (problems.length > 0) {
    console.error('routetree: committed routeTree.gen.ts разошёлся с генератором (b7.1)');
    console.error(problems.map((problem) => `- ${problem}`).join('\n'));
    process.exit(1);
  }
  const versionSuffix = chain.ok && cli.ok ? `@${chain.version} == @${cli.version}` : '';
  console.log(
    `routetree: ok — routeTree.gen.ts соответствует генератору ${versionSuffix} (${resolvedCliEntry})`,
  );
}
