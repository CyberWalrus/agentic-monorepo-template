/** Unit-тесты разбора shell-команд (tools/analyze-command.ts): цели записи и учёт cd. */
import { describe, expect, it } from 'vitest';

import { repoWriteTargets, stripHeredocs, tokenize, writeTargets } from '../analyze-command.ts';

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
});
