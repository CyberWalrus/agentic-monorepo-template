/**
 * Тесты tools/maintenance.ts (b9): файл режима обслуживания по областям читается
 * и валидируется fail-closed — отсутствующий, нечитаемый или битый файл значит
 * «режима нет», защита полная. isPathOpen повторяет семантику touches/
 * protected-paths: literal и `каталог/**`, каталог над файлом покрыт.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { isPathOpen, readMaintenanceSession } from '../maintenance.ts';

const repoDir = resolve(import.meta.dirname, '..', '..');
const root = mkdtempSync(join(tmpdir(), 'maintenance-'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function seed(content: string): void {
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'maintenance.json'), content);
}

beforeEach(() => {
  rmSync(join(root, '.claude'), { recursive: true, force: true });
});

describe('readMaintenanceSession: fail-closed (З4)', () => {
  it('валидный файл → сессия с task и paths', () => {
    seed(JSON.stringify({ task: 'b9', paths: ['tools/verify.ts', 'tools/hooks/**'] }));
    expect(readMaintenanceSession(root)).toEqual({
      task: 'b9',
      paths: ['tools/verify.ts', 'tools/hooks/**'],
    });
  });

  const broken: [string, string][] = [
    ['нет файла', '<missing>'],
    ['не JSON', 'not json'],
    ['строка вместо объекта', '"b9"'],
    ['массив вместо объекта', '["b9"]'],
    ['нет task', JSON.stringify({ paths: ['a/**'] })],
    ['пустой task', JSON.stringify({ task: '', paths: ['a/**'] })],
    ['task не строка', JSON.stringify({ task: 42, paths: ['a/**'] })],
    ['нет paths', JSON.stringify({ task: 'b9' })],
    ['paths не массив', JSON.stringify({ task: 'b9', paths: 'a/**' })],
    ['paths не из строк', JSON.stringify({ task: 'b9', paths: [42] })],
    ['пустой паттерн', JSON.stringify({ task: 'b9', paths: [''] })],
  ];
  for (const [name, content] of broken) {
    it(`${name} → null (защита полная)`, () => {
      if (content !== '<missing>') {
        seed(content);
      }
      expect(readMaintenanceSession(root)).toBeNull();
    });
  }
});

describe('isPathOpen: семантика путей', () => {
  it('нет файла → false', () => {
    expect(isPathOpen(root, 'tools/verify.ts')).toBe(false);
  });

  it('битый файл → false (защита полная)', () => {
    seed('broken');
    expect(isPathOpen(root, 'tools/verify.ts')).toBe(false);
  });

  it('literal-путь совпадает точно', () => {
    seed(JSON.stringify({ task: 'b9', paths: ['tools/verify.ts'] }));
    expect(isPathOpen(root, 'tools/verify.ts')).toBe(true);
    expect(isPathOpen(root, 'tools/verify-steps.ts')).toBe(false);
  });

  it('каталог/** покрывает файлы каталога и подкаталогов', () => {
    seed(JSON.stringify({ task: 'b9', paths: ['tools/hooks/**'] }));
    expect(isPathOpen(root, 'tools/hooks/lib.ts')).toBe(true);
    expect(isPathOpen(root, 'tools/hooks/nested/deep.ts')).toBe(true);
    expect(isPathOpen(root, 'tools/verify.ts')).toBe(false);
  });

  it('literal-каталог детей не покрывает — parity с protectionOf, для детей нужен `dir/**`', () => {
    seed(JSON.stringify({ task: 'b9', paths: ['gates'] }));
    expect(isPathOpen(root, 'gates/keep.json')).toBe(false);
    seed(JSON.stringify({ task: 'b9', paths: ['gates/**'] }));
    expect(isPathOpen(root, 'gates/keep.json')).toBe(true);
  });

  it('самоссылка: паттерн, покрывающий сам файл режима, отвергает сессию (b9-ревью)', () => {
    for (const pattern of ['.claude/maintenance.json', '.claude/**']) {
      seed(JSON.stringify({ task: 'b9', paths: [pattern] }));
      expect(readMaintenanceSession(root), `паттерн ${pattern} — сессия отвергнута`).toBeNull();
      expect(
        isPathOpen(root, 'tools/verify.ts'),
        `паттерн ${pattern} — защита полная, ничего не открыто`,
      ).toBe(false);
    }
    // matchesGlob движка Node: '**' матчит обычные пути, но не dot-пути —
    // сам файл режима он не покрывает, поэтому сессия валидна; это осознанный
    // выбор оператора («открыть всё обычное»), а агент файл режима всё равно
    // не перепишет: dot-путь не матчится и protect-paths не открывает его
    // никогда (guard file !== MAINTENANCE_FILE).
    seed(JSON.stringify({ task: 'b9', paths: ['**'] }));
    expect(readMaintenanceSession(root)).toEqual({ task: 'b9', paths: ['**'] });
    expect(isPathOpen(root, '.claude/maintenance.json')).toBe(false);
  });

  it('без самоссылки сессия валидна: соседние пути в .claude/ открываются', () => {
    seed(JSON.stringify({ task: 'b9', paths: ['.claude/notes.md'] }));
    expect(readMaintenanceSession(root)).not.toBeNull();
    expect(isPathOpen(root, '.claude/notes.md')).toBe(true);
    expect(isPathOpen(root, '.claude/maintenance.json')).toBe(false);
  });

  it('./ и завершающий / нормализуются', () => {
    seed(JSON.stringify({ task: 'b9', paths: ['tools/verify.ts'] }));
    expect(isPathOpen(root, './tools/verify.ts')).toBe(true);
    expect(isPathOpen(root, 'tools/verify.ts/')).toBe(true);
  });
});

function runProtectCli(fixture: string, file: string): { stdout: string; stderr: string } {
  // Зовём КОПИЮ хука в фикстуре: deny-список хук читает относительно своего
  // файла (доверенная база, З2), репозиторная копия видела бы настоящий список.
  const result = spawnSync(process.execPath, [join(fixture, 'tools/hooks/protect-paths.ts')], {
    cwd: fixture,
    input: JSON.stringify({
      session_id: 'test',
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: join(fixture, file), content: 'x' },
      cwd: fixture,
    }),
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: fixture },
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function makeFixture(): string {
  const fixture = mkdtempSync(join(tmpdir(), 'maintenance-hook-'));
  for (const relative of [
    'tools/hooks/lib.ts',
    'tools/hooks/protect-paths.ts',
    'tools/maintenance.ts',
    'tools/protected-paths.ts',
  ]) {
    mkdirSync(join(fixture, relative, '..'), { recursive: true });
    copyFileSync(join(repoDir, relative), join(fixture, relative));
  }
  writeFileSync(
    join(fixture, 'tools', 'protected-paths.json'),
    JSON.stringify({ deny: ['pin.json', '.claude/maintenance.json'], review: [] }),
  );
  writeFileSync(join(fixture, 'pin.json'), '{"keep": true}\n');
  return fixture;
}

describe('protect-paths CLI + режим по областям: проводка хука', () => {
  it('открытый путь (в .claude/maintenance.json) — запись не отклоняется', () => {
    const fixture = makeFixture();
    try {
      mkdirSync(join(fixture, '.claude'), { recursive: true });
      writeFileSync(
        join(fixture, '.claude', 'maintenance.json'),
        JSON.stringify({ task: 'b9', paths: ['pin.json'] }),
      );
      const result = runProtectCli(fixture, 'pin.json');
      expect(result.stdout).not.toContain('"permissionDecision":"deny"');
      expect(result.stderr).toBe('');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('сам файл режима не открывается режимом (b9-ревью): молчаливое расширение прав закрыто', () => {
    const fixture = makeFixture();
    try {
      mkdirSync(join(fixture, '.claude'), { recursive: true });
      writeFileSync(
        join(fixture, '.claude', 'maintenance.json'),
        JSON.stringify({ task: 'b9', paths: ['.claude/maintenance.json'] }),
      );
      // Слой 1: readMaintenanceSession отвергает самопокрывающий паттерн.
      const result = runProtectCli(fixture, '.claude/maintenance.json');
      expect(result.stdout).toContain('"permissionDecision":"deny"');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('файл режима не открыт даже паттерном соседней сессии: guard `file !== MAINTENANCE_FILE`', () => {
    const fixture = makeFixture();
    try {
      mkdirSync(join(fixture, '.claude'), { recursive: true });
      writeFileSync(
        join(fixture, '.claude', 'maintenance.json'),
        JSON.stringify({ task: 'b9', paths: ['pin.json'] }),
      );
      // Сессия валидна (pin.json), но Edit самого файла режима — deny.
      const result = runProtectCli(fixture, '.claude/maintenance.json');
      expect(result.stdout).toContain('"permissionDecision":"deny"');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('без файла режима тот же путь — deny (защита полная)', () => {
    const fixture = makeFixture();
    try {
      const result = runProtectCli(fixture, 'pin.json');
      expect(result.stdout).toContain('"permissionDecision":"deny"');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('путь вне списка открытых — deny, даже при активном режиме', () => {
    const fixture = makeFixture();
    try {
      mkdirSync(join(fixture, '.claude'), { recursive: true });
      writeFileSync(
        join(fixture, '.claude', 'maintenance.json'),
        JSON.stringify({ task: 'b9', paths: ['other.json'] }),
      );
      const result = runProtectCli(fixture, 'pin.json');
      expect(result.stdout).toContain('"permissionDecision":"deny"');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
