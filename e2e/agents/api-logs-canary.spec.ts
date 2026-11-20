import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { test } from '../fixtures.ts';

const e2eRoot = resolve(import.meta.dirname, '..');

/**
 * Канарейка отчётного контура (C4): намеренно падающий сценарий, чей отчёт
 * обязан содержать вложение с логами API. Проект `agents` не запускается
 * гейтами (default: false в конфиге), поэтому спек живёт здесь и запускается
 * мета-тестом e2e/features/e2e-reporting/api-logs.spec.ts через CLI — сам
 * прогон функционального проекта остаётся зелёным.
 */
test('harness canary: a deliberately failing scenario gets its API logs attached', async ({
  page,
}) => {
  // Маркерный запрос: идентификатор известен заранее, запись с ним обязана
  // дойти до вложения канарейки и только до него (соседние id — мимо).
  const markerId = `canary-${randomUUID()}`;
  await page.goto('/');
  await page.evaluate(async (requestId) => {
    await fetch('/rpc/__canary__', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': requestId },
      body: '{}',
    }).catch(() => undefined);
  }, markerId);
  mkdirSync(resolve(e2eRoot, 'reports'), { recursive: true });
  writeFileSync(resolve(e2eRoot, 'reports', 'canary-marker-id'), `${markerId}\n`);

  throw new Error(
    'Canary fails on purpose (C4): the report of this scenario must contain the api-logs attachment',
  );
});
