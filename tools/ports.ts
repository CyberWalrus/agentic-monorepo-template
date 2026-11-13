/**
 * Порты из worktree (З9, A5, PR-3): два агента в двух worktree больше не делят
 * фиксированные 3000/3001. База выводится детерминированно из абсолютного пути
 * корня (3300–3900, чётная: web = base, api = base+1), `PORT_BASE` — явный
 * override человека/CI (без сдвига). Занятые порты сдвигают базу на +2, выбор
 * записывается в `<root>/reports/ports.json` — расхождение диагностично.
 *
 * Продуктовый код tools не импортирует: приложения получают порты через env
 * (PORT/API_URL) или флаг --port; модуль используют конфиг Playwright,
 * оркестратор `pnpm dev` (tools/dev.ts), фикстуры и global setup e2e.
 *
 * Остаточный риск TOCTOU (принят): probe-then-release не гарантирует бинд при
 * одновременном старте в коллизионном окне — коллизия хеша означает одинаковый
 * путь, поэтому вероятность ≈ 0, а EADDRINUSE отсылает к reports/ports.json.
 */
import { createServer } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const MIN_BASE = 3300;
export const MAX_BASE = 3900;

export interface Ports {
  web: number;
  api: number;
  /** Origin web-сервера: WEB_ORIGIN больше не нужен — CORS удалён (ADR 0005). */
  origin: string;
}

/** Детерминированная база из пути корня: чётная, api = base+1 остаётся в диапазоне. */
export function baseFromPath(root: string): number {
  const path = resolve(root);
  let hash = 5381;
  for (let index = 0; index < path.length; index += 1) {
    hash = ((hash * 33) ^ path.charCodeAt(index)) >>> 0;
  }
  const evenSlots = Math.floor((MAX_BASE - 1 - MIN_BASE) / 2) + 1;
  return MIN_BASE + (hash % evenSlots) * 2;
}

function portTaken(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const probe = createServer();
    probe.once('error', () => resolvePromise(true));
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => resolvePromise(false));
    });
  });
}

/**
 * Порты для корня: `PORT_BASE` задаёт базу точно, иначе база выводится из пути
 * и сдвигается на +2, пока оба порта свободны. Выбор пишется в reports/ports.json.
 */
export async function pickPorts(root: string, portBase?: number): Promise<Ports> {
  const override = portBase ?? numberFromEnv(process.env['PORT_BASE'], 'PORT_BASE');
  let base = override ?? baseFromPath(root);
  if (override === undefined) {
    for (
      let attempt = 0;
      attempt < 50 && ((await portTaken(base)) || (await portTaken(base + 1)));
      attempt += 1
    ) {
      base += 2;
      if (base + 1 > MAX_BASE) {
        base = MIN_BASE;
      }
    }
  }
  const ports: Ports = { web: base, api: base + 1, origin: `http://127.0.0.1:${base}` };
  const recordPath = resolve(root, 'reports', 'ports.json');
  mkdirSync(resolve(recordPath, '..'), { recursive: true });
  writeFileSync(
    recordPath,
    `${JSON.stringify({ base: ports.web, web: ports.web, api: ports.api }, null, 2)}\n`,
  );
  return ports;
}

function numberFromEnv(
  raw: string | undefined,
  name: 'PORT_BASE' | 'API_PORT',
): number | undefined {
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_BASE || value + 1 > MAX_BASE) {
    throw new Error(
      `${name} must be an integer between ${MIN_BASE} and ${MAX_BASE - 1}, got "${raw}"`,
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Порты, уже выбранные в этом worktree (reports/ports.json). Файл — для
 * диагностики, reuse dev-сервера и потребителен вне прогона e2e.
 */
export function readPorts(root: string): Ports | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolve(root, 'reports', 'ports.json'), 'utf8'));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const { web, api } = parsed;
  if (typeof web !== 'number' || typeof api !== 'number' || api !== web + 1) {
    return null;
  }
  return { web, api, origin: `http://127.0.0.1:${web}` };
}

/**
 * Порты для потребителей ВНУТРИ прогона e2e (фикстуры, global setup). Приоритет:
 * 1) env API_PORT — конфиг выставляет выбранный им порт: env консистентен весь
 * прогон, файл мог быть переписан параллельным импортом;
 * 2) файл выбора — для reuse dev-сервера (REUSE_SERVER=1) и ручных запусков;
 * 3) свежий выбор — запуск мимо конфига (последний resort).
 */
export async function resolvePorts(root: string): Promise<Ports> {
  const fromEnv = numberFromEnv(process.env['API_PORT'], 'API_PORT');
  if (fromEnv !== undefined) {
    return { web: fromEnv - 1, api: fromEnv, origin: `http://127.0.0.1:${fromEnv - 1}` };
  }
  return readPorts(root) ?? pickPorts(root);
}

export function webPort(ports: Ports): number {
  return ports.web;
}

/** Origin API по номеру порта — для мест, где порты уже посчитаны (global setup). */
export function apiOriginFor(apiPort: number): string {
  return `http://127.0.0.1:${apiPort}`;
}

export function apiOrigin(ports: Ports): string {
  return apiOriginFor(ports.api);
}

/** CLI-вывод: `node tools/ports.ts --print` (JSON для людей) и `--env` (shell-exports для CI). */
async function print(root: string, format: 'print' | 'env'): Promise<string> {
  // Read-first, как и все потребители: живой dev/прогон уже записал свой выбор —
  // re-probe выдал бы другие порты и молча перезаписал диагностический файл.
  const ports = await resolvePorts(root);
  if (format === 'env') {
    return `export PORT=${ports.api} API_PORT=${ports.api} WEB_PORT=${ports.web} API_URL=${apiOrigin(ports)} WEB_URL=${ports.origin}`;
  }
  return JSON.stringify(ports, null, 2);
}

const isDirectRun =
  process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename ?? '');
if (isDirectRun) {
  const format = process.argv.includes('--env') ? 'env' : 'print';
  const root = resolve(import.meta.dirname, '..');
  console.log(await print(root, format));
}
