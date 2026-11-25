/**
 * Тесты гейта пинов действий (e76, tools/check-action-pins.ts).
 *
 * Ядро чистое: строки и файлы подаются фикстурами, дерева и сети не нужно.
 * Проводка проверяется инвариантами по образцу tools/test/check-required-tasks.
 * test.ts (раздел «проводка»); якорь Renovate-правила обновления сканера — тем же
 * регексом, что лежит в .github/renovate.json. Один интеграционный кейс спавнит
 * чекер на реальном дереве и сверяет число пинов с независимым подсчётом.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SCANNER_PIN,
  checkUsesLine,
  evaluateTree,
  listPinFiles,
  scannerVersion,
} from '../check-action-pins.ts';
import { fast } from '../verify-steps.ts';

const repoDir = resolve(import.meta.dirname, '..', '..');
const checker = join(repoDir, 'tools', 'check-action-pins.ts');
const SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';
const pin = (suffix: string): string => `      - uses: actions/checkout@${SHA}${suffix}`;
const problem = (line: string): string | undefined => checkUsesLine(line).problem;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson(...path: string[]): unknown {
  return JSON.parse(readFileSync(join(repoDir, ...path), 'utf8'));
}

/** Шаг zizmor из security.yml в миниатюре; version — строка входа в with:. */
const ZIZMOR_STEP = [
  '  zizmor:',
  '    steps:',
  `      - uses: actions/checkout@${SHA} # v7.0.1`,
  '      - uses: zizmorcore/zizmor-action@45d7276c9ca790aabd705e31ca99c6185c3e76dd # v0.8.1',
  '        with:',
  '          advanced-security: false',
].join('\n');
const withVersion = (version: string): string => `${ZIZMOR_STEP}\n          version: ${version}\n`;
const scannerFile = { path: SCANNER_PIN.file, text: withVersion('v1.32.0') };

describe('формат комментария версии действия', () => {
  it('тег релиза полной версии — зелёный, строка считается пином', () => {
    expect(checkUsesLine(pin(' # v7.0.1'))).toEqual({ pinned: true });
    expect(checkUsesLine(pin(' # 7.0.1'))).toEqual({ pinned: true });
    expect(checkUsesLine(pin(' # v1.0.0-rc.1'))).toEqual({ pinned: true });
  });

  it('мажорная версия (# vN) — красная: такой тег переезжает на каждый релиз', () => {
    const verdict = problem(pin(' # v7'));
    expect(verdict).toContain('тег релиза не полной версии');
    expect(verdict).toContain('«v7»');
    expect(checkUsesLine(pin(' # v7')).pinned).toBe(false);
  });

  it('мажорная.минорная, ветка, лишние слова в комментарии — красные', () => {
    expect(problem(pin(' # v7.0'))).toContain('тег релиза не полной версии');
    expect(problem(pin(' # main'))).toContain('тег релиза не полной версии');
    expect(problem(pin(' # latest'))).toContain('тег релиза не полной версии');
    expect(problem(pin(' # v7.0.1 от 24.11'))).toContain('тег релиза не полной версии');
  });

  it('пин по SHA без комментария — красный', () => {
    expect(problem(pin(''))).toContain('нет комментария с тегом релиза');
    expect(problem(pin('   '))).toContain('нет комментария с тегом релиза');
  });

  it('действие не по SHA — красный: пин по тегу или ветке', () => {
    expect(problem('      - uses: actions/checkout@v7')).toContain('пин не по SHA');
    expect(problem('      - uses: actions/checkout@main')).toContain('пин не по SHA');
    expect(problem('      - uses: actions/checkout@3d3c42e5 # v7.0.1')).toContain('пин не по SHA');
  });

  it('локальное действие без пина — зелёное и не пин (обе формы шаблона)', () => {
    // В workflow шаблона локальный экшен записан `$/…` — резолвится из базовой
    // ветки (ADR 0002, e28); запись `./…` — стандартная форма GitHub Actions.
    expect(checkUsesLine('      - uses: $/.github/actions/setup')).toEqual({ pinned: false });
    expect(checkUsesLine('      - uses: ./.github/actions/setup')).toEqual({ pinned: false });
    expect(checkUsesLine('      - uses: $/.github/actions/setup # общий setup')).toEqual({
      pinned: false,
    });
  });

  it('docker:// — вне соглашения', () => {
    expect(checkUsesLine('      - uses: docker://alpine:3.8')).toEqual({ pinned: false });
  });

  it('действие с подпутьем и значение в кавычках читаются как обычные', () => {
    expect(checkUsesLine(`      - uses: github/codeql-action/init@${SHA} # v3.39.4`)).toEqual({
      pinned: true,
    });
    expect(checkUsesLine(`      - uses: "actions/checkout@${SHA}" # v7.0.1`)).toEqual({
      pinned: true,
    });
  });

  it('комментарий слипся со ссылкой — красный: в YAML такой # — часть значения', () => {
    expect(problem(pin('#v7.0.1'))).toContain('нужен пробел');
  });

  it('неразборная форма — красная, а не пропуск (fail-closed, З4)', () => {
    expect(problem('      - uses: actions/checkout')).toContain('не разобрано');
    expect(problem('      - uses:')).toContain('пустое значение uses');
  });

  it('uses вне блок-маппинга (flow-запись) — красный: форму чекер не читает', () => {
    const flow = `      - { uses: actions/checkout@${SHA}, with: { a: b } } # v7.0.1`;
    expect(problem(flow)).toContain('вне блок-маппинга');
    expect(problem(`      - {'uses': actions/checkout@${SHA}}`)).toContain('вне блок-маппинга');
  });

  it('закомментированная строка и uses: в тексте команды — не шаг', () => {
    expect(checkUsesLine(`      # - uses: actions/checkout@${SHA} # v7`)).toEqual({
      pinned: false,
    });
    expect(checkUsesLine('      - run: echo "uses: $X"')).toEqual({ pinned: false });
    expect(checkUsesLine('        run: pnpm lint # uses: tools/x')).toEqual({ pinned: false });
    expect(checkUsesLine('')).toEqual({ pinned: false });
  });
});

describe('версия сканера zizmor', () => {
  it('точная версия — значение снято (с v и без)', () => {
    expect(scannerVersion(withVersion('v1.32.0'))).toEqual({ version: 'v1.32.0' });
    expect(scannerVersion(withVersion('1.32.0'))).toEqual({ version: '1.32.0' });
  });

  it('комментарий и кавычки у значения не мешают', () => {
    expect(scannerVersion(withVersion('v1.32.0 # релиз 02.11'))).toEqual({ version: 'v1.32.0' });
    expect(scannerVersion(withVersion("'1.32.0'"))).toEqual({ version: '1.32.0' });
  });

  it('latest / prerelease / пусто — красные: версию выбирает обёртка', () => {
    for (const version of ['latest', 'prerelease', '']) {
      expect([version, scannerVersion(withVersion(version)).problem]).toEqual([
        version,
        expect.stringContaining('ожидалась точная версия релиза'),
      ]);
    }
  });

  it('входа нет — красный', () => {
    expect(scannerVersion(ZIZMOR_STEP).problem).toContain('нет входа version');
  });

  it('шага сканера нет в файле — красный: якорь правила умер (fail-closed, З4)', () => {
    const text = `jobs:\n  a:\n    steps:\n${pin(' # v7.0.1')}\n`;
    expect(scannerVersion(text).problem).toContain('нет шага zizmorcore/zizmor-action');
  });

  it('version соседнего шага не засчитывается', () => {
    const text = `${ZIZMOR_STEP}\n      - uses: other/action@${SHA} # v1.0.0\n        with:\n          version: v9.9.9\n`;
    expect(scannerVersion(text).problem).toContain('нет входа version');
  });

  it('step с with: в flow-записи не читается — красный, а не зелёный', () => {
    const text = [
      'jobs:',
      '  a:',
      '    steps:',
      `      - uses: zizmorcore/zizmor-action@45d7276c9ca790aabd705e31ca99c6185c3e76dd # v0.8.1`,
      '        with: { version: v1.32.0 }',
    ].join('\n');
    expect(scannerVersion(text).problem).toContain('нет входа version');
  });
});

describe('evaluateTree: дерево целиком (fail-closed)', () => {
  const ci = {
    path: '.github/workflows/ci.yml',
    text: `${pin(' # v7.0.1')}\n      - uses: ./.github/actions/setup\n`,
  };

  it('зелёное дерево: без проблем, пины посчитаны, версия сканера снята', () => {
    expect(evaluateTree([ci, scannerFile])).toEqual({
      problems: [],
      pinned: 3,
      scanner: 'v1.32.0',
    });
  });

  it('проблема названа файлом и строкой (1-based), несколько — по порядку файлов', () => {
    const broken = {
      path: ci.path,
      text: `jobs:\n${pin(' # v7')}\n      - uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6\n`,
    };
    expect(evaluateTree([broken, scannerFile]).problems).toEqual([
      `${ci.path}:2: тег релиза не полной версии: «v7» — нужен \`# vX.Y.Z\`, а не \`# vN\``,
      `${ci.path}:3: тег релиза не полной версии: «v6» — нужен \`# vX.Y.Z\`, а не \`# vN\``,
    ]);
  });

  it('нет YAML-файлов, нет ни одной uses:, нет файла сканера — красные', () => {
    // Пустое дерево: «нет файлов» и «нет файла сканера» — две проблемы, а не три
    // (слепоту к uses: без файлов не дублируют).
    const empty = evaluateTree([]).problems;
    expect(empty).toHaveLength(2);
    expect(empty.join('\n')).toContain('нет YAML-файлов');
    const configOnly = evaluateTree([{ path: '.github/zizmor.yml', text: 'rules: {}\n' }]);
    expect(configOnly.problems).toHaveLength(2);
    expect(configOnly.problems.join('\n')).toContain('чекер слеп');
    expect(configOnly.problems.join('\n')).toContain('потеряло носителя');
    expect(evaluateTree([ci]).problems).toEqual([
      expect.stringContaining('правило версии сканера потеряло носителя'),
    ]);
  });

  it('CRLF не мешает', () => {
    const crlf = { path: ci.path, text: ci.text.replaceAll('\n', '\r\n') };
    expect(evaluateTree([crlf, scannerFile])).toEqual({
      problems: [],
      pinned: 3,
      scanner: 'v1.32.0',
    });
  });
});

describe('проводка гейта action-pins', () => {
  it('verify-steps содержит шаг action-pins в fast-волне', () => {
    expect(fast.map((step) => step.name)).toContain('action-pins');
    const step = fast.find((item) => item.name === 'action-pins');
    expect(step?.command).toBe('pnpm');
    expect(step?.args).toEqual(['action-pins:check']);
  });

  it('package.json ведёт шаг к гейту', () => {
    const pkg = readJson('package.json');
    const scripts = isRecord(pkg) ? pkg['scripts'] : undefined;
    expect(isRecord(scripts) ? scripts['action-pins:check'] : undefined).toBe(
      'node tools/check-action-pins.ts',
    );
  });

  it('CI исполняет шаг в job static, а static входит в needs у gate', () => {
    const ci = readFileSync(join(repoDir, '.github/workflows/ci.yml'), 'utf8');
    const run = ci.indexOf('pnpm action-pins:check');
    expect(run).toBeGreaterThan(ci.indexOf('\n  static:'));
    expect(run).toBeLessThan(ci.indexOf('\n  unit:'));
    expect(ci).toMatch(/needs: \[static, unit, mutation, e2e, visual, perf\]/);
  });

  it('бюджет шага в verify-budgets.json', () => {
    const budgets = readJson('verify-budgets.json');
    const fastBudgets = isRecord(budgets) ? budgets['fast'] : undefined;
    expect(isRecord(fastBudgets) ? fastBudgets['action-pins'] : undefined).toBeTypeOf('number');
  });

  it('чекер в deny protected-paths.json и в denyWrite settings.json (пара З10)', () => {
    const paths = readJson('tools', 'protected-paths.json');
    const deny = isRecord(paths) && Array.isArray(paths['deny']) ? paths['deny'] : [];
    expect(deny).toContain('tools/check-action-pins.ts');
    const settings = readFileSync(join(repoDir, '.claude/settings.json'), 'utf8');
    expect(settings).toContain('"tools/check-action-pins.ts"');
  });

  it('чекер в KNOWN_GATES check-tool-class (fail-closed-якорь, З4)', () => {
    // tools/check-tool-class.ts: deny-запись внутри tools/ вне KNOWN_GATES красит
    // шаг tool-class — список обязан содержать новый файл.
    const source = readFileSync(join(repoDir, 'tools/check-tool-class.ts'), 'utf8');
    expect(source).toContain("'tools/check-action-pins.ts'");
  });

  it('оба правила гейта заканареечены (З6): формат комментария и версия сканера', () => {
    const source = readFileSync(join(repoDir, 'tools/gate-canaries.ts'), 'utf8');
    expect(source.match(/steps:\s*'action-pins'/g)).toHaveLength(2);
    expect(source).toMatch(/expect: \/тег релиза не полной версии\//);
    expect(source).toMatch(/expect: \/ожидалась точная версия релиза\//);
  });
});

describe('путь обновления версии сканера (Renovate)', () => {
  it('regex-правило renovate.json матчит security.yml и снимает ту же версию', () => {
    const config = readJson('.github', 'renovate.json');
    const managers = isRecord(config) ? config['customManagers'] : undefined;
    const rule = (Array.isArray(managers) ? managers : []).find(
      (item) => isRecord(item) && item['depNameTemplate'] === 'zizmorcore/zizmor',
    );
    const patterns = isRecord(rule) ? rule['matchStrings'] : undefined;
    const pattern = Array.isArray(patterns) ? patterns[0] : undefined;
    expect(pattern).toBeTypeOf('string');
    const workflow = readFileSync(join(repoDir, SCANNER_PIN.file), 'utf8');
    const match = typeof pattern === 'string' ? new RegExp(pattern, 'g').exec(workflow) : null;
    expect(match?.groups?.['currentValue']).toBe(scannerVersion(workflow).version);
    expect(match?.groups?.['currentValue']).toMatch(/^v\d+\.\d+\.\d+$/);
  });
});

describe('интеграция: чекер на реальном дереве', () => {
  it('exit 0; число пинов совпадает с независимым подсчётом', () => {
    const result = spawnSync(process.execPath, [checker], { encoding: 'utf8', timeout: 60_000 });
    if (result.error !== undefined) {
      throw result.error;
    }
    const output = `${result.stdout}${result.stderr}`;
    if (result.status !== 0) {
      throw new Error(`чекер красный на текущем дереве:\n${output}`);
    }
    expect(output).toContain('action pins: ok');
    // Независимый подсчёт: те же строки другим регулярным выражением по всем
    // YAML-файлам .github — чекер не пропустил ни одну строку uses: …@<40 hex>.
    const expected = listPinFiles(repoDir)
      .map((file) => (file.text.match(/^\s*(?:-\s+)?uses:\s*\S+@[0-9a-f]{40}\b/gm) ?? []).length)
      .reduce((sum, count) => sum + count, 0);
    expect(expected).toBeGreaterThan(10);
    expect(output).toContain(`SHA-пинов: ${expected}`);
  });
});
