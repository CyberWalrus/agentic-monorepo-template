/**
 * Разбор shell-команды: в какие файлы она пишет.
 *
 * Это подсказка агенту (З3: быстрый разбор способа), а не граница безопасности —
 * границей является проверка по результату и gate-integrity из доверенной базы.
 * Модуль не имеет внешних зависимостей: хуки агента не имеют права падать
 * из-за отсутствующего node_modules (З4).
 */
import { isAbsolute, relative, resolve } from 'node:path';

/**
 * Интерпретаторы: heredoc, поданный им на stdin, — это команды, а не данные.
 * Оболочки и их синонимы, `eval`/`source`, JS/TS-рантаймы, python, perl.
 */
const INTERPRETER =
  /(?:^|[^\w.-])(?:\/?[\w.@+-]+\/)*(?:bash|zsh|dash|ksh\d*|mksh|fish|csh|tcsh|sh|eval|source|node|nodejs|tsx|ts-node|deno|bun|python[\d.]*|perl)(?=$|[^\w./-])/i;

interface Heredoc {
  delimiter: string;
  /** Индекс сразу после слова-разделителя. */
  end: number;
}

/**
 * Слово после `<<` — разделитель heredoc так, как его читает оболочка: кавычки
 * снимаются, `\x` — экранированный символ. null — слова нет либо оно раскрывается
 * в рантайме (`<<$X`): терминатор неизвестен, тело останется в разборе.
 */
function readDelimiter(command: string, from: number): Heredoc | null {
  let index = from;
  if (command[index] === '-') index++; // `<<-`
  while (command[index] === ' ' || command[index] === '\t') index++;
  let delimiter = '';
  while (index < command.length) {
    const char = command[index] ?? '';
    if (char === "'" || char === '"') {
      const closing = command.indexOf(char, index + 1);
      if (closing === -1) return null;
      delimiter += command.slice(index + 1, closing);
      index = closing + 1;
    } else if (char === '\\') {
      const escaped = command[index + 1];
      if (escaped === undefined || escaped === '\n') return null;
      delimiter += escaped;
      index += 2;
    } else if (/[\s<>;&|()`$]/.test(char)) {
      break;
    } else {
      delimiter += char;
      index++;
    }
  }
  const dynamic = command[index] === '$' || command[index] === '`';
  return delimiter === '' || dynamic ? null : { delimiter, end: index };
}

/**
 * Индекс сразу после строки-терминатора, начиная с `from`; -1 — heredoc не закрыт.
 * Терминатор сравнивается мягче, чем в оболочке (отступ и хвостовые пробелы
 * игнорируются): найденное тело никогда не длиннее настоящего — всё, что оболочка
 * исполнит, остаётся в разборе.
 */
function afterTerminator(command: string, from: number, delimiter: string): number {
  let lineStart = from;
  while (lineStart < command.length) {
    const lineEnd = command.indexOf('\n', lineStart);
    const line = command.slice(lineStart, lineEnd === -1 ? command.length : lineEnd);
    if (line.trim() === delimiter) return lineEnd === -1 ? command.length : lineEnd + 1;
    if (lineEnd === -1) return -1;
    lineStart = lineEnd + 1;
  }
  return -1;
}

/**
 * Индекс после закрывающей скобки области, которую не разбираем (`(( … ))`, `${ … }`):
 * внутри неё `<<` — не оператор. Глубина учитывается; непарные скобки — до конца команды.
 */
function afterBlock(
  command: string,
  from: number,
  depth: number,
  open: string,
  close: string,
): number {
  for (let index = from; index < command.length; index++) {
    const char = command[index];
    if (char === open) depth++;
    else if (char === close && --depth === 0) return index + 1;
  }
  return command.length;
}

/**
 * Убирает из команды тела heredoc'ов: для не-интерпретатора они данные (текст файла),
 * а не команды.
 *
 * `<<` — оператор только вне кавычек, комментария, арифметики и подстановки параметра:
 * `echo "<<END"` heredoc не открывает, следующие строки остаются командами (e45).
 * Тело остаётся в команде, если:
 * - в команде вне тел назван интерпретатор (INTERPRETER) — до него дойдут команды из тела;
 * - heredoc не закрыт или его разделитель раскрывается в рантайме — тело неизвестно;
 * - heredoc стоит внутри двойных кавычек (`"$(cat <<'EOF' …)"`) — кавычки для разбора непрозрачны.
 * Лишний текст в разборе даёт ложный отказ, но не пропуск. Разбор — подсказка (З3),
 * не синтаксис оболочки: `case`-шаблоны и `[[ ]]` с `<<` внутри не моделируются.
 */
export function stripHeredocs(command: string): string {
  /** Тела закрытых heredoc'ов, [начало, конец). */
  const bodies: [number, number][] = [];
  /** Текст вне тел: по нему ищем интерпретатор. */
  const outside: string[] = [];
  let copiedFrom = 0;
  let quote: "'" | '"' | "$'" | null = null;
  /** Heredoc'ы текущей логической строки: их тела начинаются за её переводом строки. */
  let opened: Heredoc[] = [];
  let index = 0;
  while (index < command.length) {
    const char = command[index] ?? '';
    const next = command[index + 1];
    if (quote === "'") {
      if (char === "'") quote = null;
      index++;
    } else if (quote !== null) {
      // В `"…"` обратный слэш экранирует только " \ $ ` и перевод строки, в `$'…'` — любой символ.
      const escaped = quote === "$'" || (next !== undefined && '"\\$`\n'.includes(next));
      if (char === '\\' && escaped) {
        index += 2;
      } else {
        if (char === (quote === '"' ? '"' : "'")) quote = null;
        index++;
      }
    } else if (char === '\\') {
      index += 2;
    } else if (char === "'" || char === '"') {
      quote = char;
      index++;
    } else if (char === '$' && next === "'") {
      quote = "$'";
      index += 2;
    } else if (
      // комментарий до конца строки: `#` начинает слово, а не находится внутри (`$#`, `a#b`)
      char === '#' &&
      (index === 0 || /[\s;|&()]/.test(command[index - 1] ?? ''))
    ) {
      const lineEnd = command.indexOf('\n', index);
      index = lineEnd === -1 ? command.length : lineEnd;
    } else if (char === '(' && next === '(') {
      index = afterBlock(command, index + 2, 2, '(', ')'); // `(( … ))` — арифметика: `<<` здесь сдвиг
    } else if (char === '$' && next === '{') {
      index = afterBlock(command, index + 2, 1, '{', '}'); // `${…}`: `<<` — часть слова
    } else if (
      char === '<' &&
      next === '<' &&
      command[index - 1] !== '<' &&
      command[index + 2] !== '<'
    ) {
      // `<<<` — here-string, не heredoc
      const heredoc = readDelimiter(command, index + 2);
      if (heredoc === null) index++; // не разобрать: `<<` остаётся текстом, тело — в разборе
      else {
        opened.push(heredoc);
        index = heredoc.end;
      }
    } else if (char === '\n' && opened.length > 0) {
      // Тела идут в порядке операторов строки, каждое — сразу за предыдущим.
      const ranges: [number, number][] = [];
      let bodyStart = index + 1;
      for (const { delimiter } of opened) {
        const bodyEnd = afterTerminator(command, bodyStart, delimiter);
        if (bodyEnd === -1) {
          // не закрыт: где кончается тело, неизвестно — остальное остаётся в разборе
          outside.push(command.slice(copiedFrom));
          index = command.length;
          copiedFrom = command.length;
          break;
        }
        ranges.push([bodyStart, bodyEnd]);
        bodyStart = bodyEnd;
      }
      if (index < command.length) {
        outside.push(command.slice(copiedFrom, index + 1));
        bodies.push(...ranges);
        copiedFrom = bodyStart;
        index = bodyStart;
      }
      opened = [];
    } else {
      index++;
    }
  }
  outside.push(command.slice(copiedFrom));
  if (INTERPRETER.test(outside.join(''))) return command;
  const kept: string[] = [];
  let cursor = 0;
  for (const [start, end] of bodies) {
    kept.push(command.slice(cursor, start));
    cursor = end;
  }
  kept.push(command.slice(cursor));
  return kept.join('');
}

/** Простая токенизация с учётом кавычек: достаточно для поиска путей-целей записи. */
export function tokenize(segment: string): string[] {
  return [...segment.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');
}

/** Пути, в которые сегмент команды пишет (или которые удаляет/перемещает). */
export function writeTargets(segment: string): string[] {
  const targets: string[] = [];
  for (const match of segment.matchAll(/(?:^|[^0-9&<>])>{1,2}\s*([^\s;&|<>]+)/g)) {
    const target = match[1] ?? '';
    if (!target.startsWith('&') && target !== '/dev/null') {
      targets.push(target);
    }
  }
  const tokens = tokenize(segment.replace(/\d?>{1,2}\s*\S+/g, ' '));
  const args = (from: number) => tokens.slice(from).filter((t) => !t.startsWith('-'));
  const index = tokens.findIndex((t) => /^(sed|tee|mv|cp|rm|truncate|ln|install)$/.test(t));
  if (index === -1) {
    return targets;
  }
  const tool = tokens[index];
  if (tool === undefined) {
    return targets;
  }
  const rest = args(index + 1);
  if (tool === 'sed' && tokens.some((t) => t.startsWith('-i'))) {
    targets.push(...rest.slice(1));
  } else if (tool === 'cp' || tool === 'ln' || tool === 'install') {
    targets.push(...rest.slice(-1));
  } else if (tool === 'tee' || tool === 'mv' || tool === 'rm' || tool === 'truncate') {
    targets.push(...rest);
  }
  return targets;
}

const SEGMENTS = /&&|\|\||[;|\n]/;

/**
 * Абсолютные пути внутри projectDir, в которые команда пишет.
 * `cd` и `pushd` внутри команды переносят рабочий каталог для последующих сегментов,
 * `popd` возвращает его, поэтому относительные пути разрешаются против фактического
 * каталога сегмента, а не против cwd сессии. Сабшелл `(cd …)` моделируем как обычный cd.
 * Не моделируем (остаёмся на месте — for `cd -` и `cd` без аргумента это консервативно,
 * для прочих случаев это известная недопокрытость подсказки): `cd -`, `cd`/`pushd` без
 * аргумента, `env -C`, переменные в аргументе cd.
 */
export function repoWriteTargets(
  command: string,
  initialCwd: string,
  projectDir: string,
): string[] {
  let cwd = resolve(initialCwd);
  const stack: string[] = [];
  const result: string[] = [];
  for (const segment of command.split(SEGMENTS)) {
    cwd = applyCd(segment, cwd, stack);
    for (const rawTarget of writeTargets(segment)) {
      // закрывающая скобка субшелла прилипает к цели: `(cd x && echo > a.json)`
      const target = rawTarget.replace(/\)+$/, '');
      const absolute = isAbsolute(target) ? target : resolve(cwd, target);
      const rel = relative(projectDir, absolute);
      if (!rel.startsWith('..')) {
        result.push(absolute);
      }
    }
  }
  return result;
}

function applyCd(segment: string, cwd: string, stack: string[]): string {
  let sawCd = false;
  let verb = '';
  for (const token of tokenize(segment)) {
    if (!sawCd) {
      const word = token.replace(/^\(+/, '');
      if (word === 'cd' || word === 'pushd' || word === 'popd') {
        sawCd = true;
        verb = word;
      }
      continue; // env-префиксы (FOO=bar cd …) и сам cd пропускаем
    }
    if (token.startsWith('-') || token.startsWith('+')) {
      continue; // -L/-P и позиции стека: каталог не моделируем; `cd -`: тоже
    }
    if (verb === 'popd') {
      return stack.pop() ?? cwd;
    }
    stack.push(cwd);
    return resolve(cwd, token);
  }
  if (sawCd && verb === 'popd') {
    return stack.pop() ?? cwd; // popd без аргументов
  }
  return cwd;
}
