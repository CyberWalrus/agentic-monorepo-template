/**
 * Гейт пинов действий GitHub (e76, З5/З6) — две инварианты над `.github/**`.
 *
 * 1. Формат комментария версии. Для каждой строки
 *    `uses: <владелец>/<действие>@<40 hex>` комментарий после пина обязан
 *    называть неизменяемый тег релиза — ровно `# vX.Y.Z` (без `v` — тоже), а не
 *    подвижный тег мажорной версии (`# vN`). zizmor сверяет комментарий с пином
 *    только по факту (аудит `ref-version-mismatch`): пока тег не уехал, `# vN`
 *    выглядит верным; после выхода релиза — красит джобу `zizmor` на всех PR
 *    (24.11.2026, поезд стоял около двух часов — docs/escaped-defects.md). Этот
 *    чекер красит заранее, локально и без сети. Локальное действие без пина
 *    разрешено — `./…` и `$/.github/actions/setup` (форма шаблона: в
 *    `pull_request_target` резолвится из базовой ветки, ADR 0002, e28);
 *    `docker://` — вне соглашения (у образа нет тега релиза действия).
 * 2. Версия сканера zizmor. Вход `version` шага `zizmorcore/zizmor-action` в
 *    security.yml — точная версия: `latest`, `prerelease` или отсутствие входа
 *    отдают выбор релиза обёртке, и новый аудит включается без изменения
 *    репозитория.
 *
 * Fail-closed (З4, З11): строка `uses:` неразборной формы, действие не по SHA,
 * `uses` вне блок-маппинга (flow-запись `- { uses: … }` и `with: { … }` чекер
 * не читает), пропавший шаг сканера и пустой каталог — красные, а не
 * пропущенные. Граница: соответствие комментария самому SHA чекер не проверяет
 * (нужна сеть) — это вторая линия, zizmor.
 *
 * Чистое ядро (evaluateTree) отделено от CLI guard-ом invokedDirectly: импорт
 * из тестов не читает дерево и не завершает процесс (как check-required-tasks.ts).
 *
 *   pnpm action-pins:check      шаг verify (fast) и job static CI
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Неизменяемый тег релиза: полная версия, `v` необязательна. */
const IMMUTABLE_TAG = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA = /^[0-9a-f]{40}$/;
/** `<владелец>/<репозиторий>[/<путь>]@<ссылка>`. */
const REMOTE_ACTION = /^([^/@\s]+)\/([^/@\s]+)(?:\/[^@\s]+)?@(\S+)$/;
/** Ключ `uses:` блок-маппинга YAML — с тире элемента последовательности или без. */
const BLOCK_USES = /^(\s*(?:-\s+)?uses:[ \t]*)(.*)$/;
/** Локальное действие — относительный путь: `./…` либо `$/.github/…` (шаблон, e28). */
const LOCAL_ACTION = /^(?:\.|\$)[/\\]/;
/** `uses` ключом flow-маппинга: `{ uses: … }`, `{uses: …}`; ключ в кавычках тоже. */
const FLOW_USES = /(?:^|[{,])[ \t]*['"]?uses['"]?[ \t]*:/;
/**
 * Точная версия в терминах обёртки — `version_regex` action.sh zizmor-action на
 * закреплённом SHA (45d7276c, v0.8.1): X.Y.Z, `v` необязательна.
 */
const EXACT_VERSION = /^v?\d+\.\d+\.\d+(?:(?:a|b|rc)\d+)?(?:\.dev\d+)?$/;

/** Шаг сканера, чья версия зафиксирована входом (e76). */
export const SCANNER_PIN = {
  file: '.github/workflows/security.yml',
  action: 'zizmorcore/zizmor-action',
  input: 'version',
} as const;

export interface PinFile {
  /** Путь от корня репозитория. */
  path: string;
  text: string;
}

/** Вердикт по одной строке: проблема либо учтённый пин по SHA. */
export interface LineVerdict {
  problem?: string;
  /** Строка — действие, закреплённое по SHA с тегом релиза в комментарии. */
  pinned: boolean;
}

interface UsesValue {
  kind: 'docker' | 'local' | 'remote';
  /** Ссылка после `@` (только remote). */
  ref?: string;
  /** Комментарий после значения без `#`; undefined — комментария нет. */
  comment?: string;
}

/** Разбор значения `uses:` (всё после ключа) вместе с комментарием строки. */
function parseUses(rest: string): UsesValue | { problem: string } {
  const text = rest.replace(/^[ \t]+/, '');
  let value: string;
  let tail: string;
  const quote = text[0];
  if (quote === '"' || quote === "'") {
    const end = text.indexOf(quote, 1);
    if (end === -1) {
      return { problem: 'незакрытая кавычка в значении uses' };
    }
    value = text.slice(1, end);
    tail = text.slice(end + 1);
  } else {
    const match = /^([^\s,}#]*)(.*)$/.exec(text);
    value = match?.[1] ?? '';
    tail = match?.[2] ?? '';
    // В YAML `#` начинает комментарий только после пробела; слипшийся — часть
    // значения, и пин «по SHA» окажется битым молча.
    if (tail.startsWith('#')) {
      return { problem: `перед комментарием версии нужен пробел: «${value}${tail}»` };
    }
  }
  if (value === '') {
    return { problem: 'пустое значение uses' };
  }
  const comment = /(?:^|[ \t])#(.*)$/.exec(tail)?.[1]?.trim();
  const shared: Pick<UsesValue, 'comment'> =
    comment === undefined || comment === '' ? {} : { comment };
  if (value.startsWith('docker://')) {
    return { kind: 'docker', ...shared };
  }
  if (LOCAL_ACTION.test(value)) {
    return { kind: 'local', ...shared };
  }
  const remote = REMOTE_ACTION.exec(value);
  if (remote === null) {
    return { problem: `значение uses не разобрано: «${value}»` };
  }
  return { kind: 'remote', ref: remote[3] ?? '', ...shared };
}

/** Вердикт по одной строке YAML-файла `.github/**`. Чистая функция. */
export function checkUsesLine(line: string): LineVerdict {
  const block = BLOCK_USES.exec(line);
  if (block === null) {
    // Полностью закомментированная строка и хвост `… # uses: …` — не шаг.
    if (FLOW_USES.test(line.replace(/(^|\s)#.*$/, ''))) {
      return {
        pinned: false,
        problem:
          'uses вне блок-маппинга (flow-запись `{ … }`): чекер читает только блок, вынеси uses: отдельной строкой',
      };
    }
    return { pinned: false };
  }
  const parsed = parseUses(block[2] ?? '');
  if ('problem' in parsed) {
    return { pinned: false, problem: parsed.problem };
  }
  if (parsed.kind !== 'remote') {
    return { pinned: false };
  }
  const ref = parsed.ref ?? '';
  if (!SHA.test(ref)) {
    return { pinned: false, problem: `пин не по SHA (40 hex): «${ref}»` };
  }
  if (parsed.comment === undefined) {
    return {
      pinned: false,
      problem: 'нет комментария с тегом релиза после пина (нужен `# vX.Y.Z`)',
    };
  }
  if (!IMMUTABLE_TAG.test(parsed.comment)) {
    return {
      pinned: false,
      problem: `тег релиза не полной версии: «${parsed.comment}» — нужен \`# vX.Y.Z\`, а не \`# vN\``,
    };
  }
  return { pinned: true };
}

/**
 * Вход `version` шага сканера: точная версия — её значение; иначе проблема.
 * Шаг ищется по `uses:` блок-маппинга, вход — в `with:` того же шага.
 */
export function scannerVersion(
  text: string,
  pin: typeof SCANNER_PIN = SCANNER_PIN,
): { version?: string; problem?: string } {
  const lines = text.split('\n');
  let step = -1;
  let keyIndent = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const value = BLOCK_USES.exec(line)?.[2];
    if (value !== undefined && value.trim().replace(/^['"]/, '').startsWith(`${pin.action}@`)) {
      step = index;
      keyIndent = line.indexOf('uses:');
      break;
    }
  }
  if (step === -1) {
    return {
      problem: `в ${pin.file} нет шага ${pin.action} — якорь правила версии сканера умер, обнови SCANNER_PIN (fail-closed, З4)`,
    };
  }
  let withIndent: number | undefined;
  for (let index = step + 1; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').replace(/\r$/, '');
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const indent = line.length - line.trimStart().length;
    // Шаг кончился: отступ меньше ключа либо соседний элемент последовательности.
    if (indent < keyIndent || (indent === keyIndent && trimmed.startsWith('- '))) {
      break;
    }
    if (indent === keyIndent) {
      // Соседний ключ шага: `with:` открывает входы, любой другой закрывает.
      withIndent = /^with:\s*$/.test(trimmed) ? indent : undefined;
      continue;
    }
    if (withIndent === undefined) {
      continue;
    }
    const input = /^([\w-]+):[ \t]*(.*)$/.exec(trimmed);
    if (input?.[1] !== pin.input) {
      continue;
    }
    const value = (input[2] ?? '')
      .replace(/^(['"])(.*)\1$/, '$2')
      .replace(/[ \t]+#.*$/, '')
      .trim();
    return EXACT_VERSION.test(value)
      ? { version: value }
      : {
          problem: `вход ${pin.input}: ожидалась точная версия релиза (например, v1.32.0), получено «${value || 'пусто'}» — с плавающей версией новый аудит включается без изменения репозитория`,
        };
  }
  return {
    problem: `у шага ${pin.action} нет входа ${pin.input} — версия сканера не зафиксирована`,
  };
}

/** Оценка дерева YAML-файлов `.github/**`. Чистая функция: тесты подают фикстуры. */
export function evaluateTree(files: readonly PinFile[]): {
  problems: string[];
  pinned: number;
  /** Значение входа `version` сканера, если файл и вход на месте. */
  scanner: string | undefined;
} {
  const problems: string[] = [];
  let pinned = 0;
  let usesSeen = false;
  let scanner: string | undefined;
  let scannerSeen = false;
  for (const file of files) {
    const lines = file.text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const raw = lines[index] ?? '';
      const verdict = checkUsesLine(raw.replace(/\r$/, ''));
      if (BLOCK_USES.test(raw)) {
        usesSeen = true;
      }
      if (verdict.problem !== undefined) {
        problems.push(`${file.path}:${index + 1}: ${verdict.problem}`);
      }
      pinned += verdict.pinned ? 1 : 0;
    }
    if (file.path === SCANNER_PIN.file) {
      scannerSeen = true;
      const verdict = scannerVersion(file.text);
      scanner = verdict.version;
      if (verdict.problem !== undefined) {
        problems.push(`${file.path}: ${verdict.problem}`);
      }
    }
  }
  if (files.length === 0) {
    problems.push('в .github нет YAML-файлов — чекеру нечего проверять (fail-loud, З11)');
  } else if (!usesSeen) {
    problems.push('в .github не найдено ни одной строки uses: — чекер слеп (fail-loud, З11)');
  }
  if (!scannerSeen) {
    problems.push(
      `нет файла ${SCANNER_PIN.file} — правило версии сканера потеряло носителя (fail-loud, З11)`,
    );
  }
  return { problems, pinned, scanner };
}

/** YAML-файлы `.github/**` (workflows и composite-действия): пути от корня, по алфавиту. */
export function listPinFiles(root: string): PinFile[] {
  const paths: string[] = [];
  const walk = (relative: string): void => {
    const entries = readdirSync(join(root, relative), { withFileTypes: true });
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(path);
      } else if (/\.ya?ml$/.test(entry.name)) {
        paths.push(path);
      }
    }
  };
  walk('.github');
  return paths.map((path) => ({ path, text: readFileSync(join(root, path), 'utf8') }));
}

// --- CLI ---------------------------------------------------------------------------

const repoRootFromHere = fileURLToPath(new URL('..', import.meta.url));
const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  const files = listPinFiles(repoRootFromHere);
  const { problems, pinned, scanner } = evaluateTree(files);
  if (problems.length > 0) {
    console.error('action pins: версии действий GitHub (e76) — нарушения:');
    console.error(problems.map((problem) => `- ${problem}`).join('\n'));
    process.exit(1);
  }
  console.log(
    `action pins: ok — SHA-пинов: ${pinned}, YAML-файлов .github: ${files.length}; zizmor — version ${scanner ?? '?'}`,
  );
}
