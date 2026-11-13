import { afterAll, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  apiOrigin,
  baseFromPath,
  MAX_BASE,
  MIN_BASE,
  pickPorts,
  readPorts,
  resolvePorts,
  webPort,
} from '../ports.ts';

// pickPorts слушает сокеты: под нагрузкой verify дефолтные 5 c на тест тесны.
vi.setConfig({ testTimeout: 30_000 });

const tmpRoots: string[] = [];

afterAll(() => {
  for (const dir of tmpRoots) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'a5-ports-'));
  tmpRoots.push(dir);
  return dir;
}

/** Слушает порт до конца теста: занимает его для кейса «порт занят». */
async function occupy(port: number): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  occupied.push(server);
}

const occupied: Array<{ close: (cb: () => void) => void }> = [];

describe('baseFromPath', () => {
  it('is deterministic and stable for the same path', () => {
    expect(baseFromPath('/repo/a')).toBe(baseFromPath('/repo/a'));
  });

  it('fits the derived range and differs between worktrees', () => {
    for (const root of ['/repo/worktree-a', '/repo/worktree-b', '/repo/worktree-c']) {
      const base = baseFromPath(root);
      expect(base).toBeGreaterThanOrEqual(MIN_BASE);
      expect(base + 1).toBeLessThanOrEqual(MAX_BASE);
    }
    expect(baseFromPath('/repo/worktree-a')).not.toBe(baseFromPath('/repo/worktree-b'));
  });
});

describe('PORT_BASE override', () => {
  it('uses the given base exactly', async () => {
    const root = tmpRoot();
    const ports = await pickPorts(root, 3450);

    expect(ports.web).toBe(3450);
    expect(ports.api).toBe(3451);
  });

  it('reads PORT_BASE from env — the channel CI relies on', async () => {
    const root = tmpRoot();
    process.env['PORT_BASE'] = '3400';
    try {
      const ports = await pickPorts(root);

      expect(ports.web).toBe(3400);
      expect(ports.api).toBe(3401);
    } finally {
      delete process.env['PORT_BASE'];
    }
  });

  it('rejects an invalid PORT_BASE env loudly (fail-closed)', async () => {
    const root = tmpRoot();
    for (const invalid of ['abc', '3299', '3900']) {
      process.env['PORT_BASE'] = invalid;
      try {
        await expect(pickPorts(root)).rejects.toThrow(/PORT_BASE/);
      } finally {
        delete process.env['PORT_BASE'];
      }
    }
  });
});

describe('pickPorts', () => {
  it('derives both ports from the root path', async () => {
    const root = tmpRoot();
    const ports = await pickPorts(root);

    expect(ports.api).toBe(ports.web + 1);
    expect(ports.origin).toBe(`http://127.0.0.1:${ports.web}`);
    expect(apiOrigin(ports)).toBe(`http://127.0.0.1:${ports.api}`);
    expect(webPort(ports)).toBe(ports.web);
  });

  it('shifts away from an occupied port and records the choice', async () => {
    const root = tmpRoot();
    const taken = await pickPorts(root);
    await occupy(taken.api);

    const shifted = await pickPorts(root);

    expect(shifted.api).not.toBe(taken.api);
    expect(shifted.web).toBeGreaterThan(taken.web);
    const recorded: unknown = JSON.parse(readFileSync(join(root, 'reports', 'ports.json'), 'utf8'));
    expect(recorded).toEqual({ base: shifted.web, web: shifted.web, api: shifted.api });
  });

  it('never returns the same port for web and api even after shifts', async () => {
    const root = tmpRoot();
    const first = await pickPorts(root);
    await occupy(first.web);
    await occupy(first.web + 1);
    await occupy(first.web + 2);
    await occupy(first.web + 3);

    const shifted = await pickPorts(root);

    expect(shifted.api).toBe(shifted.web + 1);
    // Инвариант имени теста: сдвиг действительно увёл от всех занятых портов,
    // а не вернул занятую базу (убирание логики сдвига должно красить тест).
    expect(shifted.web).toBeGreaterThan(first.web + 3);
  });
});

describe('readPorts / resolvePorts', () => {
  it('reads the choice recorded by the config instead of re-probing', async () => {
    const root = tmpRoot();
    const picked = await pickPorts(root);
    // Read-first различим от ре-пробинга: занятый записанный порт ре-пробинг
    // сдвинул бы, а read-first обязан вернуть записанный — даже занятый.
    await occupy(picked.web);

    const read = await resolvePorts(root);

    expect(read?.web).toBe(picked.web);
    expect(readPorts(root)?.api).toBe(picked.api);
  });

  it('returns null for missing, broken or inconsistent records', () => {
    const root = tmpRoot();
    expect(readPorts(root)).toBeNull();

    const record = join(root, 'reports', 'ports.json');
    mkdirSync(join(record, '..'), { recursive: true });
    writeFileSync(record, 'not json');
    expect(readPorts(root)).toBeNull();

    writeFileSync(record, JSON.stringify({ web: 3400, api: 3402 }));
    expect(readPorts(root)).toBeNull();

    // Строковые значения — не числа.
    writeFileSync(record, JSON.stringify({ web: '3400', api: '3401' }));
    expect(readPorts(root)).toBeNull();
  });

  it('prefers API_PORT env — the config choice is consistent for the whole run', async () => {
    const root = tmpRoot();
    const picked = await pickPorts(root);
    process.env['API_PORT'] = String(picked.api + 10);
    try {
      // Файл говорит одно (прошлый выбор), env — выбор текущего конфига.
      const resolved = await resolvePorts(root);
      expect(resolved.api).toBe(picked.api + 10);
    } finally {
      delete process.env['API_PORT'];
    }
  });

  it('rejects a garbage API_PORT env naming the variable', async () => {
    process.env['API_PORT'] = 'abc';
    try {
      await expect(resolvePorts(tmpRoot())).rejects.toThrow(/API_PORT/);
    } finally {
      delete process.env['API_PORT'];
    }
  });
});
