/** Unit-тесты разбора shell-команд (tools/analyze-command.ts): цели записи и учёт cd. */
import { describe, expect, it } from 'vitest';

import {
  checkoutOverwritesPaths,
  commandWords,
  repoWriteTargets,
  splitCommands,
  stripHeredocs,
  tokenize,
  updatesSnapshots,
  withoutGitGlobalOptions,
  writeTargets,
} from '../analyze-command.ts';

const REPO = '/repo';

/** Строки команды в одну строку: heredoc'ы в тестах читаются как в терминале. */
const script = (lines: string[]) => lines.join('\n');

describe('writeTargets', () => {
  const cases: [string, string[]][] = [
    ['echo x > a.json', ['a.json']],
    ['echo x >> a.json', ['a.json']],
    ['echo x 2> err.log', []],
    ['echo x > /dev/null', []],
    ['echo hi', []],
    ['sed -i "s/a/b/" f.json', ['f.json']],
    ['sed "s/a/b/" f.json', []],
    ['print x | tee out.json', ['out.json']],
    ['cp a.json b.json', ['b.json']],
    ['ln -s a.json b.json', ['b.json']],
    ['install -m 644 src dst.json', ['dst.json']],
    // mv уничтожает источник, поэтому оба пути считаются целями
    ['mv old.json new.json', ['old.json', 'new.json']],
    ['rm -rf dir1 dir2', ['dir1', 'dir2']],
    // значение -s попадает в цели: безвредно, файл "0" никогда не защищён
    ['truncate -s 0 f.json', ['0', 'f.json']],
  ];
  for (const [segment, expected] of cases) {
    it(`"${segment}" → ${JSON.stringify(expected)}`, () => {
      expect(writeTargets(segment)).toEqual(expected);
    });
  }
});

describe('tokenize', () => {
  it('splits on whitespace and strips quotes', () => {
    expect(tokenize('echo "my file" \'x\'')).toEqual(['echo', 'my file', 'x']);
  });
});

describe('repoWriteTargets: cd учитывается', () => {
  const cases: [string, string, string[]][] = [
    // цель внутри репо без cd
    ['echo x > tools/a.json', REPO, [`${REPO}/tools/a.json`]],
    // audit: cd уводит в защищённый каталог
    ['cd tools && echo x > protected-paths.json', REPO, [`${REPO}/tools/protected-paths.json`]],
    // audit: cd уводит наружу — запись вне репо не цель гейта
    ['cd /tmp && echo x > .oxlintrc.json', REPO, []],
    // cd действует и на следующие сегменты
    ['cd tools; cd .. ; echo x > a.json', REPO, [`${REPO}/a.json`]],
    // сабшелл моделируем как обычный cd
    ['(cd tools && echo x > a.json)', REPO, [`${REPO}/tools/a.json`]],
    // env-префикс перед cd
    ['FOO=bar cd tools && rm a.json', REPO, [`${REPO}/tools/a.json`]],
    // pushd/popd моделируются
    ['pushd tools && echo x > a.json', REPO, [`${REPO}/tools/a.json`]],
    ['pushd tools && popd && echo x > a.json', REPO, [`${REPO}/a.json`]],
    ['popd && echo x > tools/a.json', REPO, [`${REPO}/tools/a.json`]],
    // `cd -` не моделируем: остаёмся в текущем каталоге (консервативно)
    ['cd - && echo x > tools/a.json', REPO, [`${REPO}/tools/a.json`]],
    // абсолютные пути
    ['echo x > /tmp/elsewhere.json', REPO, []],
    ['echo x > /repo/tools/a.json', REPO, [`${REPO}/tools/a.json`]],
    // cwd сессии может быть вне репо (агент делал cd в прошлой команде)
    ['echo x > tools/a.json', '/tmp/elsewhere', []],
    ['echo x > /repo/tools/a.json', '/tmp/elsewhere', [`${REPO}/tools/a.json`]],
    // pipe-сегменты тоже проверяются
    ['echo secret | tee tools/a.json', REPO, [`${REPO}/tools/a.json`]],
    // перевод строки разделяет сегменты
    ['echo a\necho b > c.json', REPO, [`${REPO}/c.json`]],
  ];
  for (const [command, cwd, expected] of cases) {
    it(`"${command}" (cwd=${cwd}) → ${JSON.stringify(expected)}`, () => {
      expect(repoWriteTargets(command, cwd, REPO)).toEqual(expected);
    });
  }
});

describe('stripHeredocs', () => {
  const PROTECTED = `${REPO}/tools/a.json`;

  /** Тело heredoc, поданного не интерпретатору, — данные: вырезается и командами не считается. */
  it('cuts the body, so its content is not parsed as commands', () => {
    const input = script(['cat <<EOF', 'echo x > tools/a.json', 'EOF', 'echo done']);
    expect(repoWriteTargets(stripHeredocs(input), REPO, REPO)).toEqual([]);
  });

  it('keeps the redirect of the opener line: its target is outside the body', () => {
    const input = script(['cat > tools/a.json <<EOF', 'content', 'EOF']);
    expect(repoWriteTargets(stripHeredocs(input), REPO, REPO)).toEqual([PROTECTED]);
  });

  it.each([
    // `<<-`: табы в начале строк тела игнорируются, в том числе у терминатора
    { lines: ['cat <<-EOF', '\techo x > tools/a.json', '\tEOF', 'echo done'] },
    // терминатор — строка целиком; слово внутри строки тела им не считается
    {
      lines: [
        "cat <<'EOF'",
        'EOF is just a word here',
        'echo x > tools/a.json',
        'EOF',
        'echo done',
      ],
    },
    // два heredoc'а одной строки: тела идут в порядке операторов
    {
      lines: [
        'cat <<A <<B',
        'echo x > tools/a.json',
        'A',
        'echo x > tools/a.json',
        'B',
        'echo done',
      ],
    },
    // пробел между оператором и разделителем
    { lines: ["cat << 'EOF'", 'echo x > tools/a.json', 'EOF', 'echo done'] },
  ])('cuts the body of a heredoc to a non-interpreter: $lines', ({ lines }) => {
    expect(repoWriteTargets(stripHeredocs(script(lines)), REPO, REPO)).toEqual([]);
  });

  /** Разделитель читается как в оболочке: кавычки снимаются, `\x` — экранированный символ. */
  it.each([
    // в оболочке разделитель — EOF, а не E
    { lines: ['cat <<E"O"F', 'echo x > tools/a.json', 'EOF', 'echo done'] },
    { lines: ['cat <<\\EOF', 'echo x > tools/a.json', 'EOF', 'echo done'] },
  ])('reads the delimiter the way the shell does: $lines', ({ lines }) => {
    expect(repoWriteTargets(stripHeredocs(script(lines)), REPO, REPO)).toEqual([]);
  });

  /** e45: heredoc, поданный интерпретатору, — команды: правила и цели записи проверяются по телу. */
  it.each([
    'bash',
    'sh',
    'zsh',
    'bash -s',
    '/bin/bash',
    'source /dev/stdin',
    // `.` — POSIX-синоним `source` (ревью e45)
    '. /dev/stdin',
    '. ./script.sh',
    'node',
    'python3',
    'perl',
  ])('keeps the body fed to an interpreter: %s', (reader) => {
    const input = script([`${reader} <<'EOF'`, 'echo x > tools/a.json', 'EOF']);
    expect(stripHeredocs(input)).toBe(input);
    expect(repoWriteTargets(stripHeredocs(input), REPO, REPO)).toEqual([PROTECTED]);
  });

  /** `.` — интерпретатор только отдельным словом с именем файла; путь, ключ и аргумент им не считаются. */
  it.each([
    'cat README.md',
    'cat ./notes.md',
    'ls src/.',
    'git add . && cat',
    'grep -rn x . | head',
    'find . -name "*.ts" && cat',
    'docker build . -t img && cat',
  ])('does not take a dot inside a path or an argument for the source builtin: %s', (reader) => {
    const input = script([`${reader} <<'EOF'`, 'echo x > tools/a.json', 'EOF']);
    expect(repoWriteTargets(stripHeredocs(input), REPO, REPO)).toEqual([]);
  });

  /** Тело дойдёт до интерпретатора и тогда, когда он назван не в начале строки-оператора. */
  it.each([
    // конвейер: cat печатает тело, bash исполняет
    { lines: ["cat <<'EOF' | bash", 'git commit --no-verify', 'EOF'] },
    // два шага одной командой: скрипт записан и запущен
    { lines: ["cat > /tmp/s.sh <<'EOF'", 'git commit --no-verify', 'EOF', 'bash /tmp/s.sh'] },
    // подстановка процесса
    { lines: ["bash <(cat <<'EOF'", 'git commit --no-verify', 'EOF', ')'] },
    { lines: ['env FOO=1 timeout 5 bash <<EOF', 'git commit --no-verify', 'EOF'] },
  ])('keeps the body when an interpreter is named anywhere in the command: $lines', ({ lines }) => {
    expect(stripHeredocs(script(lines))).toBe(script(lines));
  });

  /** e45: `<<` — оператор только вне кавычек и комментариев: фальшивый фрейм не вырезает команды. */
  it.each([
    { lines: ['echo "<<END"', 'git commit --no-verify', 'END'] },
    { lines: ["echo '<<END'", 'git commit --no-verify', 'END'] },
    { lines: ["echo $'it\\'s <<END'", 'git commit --no-verify', 'END'] },
    { lines: ['# cat <<EOF', 'git commit --no-verify', 'EOF'] },
    // here-string `<<<` — не heredoc
    { lines: ['cat <<<EOF', 'git commit --no-verify', 'EOF'] },
  ])('does not cut after a << that is not an operator: $lines', ({ lines }) => {
    expect(stripHeredocs(script(lines))).toBe(script(lines));
  });

  /** В арифметике `<<` — сдвиг, в подстановке параметра — часть слова: это тоже фальшивый фрейм. */
  it.each([
    // число после `<<` не бывает разделителем
    { lines: ['echo $(( 1<<2 ))', 'git commit --no-verify', '2'] },
    { lines: ['(( 1<<2 ))', 'git commit --no-verify', '2'] },
    { lines: ['echo ${x:-<<EOF}', 'git commit --no-verify', 'EOF'] },
    // `}` внутри `$( … )` и внутри кавычек — не граница `${…}` (ревью e45)
    { lines: ['echo ${u:-$(echo })<<EOF;}', 'git commit --no-verify', 'EOF'] },
    { lines: ['echo ${x:-"}"<<EOF}', 'git commit --no-verify', 'EOF'] },
  ])('does not cut after a << inside arithmetic or parameter expansion: $lines', ({ lines }) => {
    expect(stripHeredocs(script(lines))).toBe(script(lines));
  });

  /**
   * e45 (ревью): оболочка начинает тело за переводом строки, завершающим команду с оператором, а не за
   * первым переводом строки после него. Строки внутри `$(`…`)`, обратных кавычек и `{ … }` она исполняет.
   */
  it.each<{ lines: string[]; kept?: string[] }>([
    // подстановка команд на строке-операторе продолжается на следующей строке: тело с терминатором — за `)`
    {
      lines: ["cat <<'EOF' $(echo a;", 'git commit --no-verify)', 'body', 'EOF'],
      kept: ["cat <<'EOF' $(echo a;", 'git commit --no-verify)', ''],
    },
    {
      lines: ["cat <<'EOF' $(echo a;", 'echo x > tools/a.json)', 'body', 'EOF'],
      kept: ["cat <<'EOF' $(echo a;", 'echo x > tools/a.json)', ''],
    },
    // слово внутри `$(`…`)` начинается заново (ревью e45): `#` сразу за прилипшей `$(` — комментарий,
    // `)` в нём подстановку не закрывает, и строка продолжения — команда
    {
      lines: ["cat <<'EOF' a=$(# )", 'git commit --no-verify)', 'body', 'EOF'],
      kept: ["cat <<'EOF' a=$(# )", 'git commit --no-verify)', ''],
    },
    // `case` за прилипшей `$(` — ключевое слово: разбор не уверен, команда остаётся целиком
    { lines: ["cat <<'EOF' a=$(case x in x)", 'git commit --no-verify;; esac)', 'body', 'EOF'] },
    {
      lines: [
        "cat <<'EOF' a=$(echo a)$(case x in x)",
        'git commit --no-verify;; esac)',
        'body',
        'EOF',
      ],
    },
    // группа команд и сабшелл после оператора на той же строке, обратные кавычки на следующей строке:
    // разбор не уверен — команда остаётся в разборе целиком
    { lines: ["cat <<'EOF' >/dev/null && { echo a;", 'git commit --no-verify; }', 'body', 'EOF'] },
    { lines: ["cat <<'EOF' ; (", 'git commit --no-verify', ')', 'body', 'EOF'] },
    { lines: ["cat <<'EOF' `", 'git commit --no-verify`', 'body', 'EOF'] },
  ])('keeps the lines the shell runs before the body starts: $lines', ({ lines, kept }) => {
    expect(stripHeredocs(script(lines))).toBe(script(kept ?? lines));
  });

  /** Тела вырезаются, только если команда разобралась без сомнений; иначе всё остаётся командами. */
  it.each([
    // `<<` внутри `[[ ]]` и в шаблоне `case` — не оператор, но их разбор не моделируется
    { lines: ['[[ $a == x<<EOF ]]', 'git commit --no-verify', 'EOF'] },
    { lines: ['case $x in a<<EOF)', 'git commit --no-verify', 'EOF'] },
    // `(`, прилипшая к слову, — присваивание массива или ошибка синтаксиса: не уверены, где оболочка начнёт тело
    { lines: ["cat <<'EOF' a=(# )", 'git commit --no-verify)', 'body', 'EOF'] },
    // присваивание массива с `<<` в элементе: bash и zsh читают следующую строку как команду
    { lines: ['a=(1<<2)', 'git commit --no-verify', '2'] },
    // арифметика `$[ … ]` и индекс присваивания массива: `<<` там — сдвиг, границы выражения не моделируются
    { lines: ['echo $[1<<2]', 'git commit --no-verify', '2]'] },
    { lines: ['a[1<<2]=3', 'git commit --no-verify', '2]=3'] },
    // разделитель раскрывается в рантайме: строка «тела» может оказаться командой
    { lines: ['D=EOF && cat <<$D', "cat <<'A'", 'EOF', 'git commit --no-verify', 'A'] },
  ])('keeps everything when the analysis is not sure: $lines', ({ lines }) => {
    expect(stripHeredocs(script(lines))).toBe(script(lines));
  });

  /** `#` после `$( … )` — не комментарий: слово продолжается, и подстановка переносится на следующую строку. */
  it('does not take # after $( … ) for a comment', () => {
    const input = script([
      "cat <<'EOF' $(echo a)#b$(",
      'git commit --no-verify',
      ')',
      'body',
      'EOF',
    ]);
    expect(stripHeredocs(input)).toBe(
      script(["cat <<'EOF' $(echo a)#b$(", 'git commit --no-verify', ')', '']),
    );
  });

  it('keeps everything when a construct is left open after the heredoc', () => {
    const input = script(["cat <<'EOF'", 'echo x > tools/a.json', 'EOF', 'echo "unterminated']);
    expect(repoWriteTargets(stripHeredocs(input), REPO, REPO)).toEqual([PROTECTED]);
  });

  /** Тело по-прежнему данные, когда строка-оператор кончилась там, где её видит оболочка. */
  it.each([
    // `$(`…`)` на одной строке
    { lines: ["cat <<'EOF' $(echo a; echo b)", 'echo x > tools/a.json', 'EOF'] },
    // комментарий сразу за прилипшей `$(`: подстановка закрыта на строке-операторе
    { lines: ["cat <<'EOF' a=$(# comment", 'echo b)', 'echo x > tools/a.json', 'EOF'] },
    // внутренний heredoc подстановки — данные её cat; внешний открывается за `)`
    {
      lines: [
        "cat <<'A' $(cat <<'B'",
        'echo x > tools/a.json',
        'B',
        ')',
        'echo x > tools/a.json',
        'A',
      ],
    },
    // heredoc внутри `( … )` и `{ … }`
    { lines: ["(cd tools && cat <<'EOF'", 'echo x > tools/a.json', 'EOF', ')'] },
    { lines: ["{ cat <<'EOF'; }", 'echo x > tools/a.json', 'EOF'] },
    { lines: ["(cat <<'EOF' )", 'echo x > tools/a.json', 'EOF'] },
    // продолжение строки и двойные кавычки на строке-операторе
    { lines: ["cat <<'EOF' \\", '$(echo a) "b"', 'echo x > tools/a.json', 'EOF'] },
  ])(
    'still cuts the body when the opener line ends where the shell sees it: $lines',
    ({ lines }) => {
      expect(repoWriteTargets(stripHeredocs(script(lines)), REPO, REPO)).toEqual([]);
    },
  );

  it.each(['echo $(( 1 << 2 ))', 'echo ${x:-1}'])(
    'still cuts a real heredoc that follows arithmetic: %s',
    (line) => {
      const input = script([line, "cat > notes.md <<'EOF'", 'git commit --no-verify', 'EOF']);
      expect(stripHeredocs(input)).not.toContain('git commit --no-verify');
    },
  );

  /** Где кончается такое тело, неизвестно: остаётся в разборе (ложный отказ безопаснее пропуска). */
  it.each([
    // незакрытый heredoc
    { lines: ['cat <<EOF', 'echo x > tools/a.json'] },
    // разделитель раскрывается в рантайме
    { lines: ['cat <<$DELIM', 'echo x > tools/a.json', 'DELIM'] },
  ])('keeps a heredoc whose terminator the analysis cannot locate: $lines', ({ lines }) => {
    expect(stripHeredocs(script(lines))).toBe(script(lines));
  });

  /** Кавычки для разбора непрозрачны: heredoc внутри `"$( … )"` не вырезается. */
  it('keeps a heredoc that sits inside double quotes', () => {
    const input = script(["git commit -m \"$(cat <<'EOF'", 'echo x > tools/a.json', 'EOF', ')"']);
    expect(repoWriteTargets(stripHeredocs(input), REPO, REPO)).toEqual([PROTECTED]);
  });

  /**
   * e45 (ревью, раунд 3): heredoc внутри подстановки процесса, закрытой на той же строке. bash 3.2 и zsh
   * читают следующие строки как команды, а не как тело; где тело у остальных оболочек — не видно.
   */
  it.each([
    "cat <(cat <<'EOF')",
    "cat > >(cat <<'EOF')",
    "diff <(cat <<'EOF') /dev/null",
    // zsh: `=( … )` — файл с выводом команды
    "cat =(cat <<'EOF')",
  ])('keeps the lines after a heredoc inside a process substitution: %s', (line) => {
    const input = script([line, 'git commit --no-verify', 'EOF']);
    expect(stripHeredocs(input)).toBe(input);
  });

  it('still cuts the body after a process substitution that holds no heredoc', () => {
    const input = script(["cat <(echo a) <<'EOF'", 'echo x > tools/a.json', 'EOF']);
    expect(repoWriteTargets(stripHeredocs(input), REPO, REPO)).toEqual([]);
  });

  /**
   * e45 (ревью, раунд 3): командное слово не буквально — `$SHELL`, `$0`, `"b"ash` оболочка раскроет в имя
   * интерпретатора, которого в тексте нет, и тело heredoc'а дойдёт до него как команды.
   */
  it.each([
    "$SHELL <<'EOF'",
    '$0 <<EOF',
    '"b"ash <<\'EOF\'',
    "${SHELL} <<'EOF'",
    // за зарезервированным словом и в конвейере командное слово то же
    "! $SHELL <<'EOF'",
    "time $SHELL <<'EOF'",
    "if $SHELL <<'EOF'",
    "cat <<'EOF' | $SHELL",
    // zsh: `=bash` — путь к команде; глоб и фигурные скобки
    "=bash <<'EOF'",
    "[b]ash <<'EOF'",
    "b{a,a}sh <<'EOF'",
    "ba\\sh <<'EOF'",
    "$(echo bash) <<'EOF'",
  ])('keeps the body when the command word is not a literal: %s', (line) => {
    const input = script([line, 'git commit --no-verify', 'EOF']);
    expect(stripHeredocs(input)).toBe(input);
  });

  /** Оболочка названа по ссылке и в аргументе обёртки: читатель — та же оболочка. */
  it.each(['sudo $SHELL', 'env $0', 'nohup "$BASH"', 'exec ${ZSH_NAME}'])(
    'keeps the body when a wrapper is given the shell by reference: %s',
    (line) => {
      const input = script([`${line} <<'EOF'`, 'git commit --no-verify', 'EOF']);
      expect(stripHeredocs(input)).toBe(input);
    },
  );

  /** Читатель — буквальное командное слово: аргументы и цели редиректа раскрываться могут. */
  it.each([
    'cat <<\'EOF\' | grep "$PATTERN"',
    'cat <<\'EOF\' > "$OUT"',
    "cat <<'EOF' $(pwd) *.md",
    "FOO=bar cat <<'EOF'",
    "2>/dev/null cat <<'EOF'",
    "time cat <<'EOF'",
  ])('still cuts the body when only arguments expand: %s', (line) => {
    const input = script([line, 'echo x > tools/a.json', 'EOF']);
    expect(stripHeredocs(input)).toBe(`${line}\n`);
  });

  /**
   * e45 (ревью, раунд 3): время разбора растёт не быстрее длины команды — иначе длинная команда переживает
   * таймаут хука, а таймаут пропускает команду. Границу по времени держит канарейка настоящего хука.
   */
  it('answers on a command that piles up heredocs, frames and lines', () => {
    const piled = `cat${'<<EOF '.repeat(400)}${'$('.repeat(400)}${'\n'.repeat(2_000)}git commit --no-verify`;
    expect(stripHeredocs(piled)).toBe(piled);
  });
});

describe('splitCommands: кавычки и `&` перенаправления не разрывают команду (e50)', () => {
  const cases: [string, string[]][] = [
    ['pnpm test -- -u', ['pnpm test -- -u']],
    ['cd apps/web && pnpm test -- -u', ['cd apps/web ', ' pnpm test -- -u']],
    ['pnpm test || pnpm test -- -u', ['pnpm test ', ' pnpm test -- -u']],
    ['pnpm test -- -u | tee log', ['pnpm test -- -u ', ' tee log']],
    ['git checkout main file 2>&1', ['git checkout main file 2>&1']],
    ['git checkout main file &>log', ['git checkout main file &>log']],
    ['git checkout -m "a; b" -- file', ['git checkout -m "a; b" -- file']],
    ['git checkout -m "a; b" -- file; echo done', ['git checkout -m "a; b" -- file', ' echo done']],
    [
      "git commit -m 'a | b' && git checkout main -- file",
      ["git commit -m 'a | b' ", ' git checkout main -- file'],
    ],
    ['git checkout main \\\n -- file', ['git checkout main \\\n -- file']],
  ];
  for (const [command, expected] of cases) {
    it(`"${command}" → ${JSON.stringify(expected)}`, () => {
      expect(splitCommands(command)).toEqual(expected);
    });
  }

  it('commandWords: «клей» оболочки по краям слова — не часть слова', () => {
    expect(splitCommands('{ pnpm test -- -u; }').map(commandWords)).toEqual([
      ['pnpm', 'test', '--', '-u'],
      [],
    ]);
    expect(commandWords('$(git checkout main -- file)')).toEqual([
      'git',
      'checkout',
      'main',
      '--',
      'file',
    ]);
  });
});

describe('withoutGitGlobalOptions (e50)', () => {
  const cases: [string, string][] = [
    ['git -C ../other push -f', 'git push -f'],
    ['git -C "my dir" -c user.name=x push --force', 'git push --force'],
    ['git --git-dir=. push -f', 'git push -f'],
    ['git --work-tree . status', 'git status'],
    ['/usr/bin/git -C dir commit -n -m x', '/usr/bin/git commit -n -m x'],
    ['git status', 'git status'],
    ['git commit -m "task/e50"', 'git commit -m "task/e50"'],
  ];
  for (const [command, expected] of cases) {
    it(`"${command}" → "${expected}"`, () => {
      expect(withoutGitGlobalOptions(command)).toBe(expected);
    });
  }
});

describe('updatesSnapshots (e50)', () => {
  const cases: [string, boolean][] = [
    ['pnpm test -- -u', true],
    ['pnpm test -u', true],
    ['pnpm --filter @repo/ui test -- -u', true],
    ['./node_modules/.bin/playwright test -u', true],
    ['npm test -- --updateSnapshot', true],
    ['pnpm test -- --reporter=verbose', false],
    ['git push -u origin task/e50', false],
    ['curl -sSf -u "$USER:$TOKEN" https://example.com', false],
    ['sort -u test', false],
    ['pnpm test:count:update', false],
  ];
  for (const [command, expected] of cases) {
    it(`"${command}" → ${expected}`, () => {
      expect(updatesSnapshots(commandWords(command))).toBe(expected);
    });
  }
});

describe('checkoutOverwritesPaths (e50)', () => {
  const cases: [string, boolean][] = [
    ['git checkout -- file', true],
    ['git checkout HEAD -- tools/protected-paths.json', true],
    ['git checkout main file', true],
    ['git checkout HEAD --pathspec-from-file=list.txt', true],
    ['git checkout main --', false],
    ['git checkout -b task/e50 origin/main', false],
    ['git checkout --orphan new main', false],
    ['git checkout --detach origin/main', false],
    ['git checkout other-branch', false],
  ];
  for (const [command, expected] of cases) {
    it(`"${command}" → ${expected}`, () => {
      expect(checkoutOverwritesPaths(commandWords(command))).toBe(expected);
    });
  }
});
