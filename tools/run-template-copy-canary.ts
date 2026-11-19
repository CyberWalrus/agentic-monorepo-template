/**
 * Канарейка копии шаблона (d8.3; ADR 0008, «Проверка»): `copier copy` из
 * закоммиченного HEAD (--vcs-ref=HEAD обязателен — без него copier молча
 * создаёт пустую копию и выходит с кодом 0, журнал d8; канарейки проверяют
 * закоммиченное состояние, как и run-gate-canaries), проверка содержимого
 * tools/check-template-copy.ts, затем `pnpm install && pnpm verify` в копии.
 *
 * Гоняют CI (canaries.yml — по изменению copier.yml, .github/rulesets/**,
 * пары CODEOWNERS и tools/copier-version.txt — и nightly) и человек. Из
 * песочницы агента не запускается — copier ставится из PyPI, вне allowlist
 * доменов (ADR 0004, З5-исключение в architecture.md): без copier раннер
 * громко уходит в skip, в CI (CI=true) отсутствие copier красит прогон.
 *
 *   pnpm canaries
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkTemplateCopy } from './check-template-copy.ts';

const repoRoot = resolve(import.meta.dirname, '..');
const pinnedVersion = readFileSync(join(repoRoot, 'tools/copier-version.txt'), 'utf8').trim();

function run(
  command: string[],
  cwd: string,
  timeoutMs = 120_000,
): { status: number | null; output: string } {
  const [file, ...args] = command;
  if (file === undefined) {
    return { status: -1, output: 'empty command' };
  }
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    cwd,
    timeout: timeoutMs,
    env: { ...process.env, TURBO_TELEMETRY_DISABLED: '1' },
  });
  if (result.error !== undefined) {
    return { status: -1, output: String(result.error) };
  }
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** Установленная версия copier или null, если бинарника нет. */
function copierVersion(): string | null {
  const result = run(['copier', '--version'], repoRoot);
  if (result.status !== 0) {
    return null;
  }
  return result.output.trim();
}

class CanaryFailure extends Error {}

const isCI = process.env['CI'] === '1' || process.env['CI'] === 'true';
const foundVersion = copierVersion();
if (foundVersion === null) {
  console.error(
    `SKIPPED: копир (copier) не найден — канарейка копии ставит его из PyPI, вне allowlist ` +
      `доменов песочницы (ADR 0004, З5-исключение). Её гоняют CI (canaries.yml, nightly) и ` +
      `человек: pipx install copier==${pinnedVersion}`,
  );
  // В CI copier ставится шагом workflow: отсутствие — сломанная проводка,
  // а не окружение агента, поэтому fail-closed (З6).
  process.exit(isCI ? 1 : 0);
}
if (!foundVersion.includes(pinnedVersion)) {
  console.error(
    `версия copier (${foundVersion}) расходится с tools/copier-version.txt (${pinnedVersion}) — ` +
      `обновите установку: pipx install copier==${pinnedVersion}`,
  );
  process.exit(1);
}

const copyDir = mkdtempSync(join(tmpdir(), 'd83-copy-'));
let contentOk = false;
try {
  console.log(`copier ${pinnedVersion}: копия из HEAD в ${copyDir}`);
  const copied = run(
    [
      'copier',
      'copy',
      '-q',
      // Копия из закоммиченного состояния: канарейка проверяет HEAD, как и
      // негатив-канарейки run-gate-canaries; локально — сначала commit.
      '--vcs-ref=HEAD',
      '-d',
      'project_name=copy-canary-probe',
      '-d',
      'repo_owner=@copy-canary-owner',
      repoRoot,
      copyDir,
    ],
    repoRoot,
  );
  if (copied.status !== 0) {
    throw new CanaryFailure(`copier copy failed:\n${copied.output.slice(-3000)}`);
  }

  const report = checkTemplateCopy(repoRoot, copyDir);
  for (const failure of report.failures) {
    console.error(`✗ [${failure.check}] ${failure.detail}`);
  }
  contentOk = report.ok;
  if (contentOk) {
    console.log('содержимое копии — ok');
  }

  // Установка и verify в копии: pnpm store общий с чекаутом (в CI прогревается
  // установкой шаблона), порты выводятся из пути копии (З9).
  console.log('pnpm install в копии…');
  const installed = run(['pnpm', 'install'], copyDir, 600_000);
  if (installed.status !== 0) {
    throw new CanaryFailure(`pnpm install в копии failed:\n${installed.output.slice(-3000)}`);
  }
  console.log('pnpm verify в копии…');
  const verified = spawnSync('pnpm', ['verify'], {
    encoding: 'utf8',
    cwd: copyDir,
    timeout: 600_000,
    env: { ...process.env, CI: '1', TURBO_TELEMETRY_DISABLED: '1' },
  });
  const verifyOutput =
    verified.error !== undefined ? String(verified.error) : `${verified.stdout}${verified.stderr}`;
  if (verified.status !== 0) {
    throw new CanaryFailure(`pnpm verify в копии failed:\n${verifyOutput.slice(-3000)}`);
  }
  if (contentOk) {
    console.log(`канарейка копии — ok (copier ${pinnedVersion}, ${copyDir})`);
  }
} finally {
  rmSync(copyDir, { recursive: true, force: true });
}
if (contentOk) {
  console.log('all done');
} else {
  console.error('канарейка копии: содержимое копии красное (детали выше)');
  process.exit(1);
}
