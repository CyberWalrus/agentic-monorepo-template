/** Unit-тесты разбора shell-команд (tools/analyze-command.ts): цели записи и учёт cd. */
import { describe, expect, it } from 'vitest';

import { repoWriteTargets, stripHeredocs, tokenize, writeTargets } from '../analyze-command.ts';

const REPO = '/repo';

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
  it('replaces heredoc bodies, so their content is not parsed as commands', () => {
    const command = ['cat <<EOF', 'echo x > tools/a.json', 'EOF', 'echo done'].join('\n');
    expect(repoWriteTargets(stripHeredocs(command), REPO, REPO)).toEqual([]);
  });
});
