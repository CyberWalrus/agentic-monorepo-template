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

/**
 * Рамка со счётчиком открытий: так heredoc отличает свою рамку от открытой позже на её месте.
 * `opaque` и `quoted` — сколько рамок до неё включительно не являются `$( … )` и являются `"…"`: вопросы
 * «открылась ли после heredoc сомнительная рамка», «внутри ли кавычек» не требуют обхода стека.
 */
type Open = Frame & {
  epoch: number;
  opaque: number;
  quoted: number;
  /** Открыта как подстановка процесса — `<( … )`, `>( … )`, `=( … )`: после `)` слово продолжается. */
  process?: boolean;
  /** Слово, в котором стояла подстановка: после `)` оно продолжается. */
  outer?: Word;
};

/** Heredoc, оператор которого прочитан, а тело ещё не началось. `epoch` — сколько рамок открылось к нему. */
type Waiting = Heredoc & { epoch: number };

/** Слово и его позиция на момент, когда в нём открылась подстановка. */
type Word = { awaiting: boolean; target: boolean; command: boolean; from: number };

/** Индекс первой рамки с `epoch` не меньше `value`: рамки в стеке упорядочены по `epoch`. */
function frameFrom(stack: Open[], value: number): number {
  let low = 0;
  let high = stack.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((stack[middle]?.epoch ?? 0) < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Рамка командного контекста: внутри неё слово начинается заново. */
const isContext = (open: Open | undefined): boolean =>
  open?.kind === 'cmd' || open?.kind === 'sub' || open?.kind === 'group';

/** Присваивание перед командой (`FOO=bar cmd`): командное слово — следующее за ним. */
const ASSIGNMENT = /^[A-Za-z_]\w*\+?=/;

/** Зарезервированные слова, за которыми идёт команда. Слово-опция (`time -p cmd`) командой не бывает. */
const RESERVED = new Set([
  '!',
  'if',
  'then',
  'elif',
  'else',
  'while',
  'until',
  'do',
  'time',
  'function',
  'coproc',
  // zsh
  'always',
  'repeat',
  'foreach',
  'nocorrect',
  'noglob',
]);

/** Фигурные скобки с раскрытием: `b{a,a}sh`, `{bash,zsh}`. */
const BRACES = /\{[^{}]*(?:,|\.\.)[^{}]*\}/;

/**
 * Оболочка под ссылкой — `$SHELL`, `$0` (в `bash -c` — имя оболочки), `$BASH`, `$ZSH_NAME`: тот же
 * интерпретатор, в каком бы месте команды ссылка ни стояла (`sudo $SHELL <<EOF`).
 */
const SHELL_REFERENCE = /\$\{?(?:SHELL|BASH|ZSH_NAME|0)\b/;

/**
 * Разбирает команду: где проходят тела heredoc'ов и какой текст остаётся вне их.
 * null — разбор не уверен, и команда остаётся в разборе целиком.
 *
 * Оболочка начинает тело heredoc за первым переводом строки, который она видит как конец
 * строки-оператора: не внутри кавычек, `$( … )`, обратных кавычек, `(( … ))`, `[[ … ]]`,
 * `${ … }` и не после `\`. Сканер ведёт стек открытых рамок, и тело открывается на переводе
 * строки, когда из рамок, открывшихся после оператора, не осталось ни одной. Открытые
 * `$( … )` — норма: их текст оболочка читает внутри слова, и строки подстановки исполняет.
 * Внутри `$( … )` и `( … )` слово начинается заново: `#` и `case` читаются там так же, как в команде.
 *
 * Не моделируются (null): `[[ … ]]`, `case` с их `<<` и `)`, обратные кавычки, `(` и `` ` ``
 * внутри `${…}`, `"$( … )"` — кавычки для разбора непрозрачны; арифметика `$[ … ]` и индекс
 * присваивания массива (`a[…]=…`); `(`, прилипшая к слову, кроме `name()`; подстановка процесса
 * (`<( … )`, `>( … )`, `=( … )`) с heredoc внутри — где его тело, зависит от оболочки; командное
 * слово, которое оболочка раскроет (`$SHELL`, `"b"ash`, `*sh`), — имени читателя в тексте нет.
 *
 * Стоимость разбора растёт не быстрее длины команды. На переводе строки работа — O(log) от глубины
 * стека, а не произведение «ждущие heredoc'и × глубина»: иначе длинная команда пережила бы таймаут
 * хука, а таймаут пропускает команду.
 */
function scan(command: string): { outside: string; bodies: [number, number][] } | null {
  const stack: Open[] = [];
  const waiting: Waiting[] = [];
  const bodies: [number, number][] = [];
  const outside: string[] = [];
  let copiedFrom = 0;
  /** Начинает ли следующий символ новое слово: тогда `#` — комментарий, а `case` — ключевое слово. */
  let boundary = true;
  let index = 0;
  let epoch = 0;
  /**
   * Позиция слова: за разделителем, открывающей скобкой, присваиванием, целью редиректа и зарезервированным
   * словом идёт командное слово (`awaiting`). Оно обязано быть буквальным: `$SHELL`, `"b"ash`, `*sh`
   * оболочка раскроет в имя команды, которого в тексте нет, и тело heredoc'а дойдёт до неё как команды.
   * Аргументы раскрываться могут: читатель — буквальное командное слово.
   */
  let awaiting = true;
  let target = false;
  let wordCommand = false;
  let wordAssignment: boolean | null = null;
  let wordFrom = -1;
  const word = (): Word => ({ awaiting, target, command: wordCommand, from: wordFrom });
  /** Читается слово; `opaque` — в нём появились `$`, кавычка или `\`. true — командное слово не буквально. */
  const wordChar = (opaque: boolean): boolean => {
    if (wordFrom === -1) {
      wordFrom = index;
      wordCommand = awaiting && !target;
      wordAssignment = null;
      target = false;
    }
    if (!wordCommand || !opaque) return false;
    // значение присваивания раскрываться может
    wordAssignment ??= ASSIGNMENT.test(command.slice(wordFrom, index));
    return !wordAssignment;
  };
  /**
   * Слово окончилось. `redirect` — за ним без пробела идёт `<` или `>`: слово из цифр — номер дескриптора.
   * true — командное слово оказалось глобом, фигурными скобками или zsh-путём `=bash`.
   */
  const endWord = (redirect: boolean): boolean => {
    if (wordFrom === -1) return false;
    const text = command.slice(wordFrom, index);
    wordFrom = -1;
    if (!wordCommand || (redirect && /^\d+$/.test(text))) return false;
    awaiting = ASSIGNMENT.test(text) || RESERVED.has(text) || text.startsWith('-');
    return text.startsWith('=') || (text !== '[' && text.includes('[')) || BRACES.test(text);
  };
  const push = (frame: Frame): void => {
    const below = stack.at(-1);
    stack.push({
      ...frame,
      epoch: epoch++,
      opaque: (below?.opaque ?? 0) + (frame.kind === 'cmd' ? 0 : 1),
      quoted: (below?.quoted ?? 0) + (frame.kind === 'dq' ? 1 : 0),
    });
  };
  /** `$(` и `$((` вне командного контекста. false — внутри `"…"`: не видно, где подстановка кончается. */
  const pushSubstitution = (): boolean => {
    if ((stack.at(-1)?.quoted ?? 0) > 0) return false;
    const arithmetic = command[index + 2] === '(';
    if (arithmetic) push({ kind: 'arith', parens: 2, substitution: true });
    else {
      push({ kind: 'cmd' });
      // внутри `$( … )` оболочка начинает новое слово: `a$(#` — комментарий, `a=$(case` — ключевое слово
      boundary = true;
    }
    index += arithmetic ? 3 : 2;
    return true;
  };
  /** Рамка на верхушке стека и счётчик открытий в прошлом шаге: за шаг меняется не более одной рамки. */
  let seenFrame: Open | undefined;
  let seenEpoch = 0;
  while (index < command.length) {
    const char = command[index] ?? '';
    const next = command[index + 1];
    const frame = stack.at(-1);
    if (frame !== seenFrame) {
      if (epoch !== seenEpoch && frame !== undefined && isContext(frame)) {
        // Открылась рамка командного контекста: слово внутри начинается заново; подстановка помнит слово,
        // в котором стояла. `<( … )`, `>( … )`, `=( … )` — подстановка процесса.
        frame.process = frame.kind === 'sub' && /[<>=]/.test(command[index - 2] ?? '');
        frame.outer = word();
        awaiting = true;
        target = false;
        wordFrom = -1;
      } else if (epoch === seenEpoch && seenFrame !== undefined && isContext(seenFrame)) {
        const closed = seenFrame;
        // Heredoc внутри закрывшейся подстановки — `$( … )`, `<( … )`, `>( … )` — без перевода строки:
        // где его тело, зависит от оболочки (bash 3.2 и zsh читают следующие строки как команды).
        if (
          (closed.kind === 'cmd' || closed.process === true) &&
          waiting.some((heredoc) => heredoc.epoch > closed.epoch)
        )
          return null;
        const outer = closed.outer;
        if ((closed.kind === 'cmd' || closed.process === true) && outer !== undefined) {
          awaiting = outer.awaiting;
          target = outer.target;
          wordCommand = outer.command;
          wordAssignment = null;
          wordFrom = outer.from;
        } else {
          // сабшелл и группа закрылись: слово начинается заново
          awaiting = true;
          target = false;
          wordFrom = -1;
        }
      }
      seenFrame = frame;
    }
    seenEpoch = epoch;
    if (
      frame === undefined ||
      frame.kind === 'cmd' ||
      frame.kind === 'sub' ||
      frame.kind === 'group'
    ) {
      // Позиция слова; само слово, операторы и рамки читают ветки ниже
      if (/[\s;|&]/.test(char)) {
        if (endWord(false)) return null;
        // `>&`, `<&`, `&>`, `>|`, `|&` — операторы редиректа и конвейера, а не разделитель команд
        const glued = /[<>|]/.test(command[index - 1] ?? '') || (char === '&' && next === '>');
        if (char === '\n' || char === ';' || (!glued && (char === '|' || char === '&'))) {
          awaiting = true;
          target = false;
        }
      } else if (char === '<' || char === '>') {
        if (endWord(true)) return null;
        // следующее слово — цель редиректа; разделитель heredoc'а (`<<`) читает ветка ниже
        if (char === '>' || next !== '<' || command[index + 2] === '<') target = true;
      } else if (char === '(' || char === ')' || (char === '#' && boundary)) {
        if (endWord(false)) return null;
      } else if (/['"\\$`]/.test(char)) {
        // кавычка, `\` и раскрытие внутри командного слова: его буквального имени не видно
        if (wordChar(true)) return null;
      } else if (wordChar(/[*?]/.test(char))) return null; // `*sh`, `?ash`
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
      } else if ((char === '$' && next === '[') || (char === '[' && !boundary)) {
        // арифметика `$[ … ]` и индекс массива (`a[…]=…`): `<<` внутри — сдвиг, а где выражение кончается, не видно
        return null;
      } else if (char === '$' && next === '(') {
        if (!pushSubstitution()) return null;
      } else if (char === '(') {
        // прилипла к слову (`a=( … )`, `${a}(`): присваивание массива читается не как команда, остальное —
        // ошибка синтаксиса; `name()` — определение функции
        if (!boundary && next !== ')') return null;
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
        const oldest = waiting[0];
        if (oldest !== undefined) {
          const top = stack.at(-1);
          // После heredoc'а открылись `( … )` или `{ … }`: оболочка читает его тело уже здесь,
          // а эти строки — данные. Не уверены — команда остаётся в разборе целиком.
          const from = frameFrom(stack, oldest.epoch);
          if (from < stack.length && (top?.opaque ?? 0) > (stack[from - 1]?.opaque ?? 0))
            return null;
          // Начинаются тела heredoc'ов, после которых не осталось открытых рамок (это суффикс списка
          // ждущих), — в порядке операторов.
          // `limit` — счётчик открытий верхушки стека; пустой стек (−1) — тела начинают все ждущие
          const limit = top?.epoch ?? -1;
          let first = waiting.length;
          while (first > 0 && limit < (waiting[first - 1]?.epoch ?? 0)) first--;
          const ranges: [number, number][] = [];
          let bodyStart = index + 1;
          for (const { delimiter } of waiting.slice(first)) {
            const bodyEnd = afterTerminator(command, bodyStart, delimiter);
            if (bodyEnd === -1) return null; // не закрыт: где кончается тело, неизвестно
            ranges.push([bodyStart, bodyEnd]);
            bodyStart = bodyEnd;
          }
          boundary = true;
          if (first < waiting.length) {
            outside.push(command.slice(copiedFrom, index + 1));
            bodies.push(...ranges);
            copiedFrom = bodyStart;
            index = bodyStart;
            waiting.length = first;
          } else index++;
        } else {
          boundary = true;
          index++;
        }
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
 * - оболочка названа по ссылке — `$SHELL`, `$0`, `$BASH` (SHELL_REFERENCE): это тот же интерпретатор,
 *   в каком бы месте команды ссылка ни стояла;
 * - разбор не уверен до конца (`scan`): всё или ничего — вырезаются только тела команды,
 *   которую сканер прочитал без сомнений, иначе строка «тела» может оказаться командой. Сомнение —
 *   в том числе командное слово, которое оболочка раскроет (`$SHELL`, `"b"ash`, `*sh`), и heredoc
 *   внутри подстановки процесса, закрытой на той же строке (`<(cat <<'EOF')`);
 * - heredoc стоит внутри двойных кавычек (`"$(cat <<'EOF' …)"`) — кавычки для разбора непрозрачны.
 * Лишний текст в разборе даёт ложный отказ, но не пропуск. Разбор — подсказка (З3), не синтаксис оболочки.
 */
export function stripHeredocs(command: string): string {
  const parsed = scan(command);
  // не разобрать, оболочка названа по ссылке или вне тел назван интерпретатор — всё остаётся командами
  if (parsed === null || SHELL_REFERENCE.test(parsed.outside) || INTERPRETER.test(parsed.outside))
    return command;
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

/** Интерпретатор, которому программа передана аргументом: `node -e`, `node -p`, `python -c`. */
const INLINE_CODE =
  /(?:^|[^\w.-])(?:node|nodejs|bun|deno|tsx|ts-node|python[\d.]*)(?:\s+-{1,2}[\w.-]+)*\s+(?:-e|-c|--eval|-p|--print)(?=\s|$)/;

/** Строковый литерал похож на путь к файлу: в нём есть каталог либо расширение, но нет текста программы. */
const PATH_LIKE = /^(?:[^\s"'`(){}[\]]*\/[^\s"'`(){}[\]]*|[\w@+-]+\.[A-Za-z]\w*)$/;

/**
 * Строковые литералы программы в аргументе интерпретатора. Кавычки — стек: литерал
 * открывается любой кавычкой и закрывается такой же; `\"` — отдельный уровень (программа
 * в `"…"` оболочки, строки в ней — через экранирование). Внешний литерал — вся программа —
 * отсеется по PATH_LIKE.
 */
function codeLiterals(code: string): string[] {
  const literals: string[] = [];
  const stack: [kind: string, start: number][] = [];
  for (let at = 0; at < code.length; at++) {
    let kind = '';
    if (code.charAt(at) === "'") kind = "'";
    else if (code.charAt(at) === '"') kind = '"';
    else if (code.startsWith('\\"', at)) kind = '\\"';
    else {
      if (code.charAt(at) === '\\') at++;
      continue;
    }
    const top = stack.at(-1);
    if (top?.[0] === kind) {
      stack.pop();
      literals.push(code.slice(top[1] + kind.length, at));
    } else {
      stack.push([kind, at]);
    }
    if (kind === '\\"') at++;
  }
  return literals;
}

/**
 * Пути, в которые сегмент команды пишет (или которые удаляет/перемещает).
 *
 * Перенаправление с номером потока (`1>`) — запись в файл, как `>`; `2>` остаётся вне целей.
 * `perl -i` пишет по месту в файлы после программы, как `sed -i`. Программа интерпретатора
 * (`node -e`, `python -c`) не разбирается: файл в ней может быть назван только строкой,
 * поэтому строковые литералы, похожие на путь, считаются целями — консервативно, чтение
 * защищённого пути из `-e` тоже попадёт в отказ.
 */
export function writeTargets(segment: string): string[] {
  const targets: string[] = [];
  for (const match of segment.matchAll(/(?:^|[^0-9&<>])1?>{1,2}\s*([^\s;&|<>]+)/g)) {
    const target = match[1] ?? '';
    if (!target.startsWith('&') && target !== '/dev/null') {
      targets.push(target);
    }
  }
  const code = INLINE_CODE.exec(segment);
  if (code !== null) {
    targets.push(
      ...codeLiterals(segment.slice(code.index + code[0].length)).filter((literal) =>
        PATH_LIKE.test(literal),
      ),
    );
  }
  const tokens = tokenize(segment.replace(/\d?>{1,2}\s*\S+/g, ' '));
  const args = (from: number) => tokens.slice(from).filter((t) => !t.startsWith('-'));
  const index = tokens.findIndex((t) => /^(sed|tee|mv|cp|rm|truncate|ln|install|perl)$/.test(t));
  if (index === -1) {
    return targets;
  }
  const tool = tokens[index];
  if (tool === undefined) {
    return targets;
  }
  const rest = args(index + 1);
  if (tool === 'perl' && tokens.some((t) => /^-[A-Za-z]*i/.test(t))) {
    targets.push(...rest.slice(1));
  } else if (tool === 'sed' && tokens.some((t) => t.startsWith('-i'))) {
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

/**
 * Делит команду на простые команды — по `;`, `&&`, `||`, `|`, `&` и переводу строки вне кавычек.
 * В отличие от `SEGMENTS`, кавычки для разбора непрозрачны (`-m "a; b"` — один аргумент), а `&`
 * перенаправления (`2>&1`, `&>file`) — не конец команды: правило по словам не должно терять команду
 * из-за текста, который оболочка читает иначе (e50).
 */
export function splitCommands(command: string): string[] {
  const commands: string[] = [];
  let start = 0;
  let quote = '';
  const end = (at: number, width: number): void => {
    commands.push(command.slice(start, at));
    start = at + width;
  };
  for (let at = 0; at < command.length; at++) {
    const char = command.charAt(at);
    if (quote !== '') {
      // экранированная кавычка внутри двойных кавычек их не закрывает
      if (char === '\\' && quote === '"' && command.charAt(at + 1) === quote) at++;
      else if (char === quote) quote = '';
    } else if (char === "'" || char === '"' || char === '`') quote = char;
    else if (char === '\\') at++; // экранированный символ и перенос строки
    else if (char === ';' || char === '\n') end(at, 1);
    else if (char === '|' || char === '&') {
      // `2>&1`, `&>file`, `&>>file` — перенаправление потока, а не конец команды
      const stream =
        command.charAt(at - 1) === '>' ||
        command.charAt(at - 1) === '<' ||
        command.charAt(at + 1) === '>';
      if (stream) continue;
      // `&&` и `||` — один разделитель: второй символ не начинает пустую команду
      const doubled = command.charAt(at + 1) === char;
      end(at, doubled ? 2 : 1);
      if (doubled) at++;
    }
  }
  commands.push(command.slice(start));
  return commands;
}

/**
 * Слова простой команды — `tokenize` без оболочечного «клея» по краям слова: `$(git`, `(pnpm`, `{`,
 * `-u)`. Клей относится к оболочке, а не к слову, которое читает правило.
 */
export function commandWords(command: string): string[] {
  return tokenize(command)
    .map((word) => word.replace(/^[({$`]+/, '').replace(/[)}]+$/, ''))
    .filter((word) => word !== '');
}

/**
 * Глобальные опции git между `git` и подкомандой. Значение отдельным словом берут `-C <путь>`,
 * `-c <имя>=<значение>`, `--git-dir`, `--work-tree`, `--namespace`, `--config-env` (git 2.50.1:
 * `git <опция> <значение> status` отвечает как с `=`, а `--exec-path` и `--no-pager` значение
 * отдельным словом не берут); остальные — `--флаг` либо `--флаг=значение`.
 */
const GIT_GLOBAL_OPTIONS =
  /\bgit(?:(?:\s+(?:-[Cc]|--git-dir|--work-tree|--namespace|--config-env)\s+(?:"[^"\n]*"|'[^'\n]*'|[^\s;&|]+))|\s+--?[^\s;&|]+)*/g;

/**
 * Снимает с текста команды глобальные опции git: `git -C <dir> push -f` правила читают как
 * `git push -f`. Буквальное правило матчит `git <подкоманда>`, а опция между ними разрывала
 * форму (e50).
 */
export function withoutGitGlobalOptions(command: string): string {
  return command.replace(GIT_GLOBAL_OPTIONS, 'git');
}

/** Раннер снапшотов — сам (`vitest`) или путь к его бинарнику (`./node_modules/.bin/playwright`). */
const TEST_RUNNER = /(?:^|\/)(?:vitest|playwright|jest)$/;
/** Диспетчер пакетов, через который вызывается тестовая задача: имени раннера в команде тогда нет. */
const PACKAGE_MANAGER = /^(?:pnpm|pnpx|npx|npm|yarn|bun|bunx)$/;
/** Тестовая задача диспетчера: `test`, его псевдонимы и `test:*`-скрипты. */
const TEST_TASK = /^(?:test|tst|t|e2e|visual)(?::\S*)?$/;
/** Флаг обновления снапшотов цельным словом: `-u`, `--update-snapshots`, `--updateSnapshot`. */
const SNAPSHOT_UPDATE_FLAG = /^(?:-u|--update)/;

const isSnapshotUpdateFlag = (word: string): boolean => SNAPSHOT_UPDATE_FLAG.test(word);

/**
 * Обновляет ли простая команда базлайны формой, которую буквальное правило не видит: флаг
 * обновления стоит цельным словом
 * - в хвосте после разделителя `--` — там аргументы вызываемого скрипта ровно в том виде, как их
 *   написали (`pnpm test -- -u`);
 * - без разделителя — в тестовом запуске: назван раннер (`npx playwright test -u`) либо диспетчер
 *   пакетов вызывает тестовую задачу (`pnpm --filter x test -u`).
 *
 * `git push -u origin <ветка>` и `curl -u` остаются разрешёнными: в них нет ни разделителя,
 * ни тестового запуска.
 */
export function updatesSnapshots(words: string[]): boolean {
  const separator = words.indexOf('--');
  if (separator !== -1 && words.slice(separator + 1).some(isSnapshotUpdateFlag)) return true;
  const manager = words.findIndex((word) => PACKAGE_MANAGER.test(word));
  const runsTests =
    words.some((word) => TEST_RUNNER.test(word)) ||
    (manager !== -1 && words.slice(manager + 1).some((word) => TEST_TASK.test(word)));
  return runsTests && words.some(isSnapshotUpdateFlag);
}

/** Слово `git` — само или путь к бинарнику (`/usr/bin/git`). */
const GIT = /(?:^|[^\w-])git$/;
/** Опции `git checkout` со значением отдельным словом: за ним идёт имя, а не ревизия и не путь. */
const CHECKOUT_OPTION_WITH_VALUE = new Set([
  '-b',
  '-B',
  '--orphan',
  '--pathspec-from-file',
  '--conflict',
]);

/**
 * Перезаписывает ли простая команда файлы рабочего дерева через `git checkout` — их несохранённые
 * изменения отбрасываются, как у запрещённого `git checkout -- <файл>`:
 * - за `--` есть пути: `git checkout <ревизия> -- <файл>`;
 * - без `--` остались ревизия и путь (`git checkout <ревизия> <файл>` — та же операция), либо пути
 *   читаются из файла (`--pathspec-from-file`).
 *
 * Опции и их значения не считаются: `git checkout -b <ветка> <старт>` — смена ветки. Одно слово
 * без `--` (`git checkout task/e50`) — тоже смена ветки: ветка это или путь, по тексту не отличить.
 */
export function checkoutOverwritesPaths(words: string[]): boolean {
  for (let at = 0; at + 1 < words.length; at++) {
    if (!GIT.test(words[at] ?? '') || words[at + 1] !== 'checkout') continue;
    const args = words.slice(at + 2);
    const separator = args.indexOf('--');
    if (separator !== -1) {
      if (separator < args.length - 1) return true;
    } else if (args.some((arg) => arg.startsWith('--pathspec-from-file'))) return true;
    let skipValue = false;
    let positional = 0;
    for (const arg of args) {
      if (skipValue) skipValue = false;
      else if (CHECKOUT_OPTION_WITH_VALUE.has(arg)) skipValue = true;
      else if (!arg.startsWith('-')) positional++;
    }
    if (positional >= 2) return true;
  }
  return false;
}
