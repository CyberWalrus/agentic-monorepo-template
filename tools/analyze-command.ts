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
 * `.` — POSIX-синоним `source`: отдельным словом, за ним через пробел имя файла;
 * `ls .`, `find . -name`, `./x`, `src/.` и `file.md` интерпретатором не считаются.
 */
const INTERPRETER =
  /(?:^|[^\w.-])(?:\/?[\w.@+-]+\/)*(?:bash|zsh|dash|ksh\d*|mksh|fish|csh|tcsh|sh|eval|source|node|nodejs|tsx|ts-node|deno|bun|python[\d.]*|perl)(?=$|[^\w./-])|(?:^|[^\w./-])\.(?=[ \t]+[^\s;|&(){}<>-])/i;

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

/** Открытая конструкция; порядок в стеке — порядок вложенности. */
type Frame =
  /** `$( … )` — команды; текст подстановки оболочка читает внутри слова. */
  | { kind: 'cmd' }
  /** `( … )` — сабшелл, тело функции, массив, подстановка процесса. */
  | { kind: 'sub' }
  /** `{ … }` — группа команд. */
  | { kind: 'group' }
  /** `${ … }` — не команды: `<<` — часть слова. */
  | { kind: 'param' }
  /** `(( … ))` — арифметика: `<<` — сдвиг. `parens` — незакрытые скобки, у `((` их две. */
  | { kind: 'arith'; parens: number; substitution: boolean }
  /** `"…"` */
  | { kind: 'dq' }
  /** `'…'` */
  | { kind: 'sq' }
  /** `$'…'` */
  | { kind: 'ansi' };

/** Рамка со счётчиком открытий: так heredoc отличает свою рамку от открытой позже на её месте. */
type Open = Frame & { epoch: number };

/** Heredoc, оператор которого прочитан, а тело ещё не началось. `epoch` — сколько рамок открылось к нему. */
type Waiting = Heredoc & { epoch: number };

/**
 * Разбирает команду: где проходят тела heredoc'ов и какой текст остаётся вне их.
 * null — разбор не уверен, и команда остаётся в разборе целиком.
 *
 * Оболочка начинает тело heredoc за первым переводом строки, который она видит как конец
 * строки-оператора: не внутри кавычек, `$( … )`, обратных кавычек, `(( … ))`, `[[ … ]]`,
 * `${ … }` и не после `\`. Сканер ведёт стек открытых рамок, и тело открывается на переводе
 * строки, когда из рамок, открывшихся после оператора, не осталось ни одной. Открытые
 * `$( … )` — норма: их текст оболочка читает внутри слова, и строки подстановки исполняет.
 *
 * Не моделируются (null): `[[ … ]]`, `case` с их `<<` и `)`, обратные кавычки, `(` и `` ` ``
 * внутри `${…}`, `"$( … )"` — кавычки для разбора непрозрачны.
 */
function scan(command: string): { outside: string; bodies: [number, number][] } | null {
  const stack: Open[] = [];
  let waiting: Waiting[] = [];
  const bodies: [number, number][] = [];
  const outside: string[] = [];
  let copiedFrom = 0;
  /** Начинает ли следующий символ новое слово: тогда `#` — комментарий, а `case` — ключевое слово. */
  let boundary = true;
  let index = 0;
  let epoch = 0;
  const push = (frame: Frame): void => {
    stack.push({ ...frame, epoch: epoch++ });
  };
  /** `$(` и `$((` вне командного контекста. false — внутри `"…"`: не видно, где подстановка кончается. */
  const pushSubstitution = (): boolean => {
    if (stack.some((open) => open.kind === 'dq')) return false;
    const arithmetic = command[index + 2] === '(';
    if (arithmetic) push({ kind: 'arith', parens: 2, substitution: true });
    else push({ kind: 'cmd' });
    index += arithmetic ? 3 : 2;
    return true;
  };
  while (index < command.length) {
    const char = command[index] ?? '';
    const next = command[index + 1];
    const frame = stack.at(-1);
    if (
      frame === undefined ||
      frame.kind === 'cmd' ||
      frame.kind === 'sub' ||
      frame.kind === 'group'
    ) {
      if (char === '\\') {
        // экранированный символ, в том числе `\<перевод строки>` — продолжение строки: перевода строки нет
        index += 2;
        if (next !== '\n') boundary = false;
      } else if (char === "'" || char === '"') {
        push({ kind: char === "'" ? 'sq' : 'dq' });
        index++;
      } else if (char === '$' && next === "'") {
        push({ kind: 'ansi' });
        index += 2;
      } else if (char === '$' && next === '{') {
        push({ kind: 'param' });
        index += 2;
      } else if (char === '$' && next === '(') {
        if (!pushSubstitution()) return null;
      } else if (char === '(') {
        // `((` — арифметическая команда. `$((cmd); (cmd))` оболочка читает как подстановку команд — скобки те же
        if (next === '(') push({ kind: 'arith', parens: 2, substitution: false });
        else push({ kind: 'sub' });
        index += next === '(' ? 2 : 1;
      } else if (char === ')') {
        const popped = stack.pop();
        if (popped === undefined || (popped.kind !== 'cmd' && popped.kind !== 'sub')) return null;
        // heredoc внутри закрывшегося `$( … )`, в котором не было перевода строки: где его тело, неизвестно
        if (popped.kind === 'cmd' && waiting.some((heredoc) => heredoc.epoch > popped.epoch))
          return null;
        // после `)` сабшелла слово начинается заново, после `)` подстановки — продолжается
        boundary = popped.kind === 'sub';
        index++;
      } else if (char === '[' && next === '[') {
        return null; // `[[ … ]]`: внутри `<<` — не оператор; разбор условия не моделируется
      } else if (char === '#' && boundary) {
        // комментарий до конца строки: `#` начинает слово, а не находится внутри (`a#b`, после `$( … )`)
        const lineEnd = command.indexOf('\n', index);
        index = lineEnd === -1 ? command.length : lineEnd;
      } else if (char === '<') {
        let run = 1;
        while (command[index + run] === '<') run++;
        const heredoc = run === 2 ? readDelimiter(command, index + 2) : null;
        if (heredoc === null) {
          if (run !== 2) {
            index += run; // `<` — редирект, `<<<` — here-string
            boundary = true;
          } else return null; // слова нет либо разделитель раскрывается в рантайме: где тело, неизвестно
        } else {
          waiting.push({ ...heredoc, epoch });
          index = heredoc.end;
          boundary = false;
        }
      } else if (char === '\n') {
        // После heredoc'а открылись `( … )` или `{ … }`: оболочка читает его тело уже здесь,
        // а эти строки — данные. Не уверены — команда остаётся в разборе целиком.
        const after = (heredoc: Waiting): Open[] =>
          stack.filter((open) => open.epoch >= heredoc.epoch);
        if (waiting.some((heredoc) => after(heredoc).some((open) => open.kind !== 'cmd')))
          return null;
        // Начинаются тела heredoc'ов, после которых не осталось открытых рамок, — в порядке операторов.
        const due = waiting.filter((heredoc) => after(heredoc).length === 0);
        const ranges: [number, number][] = [];
        let bodyStart = index + 1;
        for (const { delimiter } of due) {
          const bodyEnd = afterTerminator(command, bodyStart, delimiter);
          if (bodyEnd === -1) return null; // не закрыт: где кончается тело, неизвестно
          ranges.push([bodyStart, bodyEnd]);
          bodyStart = bodyEnd;
        }
        boundary = true;
        if (due.length > 0) {
          outside.push(command.slice(copiedFrom, index + 1));
          bodies.push(...ranges);
          copiedFrom = bodyStart;
          index = bodyStart;
          waiting = waiting.filter((heredoc) => after(heredoc).length > 0);
        } else index++;
      } else if (char === '`') {
        return null; // обратные кавычки переносятся на следующие строки: разбор не моделируется
      } else if (char === '{' && boundary && (next === undefined || /[\s(<>"'`$#;|&]/.test(next))) {
        push({ kind: 'group' }); // слово `{`: внутри слова (`{a,b}`) — обычный символ
        index++;
      } else if (char === '}' && boundary && (next === undefined || /[\s;|&)]/.test(next))) {
        if (stack.pop()?.kind !== 'group') return null; // `}` без своей группы: не уверены, что закрылось
        boundary = false;
        index++;
      } else if (
        char === 'c' &&
        boundary &&
        command.startsWith('case', index) &&
        (command[index + 4] === undefined || /[\s;|&()]/.test(command[index + 4] ?? ''))
      ) {
        return null; // `case`: в шаблоне `)` и `<<` читаются не так, как в командах; разбор не моделируется
      } else {
        boundary = /[\s;|&>]/.test(char);
        index++;
      }
    } else if (frame.kind === 'sq') {
      if (char === "'") {
        stack.pop();
        boundary = false;
      }
      index++;
    } else if (frame.kind === 'ansi') {
      // в `$'…'` обратный слэш экранирует любой символ
      if (char === '\\') index += 2;
      else {
        if (char === "'") {
          stack.pop();
          boundary = false;
        }
        index++;
      }
    } else if (frame.kind === 'dq') {
      // В `"…"` обратный слэш экранирует только " \ $ ` и перевод строки.
      if (char === '\\') index += 2;
      else if (char === '"') {
        stack.pop();
        boundary = false;
        index++;
      } else if (char === '$' && next === '{') {
        push({ kind: 'param' });
        index += 2;
      } else if (char === '$' && next === '(' && command[index + 2] === '(') {
        push({ kind: 'arith', parens: 2, substitution: true });
        index += 3;
      } else if ((char === '$' && next === '(') || char === '`') return null; // `"$( … )"`: кавычки непрозрачны
      else index++;
    } else if (frame.kind === 'param') {
      if (char === '\\') index += 2;
      else if (char === "'" || char === '"') {
        push({ kind: char === "'" ? 'sq' : 'dq' });
        index++;
      } else if (char === '$' && next === '{') {
        push({ kind: 'param' });
        index += 2;
      } else if (char === '$' && next === '(') {
        if (!pushSubstitution()) return null;
      } else if (char === '{') {
        push({ kind: 'param' }); // вложенная скобка: граница `${…}` — не раньше оболочечной
        index++;
      } else if (char === '}') {
        stack.pop();
        boundary = false;
        index++;
      } else if (char === '(' || char === '`') return null; // не видно, где кончается `${…}`
      else index++;
    } else {
      if (char === '\\') index += 2;
      else if (char === "'" || char === '"') {
        push({ kind: char === "'" ? 'sq' : 'dq' });
        index++;
      } else if (char === '$' && next === '{') {
        push({ kind: 'param' });
        index += 2;
      } else if (char === '$' && next === '(') {
        if (!pushSubstitution()) return null;
      } else if (char === '(') {
        frame.parens++;
        index++;
      } else if (char === ')') {
        frame.parens--;
        if (frame.parens === 0) {
          stack.pop();
          boundary = !frame.substitution; // после `))` подстановки слово продолжается
        }
        index++;
      } else if (char === '`') return null;
      else index++;
    }
  }
  // конструкция или heredoc остался открытым до конца команды
  if (stack.length > 0 || waiting.length > 0) return null;
  outside.push(command.slice(copiedFrom));
  return { outside: outside.join(''), bodies };
}

/**
 * Убирает из команды тела heredoc'ов: для не-интерпретатора они данные (текст файла),
 * а не команды.
 *
 * `<<` — оператор только вне кавычек, комментария, арифметики и подстановки параметра:
 * `echo "<<END"` heredoc не открывает, следующие строки остаются командами (e45).
 * Тело остаётся в команде, если:
 * - в команде вне тел назван интерпретатор (INTERPRETER) — до него дойдут команды из тела;
 * - разбор не уверен до конца (`scan`): всё или ничего — вырезаются только тела команды,
 *   которую сканер прочитал без сомнений, иначе строка «тела» может оказаться командой;
 * - heredoc стоит внутри двойных кавычек (`"$(cat <<'EOF' …)"`) — кавычки для разбора непрозрачны.
 * Лишний текст в разборе даёт ложный отказ, но не пропуск. Разбор — подсказка (З3), не синтаксис оболочки.
 */
export function stripHeredocs(command: string): string {
  const parsed = scan(command);
  // не разобрать или в команде вне тел назван интерпретатор — всё остаётся командами
  if (parsed === null || INTERPRETER.test(parsed.outside)) return command;
  const kept: string[] = [];
  let cursor = 0;
  for (const [start, end] of parsed.bodies) {
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
