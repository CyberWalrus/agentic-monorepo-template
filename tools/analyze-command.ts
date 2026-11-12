/**
 * Разбор shell-команды: в какие файлы она пишет.
 *
 * Это подсказка агенту (З3: быстрый разбор способа), а не граница безопасности —
 * границей является проверка по результату и gate-integrity из доверенной базы.
 * Модуль не имеет внешних зависимостей: хуки агента не имеют права падать
 * из-за отсутствующего node_modules (З4).
 */
import { isAbsolute, relative, resolve } from 'node:path';

/** Тела heredoc — это данные (текст файла), а не команды: не проверяем их. */
export function stripHeredocs(command: string): string {
  return command.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\n|$)/g, '<<HEREDOC');
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
