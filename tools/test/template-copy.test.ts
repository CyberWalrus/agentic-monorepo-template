/**
 * Логика чекера копии шаблона (d8.3, З6: логика чекеров канареечна здесь,
 * проводка — в gate-canaries.ts): фикстуры «шаблон + копия» в tmp, evil-варианты
 * красят конкретные проверки чекера. Проводка канарейки копии (скрипт canaries,
 * paths-триггер canaries.yml, установка copier из файла версии) проверяется
 * статикой — канарейка копии без copier не запускается из песочницы (З5),
 * её живость здесь и в CI.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  unlinkSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FORBIDDEN_IN_COPY,
  checkTemplateCopy,
  readOwner,
  renderCodeowners,
} from '../check-template-copy.ts';

const repoRoot = resolve(import.meta.dirname, '../..');

const TEMPLATE_OWNER = '@tpl-owner';
const COPY_OWNER = '@copy-owner';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const codeownersText = (owner: string): string =>
  `# Ruleset требует ревью CODEOWNERS.\n*                               ${owner}\n\n/.github/                       ${owner}\n`;
const jinjaText = (): string =>
  `# Ruleset требует ревью CODEOWNERS.\n*                               {{ repo_owner }}\n\n/.github/                       {{ repo_owner }}\n`;

let fixtureRoot: string;
let templateRoot: string;
let copyRoot: string;

function write(relPath: string, content: string): void {
  const full = join(fixtureRoot, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

function makeTemplate(): void {
  write('template/copier.yml', 'project_name:\n  type: str\nrepo_owner:\n  type: str\n');
  write('template/docs/CODEOWNERS', codeownersText(TEMPLATE_OWNER));
  write('template/.github/CODEOWNERS.jinja', jinjaText());
  write('template/.github/rulesets/main.json', '{"name":"main"}\n');
  write('template/.github/rulesets/tags-v.json', '{"name":"tags-v"}\n');
}

function makeCopy(): void {
  write('template/copy/package.json', '{}\n');
  write('template/copy/pnpm-workspace.yaml', 'packages:\n  - apps/*\n');
  write('template/copy/turbo.json', '{}\n');
  write('template/copy/AGENTS.md', '# project\n');
  write(
    'template/copy/.copier-answers.yml',
    '# Правит Copier при copy и update.\n_commit: abc123\n',
  );
  write('template/copy/.github/workflows/ci.yml', 'name: CI\n');
  write('template/copy/.github/CODEOWNERS', codeownersText(COPY_OWNER));
  write('template/copy/.github/rulesets/main.json', '{"name":"main"}\n');
  write('template/copy/.github/rulesets/tags-v.json', '{"name":"tags-v"}\n');
  write('template/copy/apps/api/package.json', '{}\n');
  write('template/copy/apps/web/package.json', '{}\n');
  write('template/copy/packages/contracts/package.json', '{}\n');
  write('template/copy/packages/ui/package.json', '{}\n');
  // Объём: реальная копия — 244 файла (проба d8.2), порог чекера 100.
  for (let index = 0; index < 120; index += 1) {
    write(`template/copy/docs/filler-${index}.md`, `filler ${index}\n`);
  }
}

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'd83-fixture-'));
  templateRoot = join(fixtureRoot, 'template');
  copyRoot = join(fixtureRoot, 'template', 'copy');
  makeTemplate();
  makeCopy();
});

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('шаблонная сторона', () => {
  it('_tasks в copier.yml красит', () => {
    write('template/copier.yml', 'project_name:\n  type: str\n_tasks:\n  - echo evil\n');
    const report = checkTemplateCopy(templateRoot, copyRoot);
    expect(report.ok).toBe(false);
    expect(
      report.failures.some((f) => f.check === 'copier.yml' && f.detail.includes('_tasks')),
    ).toBe(true);
  });

  it('_migrations в copier.yml красит', () => {
    write('template/copier.yml', 'project_name:\n  type: str\n_migrations:\n  1.0.0: echo evil\n');
    const report = checkTemplateCopy(templateRoot, copyRoot);
    expect(report.ok).toBe(false);
    expect(
      report.failures.some((f) => f.check === 'copier.yml' && f.detail.includes('_migrations')),
    ).toBe(true);
  });

  it('рассинхрон пары CODEOWNERS ↔ jinja красит', () => {
    // Лишняя строка в живом CODEOWNERS, которой нет в jinja.
    write(
      'template/docs/CODEOWNERS',
      `${codeownersText(TEMPLATE_OWNER)}/evil/                        ${TEMPLATE_OWNER}\n`,
    );
    const report = checkTemplateCopy(templateRoot, copyRoot);
    expect(report.failures.some((f) => f.check === 'CODEOWNERS')).toBe(true);
  });

  it('владелец из CODEOWNERS не извлекается', () => {
    write('template/docs/CODEOWNERS', 'только комментарии, строки * нет\n');
    const report = checkTemplateCopy(templateRoot, copyRoot);
    expect(report.failures.some((f) => f.check === 'CODEOWNERS')).toBe(true);
  });

  it('readOwner берёт строку * и renderCodeowners подставляет владельца', () => {
    expect(readOwner(codeownersText(TEMPLATE_OWNER))).toBe(TEMPLATE_OWNER);
    expect(renderCodeowners(jinjaText(), TEMPLATE_OWNER)).toBe(codeownersText(TEMPLATE_OWNER));
  });
});

describe('сторона копии', () => {
  it('чистая копия зелёная', () => {
    const report = checkTemplateCopy(templateRoot, copyRoot);
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('пустая копия красит объёмом', () => {
    const empty = join(fixtureRoot, 'empty');
    mkdirSync(empty, { recursive: true });
    const report = checkTemplateCopy(templateRoot, empty);
    expect(report.ok).toBe(false);
    expect(report.failures.some((f) => f.check === 'копия' && f.detail.includes('пуста'))).toBe(
      true,
    );
  });

  it('отсутствие обязательного файла красит', () => {
    unlinkSync(join(copyRoot, 'package.json'));
    const report = checkTemplateCopy(templateRoot, copyRoot);
    expect(report.failures.some((f) => f.detail.includes('package.json'))).toBe(true);
  });

  it('утечка файла разработки красит', () => {
    write('template/copy/docs/roadmap.md', 'roadmap шаблона\n');
    const report = checkTemplateCopy(templateRoot, copyRoot);
    expect(
      report.failures.some((f) => f.check === 'копия' && f.detail.includes('docs/roadmap.md')),
    ).toBe(true);
  });

  it('утечка каталога backlog красит', () => {
    write('template/copy/backlog/evil.md', 'задача шаблона\n');
    const report = checkTemplateCopy(templateRoot, copyRoot);
    expect(report.failures.some((f) => f.check === 'копия' && f.detail.includes('backlog'))).toBe(
      true,
    );
  });

  it('утечка jinja-источника CODEOWNERS красит', () => {
    write('template/copy/.github/CODEOWNERS.jinja', jinjaText());
    const report = checkTemplateCopy(templateRoot, copyRoot);
    expect(report.failures.some((f) => f.detail.includes('CODEOWNERS.jinja'))).toBe(true);
  });

  it('имя владельца шаблона в файле копии красит', () => {
    write('template/copy/apps/api/src/evil.ts', `const owner = '${TEMPLATE_OWNER}';\n`);
    const report = checkTemplateCopy(templateRoot, copyRoot);
    expect(report.failures.some((f) => f.check === 'владелец')).toBe(true);
  });

  it('.copier-answers.yml — whitelist на владельца (_src_path, d8.2)', () => {
    write(
      'template/copy/.copier-answers.yml',
      `_commit: abc123\n_src_path: /home/dev/${TEMPLATE_OWNER}/template\n`,
    );
    const report = checkTemplateCopy(templateRoot, copyRoot);
    expect(report.failures.filter((f) => f.check === 'владелец')).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('владелец в ответах вне строки _src_path красит (whitelist узкий)', () => {
    write(
      'template/copy/.copier-answers.yml',
      `_commit: abc123\n_src_path: /home/dev/template\nrepo_owner: ${TEMPLATE_OWNER}\n`,
    );
    const report = checkTemplateCopy(templateRoot, copyRoot);
    expect(report.failures.some((f) => f.check === 'владелец')).toBe(true);
  });

  it('симлинк в копии красит', () => {
    symlinkSync(join(copyRoot, 'package.json'), join(copyRoot, 'evil-link'));
    const report = checkTemplateCopy(templateRoot, copyRoot);
    expect(report.failures.some((f) => f.detail.includes('симлинк'))).toBe(true);
  });

  it('убранный снимок ruleset красит', () => {
    rmSync(join(copyRoot, '.github/rulesets/tags-v.json'));
    const report = checkTemplateCopy(templateRoot, copyRoot);
    expect(report.failures.some((f) => f.check === 'rulesets' && f.detail.includes('tags-v'))).toBe(
      true,
    );
  });

  it('изменённый снимок ruleset красит', () => {
    write('template/copy/.github/rulesets/main.json', '{"name":"evil"}\n');
    const report = checkTemplateCopy(templateRoot, copyRoot);
    expect(
      report.failures.some((f) => f.check === 'rulesets' && f.detail.includes('main.json')),
    ).toBe(true);
  });

  it('.jinja-снимок ищется в копии под именем без суффикса (copier рендерит)', () => {
    write('template/.github/rulesets/custom.json.jinja', 'owner: {{ repo_owner }}\n');
    write('template/copy/.github/rulesets/custom.json', 'owner: rendered\n');
    let report = checkTemplateCopy(templateRoot, copyRoot);
    expect(report.failures.filter((f) => f.check === 'rulesets')).toEqual([]);
    // Рендер не доехал до копии — красит.
    rmSync(join(copyRoot, '.github/rulesets/custom.json'));
    report = checkTemplateCopy(templateRoot, copyRoot);
    expect(
      report.failures.some((f) => f.check === 'rulesets' && f.detail.includes('custom.json')),
    ).toBe(true);
  });

  it('рендер CODEOWNERS копии расходится с jinja — красит', () => {
    write(
      'template/copy/.github/CODEOWNERS',
      `${codeownersText(COPY_OWNER)}/evil/                        ${COPY_OWNER}\n`,
    );
    const report = checkTemplateCopy(templateRoot, copyRoot);
    expect(report.failures.some((f) => f.check === 'CODEOWNERS')).toBe(true);
  });

  it('ответы без _commit красят', () => {
    write('template/copy/.copier-answers.yml', 'project_name: probe\n');
    const report = checkTemplateCopy(templateRoot, copyRoot);
    expect(report.failures.some((f) => f.check === 'ответы')).toBe(true);
  });
});

describe('проводка канарейки копии', () => {
  it('привязка канарейки копии к скрипту canaries', () => {
    const pkg: unknown = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    if (
      !isRecord(pkg) ||
      !isRecord(pkg['scripts']) ||
      typeof pkg['scripts']['canaries'] !== 'string'
    ) {
      throw new Error('canary anchor not found: package.json scripts.canaries');
    }
    expect(
      pkg['scripts']['canaries'],
      'канарейка копии отвязана: scripts.canaries не запускает tools/run-template-copy-canary.ts',
    ).toContain('node tools/run-template-copy-canary.ts');
    expect(pkg['scripts']['canaries']).toContain('node tools/run-gate-canaries.ts');
  });

  it('canaries.yml триггерится на файлы шаблона', () => {
    const workflow = readFileSync(join(repoRoot, '.github/workflows/canaries.yml'), 'utf8');
    for (const path of [
      'copier.yml',
      '.copier-answers.yml.jinja',
      '.github/rulesets/**',
      'tools/copier-version.txt',
      '.github/CODEOWNERS.jinja',
      'docs/CODEOWNERS',
    ]) {
      expect(
        workflow,
        `канарейка копии не запустится на PR: в paths canaries.yml нет ${path}`,
      ).toContain(path);
    }
  });

  it('дрейф списков: каждый dev-паттерн _exclude покрыт FORBIDDEN_IN_COPY', () => {
    // Тест читает шаблонную пару «copier.yml ↔ чекер»: в копии шаблона
    // copier.yml нет (_exclude), проверять нечего. В шаблоне отсутствие
    // copier.yml красит саму канарейку копии (checkTemplateSide).
    if (!existsSync(join(repoRoot, 'copier.yml'))) {
      return;
    }
    const text = readFileSync(join(repoRoot, 'copier.yml'), 'utf8');
    const section = text.slice(text.indexOf('_exclude:'));
    const entries = [...section.matchAll(/^\s+- '?([^'\n]+)'?$/gm)]
      .map((match) => match[1] ?? '')
      .filter((entry) => entry !== '');
    // Технические дефолты copier (файлы ОС и VCS) — не файлы разработки.
    const technical = new Set(['~*', '*.py[co]', '__pycache__', '.DS_Store', '.git', '.svn']);
    for (const entry of entries) {
      if (technical.has(entry)) {
        continue;
      }
      const normalized = entry.endsWith('/') ? entry.slice(0, -1) : entry;
      expect(
        [...FORBIDDEN_IN_COPY],
        `паттерн _exclude «${entry}» не покрыт FORBIDDEN_IN_COPY — его утечка в копию будет тихой`,
      ).toContain(normalized);
    }
    expect(entries.length).toBeGreaterThan(5);
  });

  it('copier в CI ставится из файла версии (З10)', () => {
    for (const workflow of ['canaries.yml', 'nightly.yml']) {
      const text = readFileSync(join(repoRoot, '.github/workflows', workflow), 'utf8');
      expect(text, `в ${workflow} нет установки copier`).toContain('pipx install');
      expect(text, `в ${workflow} версия copier не из tools/copier-version.txt`).toContain(
        'tools/copier-version.txt',
      );
    }
  });

  it('без copier — громкий skip вне CI и fail-closed в CI (З5)', { timeout: 30_000 }, () => {
    const runner = join(repoRoot, 'tools/run-template-copy-canary.ts');
    const withoutCopier = spawnSync(process.execPath, [runner], {
      encoding: 'utf8',
      cwd: repoRoot,
      env: { ...process.env, PATH: '/usr/bin:/bin', CI: '' },
    });
    expect(withoutCopier.status).toBe(0);
    expect(`${withoutCopier.stdout}${withoutCopier.stderr}`).toContain('SKIPPED');

    const inCI = spawnSync(process.execPath, [runner], {
      encoding: 'utf8',
      cwd: repoRoot,
      env: { ...process.env, PATH: '/usr/bin:/bin', CI: '1' },
    });
    expect(inCI.status).not.toBe(0);
    expect(`${inCI.stdout}${inCI.stderr}`).toContain('FAILED');
  });
});
