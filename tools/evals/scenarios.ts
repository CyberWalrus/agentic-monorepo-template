/**
 * Сценарии evals (ADR 0016): markdown с front matter в tools/evals/scenarios/.
 * Тело файла — промпт агенту; поля front matter — имя, описание и guards
 * отсутствия фичи (identifiers, которых не должно быть в продуктовом коде:
 * реализованная обычным PR фича делает сценарий тривиальным и тихо
 * инвертирует смысл метрики — находка architecture-ревью плана C9.1).
 *
 * Собственный минимальный парсер front matter, а не parseTask из
 * tools/backlog-board.ts: тот знает модель доски (id, статусы, touches) и
 * защиту protected-paths — раннеру нужен только «ключ: значение» и список
 * в строку; тащить раннер в зависимость от модели доски не нужно, а вынос
 * общего хелпера — правка deny-файла доски вне этой задачи.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface Scenario {
  name: string;
  description: string;
  guardsNotPresent: string[];
  prompt: string;
}

export class ScenarioError extends Error {
  readonly file: string;

  constructor(message: string, file: string) {
    super(`${file}: ${message}`);
    this.file = file;
  }
}

export const SCENARIO_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Каталог сценариев относительно корня репозитория (литерал-каталог: файлы в замыкание не тянет). */
export const SCENARIOS_DIR = 'tools/evals/scenarios';

export function parseScenario(file: string, raw: string): Scenario {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (match === null) {
    throw new ScenarioError('нет front matter «--- … ---»', file);
  }
  const block = match[1] ?? '';
  const fields = new Map<string, string>();
  for (const [index, line] of block.split('\n').entries()) {
    if (line.trim() === '') {
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) {
      throw new ScenarioError(`строка ${index + 1} front matter не вида «ключ: значение»`, file);
    }
    const key = line.slice(0, colon).trim();
    if (fields.has(key)) {
      throw new ScenarioError(`поле «${key}» указано дважды`, file);
    }
    fields.set(key, line.slice(colon + 1).trim());
  }

  const name = fields.get('name') ?? '';
  if (!SCENARIO_NAME_RE.test(name)) {
    throw new ScenarioError(`name «${name}» не подходит под ${SCENARIO_NAME_RE.source}`, file);
  }
  const description = fields.get('description') ?? '';
  if (description === '') {
    throw new ScenarioError('нет описания (description)', file);
  }
  const guardsRaw = fields.get('guards-not-present') ?? '';
  if (guardsRaw === '') {
    throw new ScenarioError(
      'нет guards-not-present: сценарий обязан объявлять идентификаторы фичи, которых не должно быть в продуктовом коде, иначе реализованная фича тихо инвертирует смысл метрики',
      file,
    );
  }
  const guardsNotPresent = guardsRaw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  const prompt = raw.slice(match[0].length).trim();
  if (prompt === '') {
    throw new ScenarioError('пустой промпт (тело после front matter)', file);
  }
  return { name, description, guardsNotPresent, prompt };
}

export interface ScenarioRef {
  name: string;
  path: string;
}

/** Файлы сценариев по имени в алфавитном порядке — порядок прогонов детерминирован. */
export function discoverScenarios(root: string): ScenarioRef[] {
  const dir = join(root, SCENARIOS_DIR);
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .toSorted()
    .map((name) => ({ name: name.replace(/\.md$/, ''), path: join(dir, name) }));
}

export function loadScenario(ref: ScenarioRef): Scenario {
  return parseScenario(ref.path, readFileSync(ref.path, 'utf8'));
}

const GUARD_EXTENSIONS = new Set(['.ts', '.tsx', '.css']);
const GUARD_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.output',
  '.turbo',
  'reports',
  'coverage',
]);

function walkSources(dir: string, sink: (file: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!GUARD_SKIP_DIRS.has(entry.name)) {
        walkSources(join(dir, entry.name), sink);
      }
      continue;
    }
    if (entry.isFile() && GUARD_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
      sink(join(dir, entry.name));
    }
  }
}

/**
 * Нарушения guards: идентификаторы фичи, уже появившиеся в продуктовом коде
 * (каталоги src приложений и пакетов: apps/<pkg>/src, packages/<pkg>/src).
 * Раннер отказывает громко (З11), а не меряет тривиальный сценарий.
 */
export function guardViolations(scenario: Scenario, root: string): string[] {
  const violations: string[] = [];
  const contentCache = new Map<string, string>();
  const read = (file: string): string => {
    let text = contentCache.get(file);
    if (text === undefined) {
      text = readFileSync(file, 'utf8');
      contentCache.set(file, text);
    }
    return text;
  };
  const productsRoots = ['apps', 'packages']
    .map((top) => join(root, top))
    .filter((dir) => {
      try {
        return statSync(dir).isDirectory();
      } catch {
        return false;
      }
    });
  for (const top of productsRoots) {
    for (const entry of readdirSync(top, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const src = join(top, entry.name, 'src');
      try {
        if (!statSync(src).isDirectory()) {
          continue;
        }
      } catch {
        continue;
      }
      const files: string[] = [];
      walkSources(src, (file) => {
        files.push(file);
      });
      for (const guard of scenario.guardsNotPresent) {
        if (files.some((file) => read(file).includes(guard))) {
          violations.push(`${guard} найден в ${entry.name}/src`);
        }
      }
    }
  }
  return violations;
}
