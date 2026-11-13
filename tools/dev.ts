/**
 * Корневой `pnpm dev` (A5 PR-3): порты выводятся из worktree, окружение
 * собирается здесь — продуктовый код tools не импортирует, приложения читают
 * env. turbo-задача `dev` удалена: turbo не умеет вычислять env, а задачи
 * порождать процессы с ними — работа оркестратора.
 *
 * Токен instance-id (З9): если `e2e/reports/instance-token` уже есть — он
 * переиспользуется и передаётся API (повторное использование dev-сервера
 * прогоном e2e с `REUSE_SERVER=1` станет возможным), иначе создаётся новый.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { apiOrigin, pickPorts } from './ports.ts';

const root = resolve(import.meta.dirname, '..');
const ports = await pickPorts(root);

const tokenFile = resolve(root, 'e2e', 'reports', 'instance-token');
mkdirSync(resolve(tokenFile, '..'), { recursive: true });
if (!existsSync(tokenFile)) {
  writeFileSync(tokenFile, `${randomUUID()}\n`, { mode: 0o600 });
}
const instanceId = readFileSync(tokenFile, 'utf8').trim();

const children: ChildProcess[] = [];
const stop = (signal: NodeJS.Signals): void => {
  for (const child of children) {
    child.kill(signal);
  }
};
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

const api = spawn('pnpm', ['--filter', '@repo/api', 'start'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, PORT: String(ports.api), INSTANCE_ID: instanceId },
});
const web = spawn('pnpm', ['--filter', '@repo/web', 'dev', '--port', String(ports.web)], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, API_URL: apiOrigin(ports) },
});
children.push(api, web);

for (const child of children) {
  child.once('exit', (code) => {
    // Падение одной задачи завершает dev: две задачи — один процесс для человека.
    stop('SIGTERM');
    process.exitCode = code ?? 0;
  });
}
console.warn(`dev: web ${ports.origin}, api ${apiOrigin(ports)} (ports.json: reports/ports.json)`);
