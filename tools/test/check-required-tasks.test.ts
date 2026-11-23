/**
 * Тесты гейта состава workspace (e20, tools/check-required-tasks.ts).
 *
 * Ядро тестируется по фикстурам dry-json (carriersFromGraph/evaluateTask —
 * чистые функции): спавн turbo в юнит-тестах не нужен, синтетические кейсы
 * «пустой workspace» и «носители удалены» краснеют по семантике графа, а не
 * из-за невозможности спавна. Один интеграционный кейс спавнит чекер на
 * реальном workspace (real-spawn кейс один — каждый релий tools/** перепроливает
 * test:hooks, turbo.json //#test:hooks inputs). Проводка проверяется инвариантами
 * по образцу tools/test/check-tool-class.test.ts:242-268.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  REQUIRED_TASKS,
  carriersFromGraph,
  evaluateTask,
  MIN_CARRIERS,
} from '../check-required-tasks.ts';
import { fast } from '../verify-steps.ts';

// Интеграционный кейс спавнит чекер (4 dry-спавна turbo ~1-2s): дефолтных 5s
// мало под параллельной нагрузкой verify (приём test-report.test.ts).
vi.setConfig({ testTimeout: 30_000 });

const repoDir = resolve(import.meta.dirname, '..', '..');
const checker = join(repoDir, 'tools', 'check-required-tasks.ts');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function entry(taskId: string, command: string): Record<string, string> {
  return { taskId, command };
}

/** Сухой прогон задачи по реальному составу workspace на момент гейта (e20). */
function dry(task: string, carriers: string[]): Record<string, unknown> {
  const tasks: Record<string, string>[] = [];
  const packages = [
    '@repo/api',
    '@repo/contracts',
    '@repo/e2e',
    '@repo/preflight',
    '@repo/ui',
    '@repo/web',
  ];
  const ghost = '<NONEXISTENT>';
  for (const pkg of packages) {
    if (carriers.includes(pkg)) {
      tasks.push(entry(`${pkg}#${task}`, `run ${task}`));
    } else {
      // Призрак: глобальное определение turbo.json рисует задачу и пакетам без
      // скрипта — носителем такая запись не считается.
      tasks.push(entry(`${pkg}#${task}`, ghost));
    }
  }
  // transit-зависимости тоже призраки (наблюдение dry-графа mutation: 6 из 12).
  for (const pkg of packages) {
    tasks.push(entry(`${pkg}#transit`, ghost));
  }
  return { tasks };
}

function run(task: string, carriers: string[]): string[] {
  return evaluateTask(task, { ok: true, stdout: JSON.stringify(dry(task, carriers)), stderr: '' })
    .problems;
}

describe('носители обязательных задач в dry-графе', () => {
  it('обязательный список — литерал build/test/e2e/mutation', () => {
    expect(REQUIRED_TASKS).toEqual(['build', 'test', 'e2e', 'mutation']);
  });

  it('у каждой обязательной задачи есть порог MIN_CARRIERS (fail-closed, З4)', () => {
    // Задача без порога красит веткой «нет порога в MIN_CARRIERS»: списки
    // обязаны идти в ногу, иначе гейт мёртв при рождении новой задачи.
    for (const task of REQUIRED_TASKS) {
      expect(MIN_CARRIERS[task], `нет порога MIN_CARRIERS для задачи ${task}`).toBeTypeOf('number');
    }
  });

  it('полный workspace: все задачи с носителями, призраки не считаются', () => {
    // Составы = факт репо на момент b13 = пороги MIN_CARRIERS: ровно минимум —
    // зелёный.
    expect(run('mutation', ['@repo/api', '@repo/contracts', '@repo/web'])).toEqual([]);
    expect(run('e2e', ['@repo/e2e'])).toEqual([]);
    expect(run('build', ['@repo/web'])).toEqual([]);
    expect(
      run('test', ['@repo/api', '@repo/contracts', '@repo/preflight', '@repo/ui', '@repo/web']),
    ).toEqual([]);
  });

  it('носитель удалён при живых остальных — красный с числом ниже минимума (b13)', () => {
    expect(run('mutation', ['@repo/contracts', '@repo/web'])).toEqual([
      'mutation: носителей 2, минимум 3',
    ]);
    expect(run('test', ['@repo/api', '@repo/contracts', '@repo/preflight', '@repo/ui'])).toEqual([
      'test: носителей 4, минимум 5',
    ]);
  });

  it('все носители mutation удалены — «mutation: ни одного пакета»', () => {
    expect(run('mutation', [])).toEqual(['mutation: ни одного пакета']);
  });

  it('призраки <NONEXISTENT> не носители: 3 призрака и 0 скриптов — красный', () => {
    // Явно: entries есть, но все с призрачной командой — гейт красный, а не
    // зелёный по счёту записей графа (e20: @repo/e2e, @repo/preflight, @repo/ui).
    expect(run('mutation', [])).toEqual(['mutation: ни одного пакета']);
    const { carriers } = carriersFromGraph(dry('mutation', []), 'mutation');
    expect(carriers).toEqual([]);
  });

  it('записи с пустой командой тоже не носители', () => {
    const graph = { tasks: [entry('@repo/api#mutation', '')] };
    expect(carriersFromGraph(graph, 'mutation')).toEqual({ carriers: [], problems: [] });
    expect(
      evaluateTask('mutation', { ok: true, stdout: JSON.stringify(graph), stderr: '' }).problems,
    ).toEqual(['mutation: ни одного пакета']);
  });

  it('пустой workspace — красный по каждой задаче', () => {
    for (const task of REQUIRED_TASKS) {
      expect(evaluateTask(task, { ok: true, stdout: '{"tasks":[]}', stderr: '' }).problems).toEqual(
        [`${task}: ни одного пакета`],
      );
    }
  });

  it('битый граф — красный, а не зелёный пустотой (fail-closed, З4)', () => {
    expect(carriersFromGraph(null, 'mutation').problems).toEqual([
      'turbo dry-json (mutation): no "tasks" array',
    ]);
    expect(carriersFromGraph({ tasks: [{ command: 'stryker run' }] }, 'mutation').problems).toEqual(
      ['turbo dry-json (mutation): task without taskId'],
    );
    expect(
      evaluateTask('mutation', { ok: true, stdout: 'not json', stderr: '' }).problems[0],
    ).toContain('not valid JSON');
  });

  it('срыв dry-спавна и опечатка в списке — одна ветка: turbo exit ≠ 0 (З4)', () => {
    // Опечатка в имени задачи: turbo отвечает exit 1 «Could not find task» —
    // та же ветка, что и срыв спавна; чекер красный, не зелёный.
    const typo = evaluateTask('mutaton', {
      ok: false,
      stdout: '',
      stderr: 'Could not find task `mutaton`',
    });
    expect(typo.problems[0]).toContain('turbo dry-json failed for mutaton');
    expect(typo.problems[0]).toContain('Could not find task');
    const failed = evaluateTask('mutation', { ok: false, stdout: '', stderr: '' });
    expect(failed.problems[0]).toContain('turbo dry-json failed for mutation');
  });
});

describe('проводка гейта required-tasks', () => {
  it('verify-steps содержит шаг required-tasks в fast-волне', () => {
    expect(fast.map((step) => step.name)).toContain('required-tasks');
    const step = fast.find((item) => item.name === 'required-tasks');
    expect(step?.command).toBe('pnpm');
    expect(step?.args).toEqual(['required-tasks:check']);
  });

  it('package.json ведёт шаг к гейту', () => {
    const pkg: unknown = JSON.parse(readFileSync(join(repoDir, 'package.json'), 'utf8'));
    const scripts = isRecord(pkg) ? pkg['scripts'] : undefined;
    expect(isRecord(scripts) ? scripts['required-tasks:check'] : undefined).toBe(
      'node tools/check-required-tasks.ts',
    );
  });

  it('CI исполняет шаг в job static', () => {
    const ci = readFileSync(join(repoDir, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toMatch(/pnpm required-tasks:check/);
  });

  it('бюджет шага в verify-budgets.json', () => {
    const budgets: unknown = JSON.parse(readFileSync(join(repoDir, 'verify-budgets.json'), 'utf8'));
    const fastDict = isRecord(budgets) ? budgets['fast'] : undefined;
    expect(isRecord(fastDict) ? fastDict['required-tasks'] : undefined).toBeTypeOf('number');
  });

  it('чекер в deny protected-paths.json (ADR 0014)', () => {
    const paths: unknown = JSON.parse(
      readFileSync(join(repoDir, 'tools', 'protected-paths.json'), 'utf8'),
    );
    const deny = isRecord(paths) && Array.isArray(paths['deny']) ? paths['deny'] : [];
    expect(deny).toContain('tools/check-required-tasks.ts');
  });

  it('чекер в KNOWN_GATES check-tool-class (fail-closed-якорь, З4)', () => {
    // tools/check-tool-class.ts:937-947: deny-запись внутри tools/ вне
    // KNOWN_GATES красит шаг tool-class — список обязан содержать новый файл.
    const source = readFileSync(join(repoDir, 'tools', 'check-tool-class.ts'), 'utf8');
    expect(source).toContain("'tools/check-required-tasks.ts'");
  });

  it('канарейка красит шаг required-tasks (З5)', () => {
    const source = readFileSync(join(repoDir, 'tools', 'gate-canaries.ts'), 'utf8');
    expect(source).toMatch(/steps:\s*'required-tasks'/);
    expect(source).toMatch(/mutation: ни одного пакета/);
  });
});

describe('интеграция: чекер на реальном workspace', () => {
  it('все четыре задачи с достаточными носителями — exit 0, порог = факту (b13)', () => {
    const result = spawnSync(process.execPath, [checker], { encoding: 'utf8', timeout: 60_000 });
    if (result.error !== undefined) {
      throw result.error;
    }
    expect(result.status).toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain('required tasks: ok');
    for (const task of REQUIRED_TASKS) {
      expect(output).toContain(`${task}:`);
    }
    // Порог = состав репо (b13): носителей в реальном графе ровно MIN_CARRIERS.
    // Рост состава не должен оставлять порог устаревшим-заниженным — инвариант
    // требует синхронной правки MIN_CARRIERS тем же PR.
    const okLine = output.split('\n').find((line) => line.startsWith('required tasks: ok'));
    if (okLine === undefined) {
      throw new Error('в выводе чекера нет строки required tasks: ok');
    }
    const sections = (okLine.split('—')[1] ?? '').split(';').map((part) => part.trim());
    for (const task of REQUIRED_TASKS) {
      const section = sections.find((part) => part.startsWith(`${task}:`));
      if (section === undefined) {
        throw new Error(`в выводе чекера нет секции ${task}`);
      }
      const carriers = section
        .slice(`${task}:`.length)
        .split(',')
        .filter((id) => id.trim() !== '');
      expect(carriers.length, `носителей ${task} против MIN_CARRIERS`).toBe(MIN_CARRIERS[task]);
    }
  });
});
