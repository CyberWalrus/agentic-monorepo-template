/**
 * Гейт визуальных базлайнов (З4, A8):
 * 1) assertVisualRunAllowed — запуск visual-проекта вне Linux-образа бросает,
 *    ALLOW_HOST_SCREENSHOTS — задокументированный лаз; без «visual» в argv — ок.
 * 2) snapshotsUpdateMode — запись базлайнов только при VISUAL_UPDATE=1.
 * 3) Wiring: проверка стоит в конфиге Playwright до побочных эффектов, а инлайн-
 *    проверка конфига Vitest UI (пакет не может импортировать tools/) жива.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertVisualRunAllowed,
  HOST_SCREENSHOTS_MESSAGE,
  snapshotsUpdateMode,
} from '../visual-guard.ts';

const repoDir = resolve(import.meta.dirname, '..', '..');

describe('assertVisualRunAllowed', () => {
  it('visual-проект на macOS-хосте бросает с объяснением', () => {
    expect(() =>
      assertVisualRunAllowed({
        argv: ['playwright', 'test', '--project=visual'],
        platform: 'darwin',
        allowEnv: undefined,
      }),
    ).toThrow(/Playwright Docker image/);
  });

  it('прямой запуск *.visual.ts на хосте тоже бросает (эвристика argv)', () => {
    expect(() =>
      assertVisualRunAllowed({
        argv: ['playwright', 'test', 'features/tasks.visual.ts'],
        platform: 'darwin',
        allowEnv: undefined,
      }),
    ).toThrow(HOST_SCREENSHOTS_MESSAGE);
  });

  it('в Linux-образе — ок', () => {
    expect(() =>
      assertVisualRunAllowed({
        argv: ['playwright', 'test', '--project=visual'],
        platform: 'linux',
        allowEnv: undefined,
      }),
    ).not.toThrow();
  });

  it('ALLOW_HOST_SCREENSHOTS открывает лаз (паритет с Vitest-конфигом)', () => {
    expect(() =>
      assertVisualRunAllowed({
        argv: ['playwright', 'test', '--project=visual'],
        platform: 'darwin',
        allowEnv: '1',
      }),
    ).not.toThrow();
  });

  it('пустое значение лаза не открывает (паритет с `!env` в Vitest)', () => {
    expect(() =>
      assertVisualRunAllowed({
        argv: ['playwright', 'test', '--project=visual'],
        platform: 'darwin',
        allowEnv: '',
      }),
    ).toThrow(/Playwright Docker image/);
  });

  it('обычный функциональный прогон на хосте не задевается', () => {
    expect(() =>
      assertVisualRunAllowed({
        argv: ['playwright', 'test', '--project=functional'],
        platform: 'darwin',
        allowEnv: undefined,
      }),
    ).not.toThrow();
  });
});

describe('snapshotsUpdateMode', () => {
  const table: Array<[Record<string, string>, 'all' | 'none']> = [
    [{}, 'none'],
    [{ VISUAL_UPDATE: '1' }, 'all'],
    [{ VISUAL_UPDATE: '0' }, 'none'],
    [{ VISUAL_UPDATE: 'true' }, 'none'],
    [{ VISUAL_UPDATE: '' }, 'none'],
  ];
  for (const [env, expected] of table) {
    it(`VISUAL_UPDATE=${JSON.stringify(env['VISUAL_UPDATE'] ?? null)} → ${expected}`, () => {
      expect(snapshotsUpdateMode(env)).toBe(expected);
    });
  }
});

describe('wiring: правила живы в конфигах', () => {
  it('Playwright-конфиг вызывает guard до побочных эффектов', () => {
    const source = readFileSync(resolve(repoDir, 'e2e', 'playwright.config.ts'), 'utf8');
    expect(source).toContain("from '../tools/visual-guard.ts'");
    // Вызов стоит выше импорта ports.ts-потребителей: guard до resolvePorts,
    // который пишет reports/ports.json, и до записи instance-token.
    const guardCall = source.indexOf('assertVisualRunAllowed({');
    const portsCall = source.indexOf('await resolvePorts(');
    expect(guardCall).toBeGreaterThan(-1);
    expect(portsCall).toBeGreaterThan(guardCall);
    // Запись базлайнов — не по флагу CI, а по VISUAL_UPDATE.
    expect(source).toContain('snapshotsUpdateMode(process.env)');
    expect(source).not.toMatch(/updateSnapshots:\s*CI\s*\?/);
  });

  it('инлайн-проверка Vitest-конфига UI жива (пакет не импортирует tools)', () => {
    const source = readFileSync(resolve(repoDir, 'packages', 'ui', 'vitest.config.ts'), 'utf8');
    expect(source).toContain("process.platform !== 'linux'");
    expect(source).toContain('must run inside the Playwright Docker image');
    expect(source).not.toMatch(/from\s+'.*tools\//);
  });
});
