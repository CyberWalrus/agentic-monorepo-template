import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { API_URL, expect, test } from '../../fixtures.ts';

const e2eRoot = resolve(import.meta.dirname, '..', '..');

/**
 * Канарейка логов API в отчёте Playwright (C4): запускать намеренно падающий
 * сценарий внутри этого же прогона нельзя, поэтому он живёт отдельным спеком
 * (e2e/agents/api-logs-canary.spec.ts, проект `agents` — не запускается
 * гейтами) и вызывается здесь как подпроцесс. Серверы переиспользуются
 * (REUSE_SERVER=1 — токен этого же прогона), чтобы «соседние» записи шли в
 * буфер ровно того же API-процесса, что и записи канарейки.
 */
test('a failing scenario attaches its own API logs to the Playwright report [AC-1] [AC-2] [AC-3]', async ({
  request,
}) => {
  test.setTimeout(120_000);

  // Соседний тест: маркер напрямую в живой API. Канарейка его не отправляла —
  // в её вложении эта запись появляться не должна (AC: без соседних записей).
  const neighborId = `neighbor-${randomUUID()}`;
  const neighbor = await request.get(`${API_URL}/health`, {
    headers: { 'x-request-id': neighborId },
  });
  expect(neighbor.ok(), 'neighbor marker reached the API').toBe(true);
  expect(neighbor.headers()['x-request-id']).toBe(neighborId);

  // Воркеры Playwright переоценивают playwright.config.ts и перезаписывают
  // instance-token свежим случайным id; гейт «свой сервер» этот прогон уже
  // прошёл, поэтому файлу нельзя верить. Канарейка сверяет /health с токеном
  // из файла — подкладываем ей живое значение сервера этого прогона.
  const healthText = await (await request.get(`${API_URL}/health`)).text();
  expect(healthText, 'health must answer the run instance').toContain('"status":"ok"');
  const liveInstance = /"instance":"([^"]+)"/.exec(healthText)?.[1];
  if (liveInstance === undefined) {
    throw new Error(`health must expose the instance id: ${healthText}`);
  }
  const tokenPath = resolve(e2eRoot, 'reports', 'instance-token');
  mkdirSync(resolve(tokenPath, '..'), { recursive: true });
  writeFileSync(tokenPath, `${liveInstance}\n`, { mode: 0o600 });

  // Свежесть маркера канарейки: файл от прошлого прогона не должен выжить.
  const markerPath = resolve(e2eRoot, 'reports', 'canary-marker-id');
  rmSync(markerPath, { force: true });

  const cli = createRequire(import.meta.url).resolve('@playwright/test/cli');
  const canary = spawnSync(
    process.execPath,
    [
      cli,
      'test',
      'agents/api-logs-canary.spec.ts',
      '--project=agents',
      '--workers=1',
      '--retries=0',
      '--reporter=list',
      // Артефакты канарейки — мимо артефактов основного прогона: старт прогона
      // чистит outputDir, а основной прогон в этот момент ещё идёт.
      `--output=${resolve(e2eRoot, 'test-results-canary')}`,
    ],
    {
      cwd: e2eRoot,
      encoding: 'utf8',
      env: { ...process.env, REUSE_SERVER: '1' },
    },
  );

  // Канарейка обязана упасть — её падение и есть предмет проверки.
  expect(
    canary.status,
    `canary must fail on purpose. stdout:\n${canary.stdout}\nstderr:\n${canary.stderr}`,
  ).not.toBe(0);

  // Красный прогон называет путь к вложению: эта строка фикстуры попадает в
  // stdout, а из него `pnpm verify --json` несёт её в поле output красного шага.
  const attachmentLine = (canary.stdout ?? '')
    .split('\n')
    .find((line) => line.includes('[api-logs] attached: '));
  if (attachmentLine === undefined) {
    throw new Error(
      `red run stdout must name the attachment path. stdout:\n${canary.stdout}\nstderr:\n${canary.stderr}`,
    );
  }
  const attachmentPath = attachmentLine.split('[api-logs] attached: ')[1]?.trim();
  if (attachmentPath === undefined || attachmentPath === '') {
    throw new Error(`attachment path missing in stdout line: ${attachmentLine}`);
  }
  if (!existsSync(attachmentPath)) {
    throw new Error(`attachment file does not exist: ${attachmentPath}`);
  }

  // Вложение непусто и содержит логи именно этого сценария: маркер канарейки
  // доходит, соседний маркер — нет (отбор по идентификаторам, а не по времени).
  const attachment: unknown = JSON.parse(readFileSync(attachmentPath, 'utf8'));
  const markerId = readFileSync(markerPath, 'utf8').trim();
  expect(attachment).toEqual(
    expect.objectContaining({
      records: expect.arrayContaining([expect.objectContaining({ requestId: markerId })]),
    }),
  );
  expect(JSON.stringify(attachment)).not.toContain(neighborId);
});
