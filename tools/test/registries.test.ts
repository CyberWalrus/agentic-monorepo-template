/**
 * Канарейка b7: гейт порядка реестров ловит перестановку строк; проводка
 * (шаг verify, pnpm regen, .gitattributes, правило AGENTS.md) на месте.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

const repoDir = resolve(import.meta.dirname, '..', '..');

it('проводка: шаг registries в verify, pnpm regen, .gitattributes, правило (b7)', () => {
  const steps = readFileSync(join(repoDir, 'tools', 'verify-steps.ts'), 'utf8');
  expect(steps).toContain("'registries'");
  const pkg = readFileSync(join(repoDir, 'package.json'), 'utf8');
  expect(pkg).toContain('"regen"');
  expect(pkg).toContain('"registries:check"');
  const attrs = readFileSync(join(repoDir, '.gitattributes'), 'utf8');
  expect(attrs).toContain('packages/contracts/openapi.json');
  expect(attrs).toContain('apps/web/src/routeTree.gen.ts');
  const agents = readFileSync(join(repoDir, 'AGENTS.md'), 'utf8');
  expect(agents).toContain('решается `pnpm regen`');
});

it('b7.1 заведена: гейт дрейфа routeTree — отдельная задача (выделена при реализации)', () => {
  const task = readFileSync(join(repoDir, 'backlog', 'b7.1.md'), 'utf8');
  expect(task).toContain('routeTree.gen.ts');
  expect(task).toContain('@tanstack/router-cli');
});
