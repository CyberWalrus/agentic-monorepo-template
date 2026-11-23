/**
 * Канарейки guard-bash (roadmap A2, пункт 6): таблица известных обходов становится
 * тестовыми случаями. Хук запускается как subprocess с подставным stdin — команды
 * из тестов не исполняются, хук только анализирует их.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const projectDir = resolve(import.meta.dirname, '..', '..');
const hook = `${projectDir}/.claude/hooks/guard-bash.ts`;

interface HookResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runGuard(command: string, cwd: string = projectDir): HookResult {
  const input = JSON.stringify({
    session_id: 'test',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    cwd,
  });
  const result = spawnSync(process.execPath, [hook], {
    cwd: projectDir,
    input,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  });
  if (result.error) {
    throw result.error;
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function deniedIn(result: HookResult): boolean {
  return result.stdout.includes('"permissionDecision":"deny"');
}

/** Должны блокироваться: таблица обходов из аудита A2 + уже работавшие запреты. */
const MUST_DENY: string[] = [
  // обновление базлайнов коротким флагом (audit: playwright test -u)
  'pnpm exec playwright test -u',
  // пропуск git-хуков
  'git commit -n -m x',
  'git -c core.hooksPath=/dev/null commit -m x',
  'LEFTHOOK=false git commit -m x',
  'LEFTHOOK_EXCLUDE=pre-commit git commit -m x',
  // запись в защищённый файл после смены каталога (cd/pushd учитываются)
  'cd tools && echo x > protected-paths.json',
  'cd tools; echo x > protected-paths.json',
  'pushd tools && echo x > protected-paths.json',
  // цель редиректа вне тела heredoc
  'cat > tools/protected-paths.json <<EOF\ncontent\nEOF',
  // force-push через refspec; --force-with-lease тоже переписывает историю
  'git push origin +HEAD:main',
  'git push --force-with-lease origin main',
  // уже работавшие запреты — регрессионная страховка
  'git commit --no-verify -m x',
  'LEFTHOOK=0 git commit -m x',
  'HUSKY=0 git commit -m x',
  'git push -f origin main',
  'git push origin --force main',
  'git reset --hard origin/main',
  'pnpm visual:update',
  'VISUAL_UPDATE=1 pnpm visual',
  'pnpm exec playwright test --update-snapshots',
  'pnpm exec vitest run -u',
  'echo x > tools/protected-paths.json',
  'sed -i "s/a/b/" tools/protected-paths.json',
  'echo secret | tee tools/protected-paths.json',
  'rm tools/protected-paths.json',
  'cp /tmp/evil.json tools/protected-paths.json',
  'mv tools/protected-paths.json /tmp/stolen.json',
  // e45: heredoc, поданный интерпретатору, — команды; тело проверяется правилами
  "bash <<'EOF'\ngit commit --no-verify\nEOF",
  'sh <<EOF\ngit push --force origin main\nEOF',
  "zsh -s <<'EOF'\npnpm exec playwright test -u\nEOF",
  "node <<'EOF'\nexecSync('git commit --no-verify')\nEOF",
  "python3 - <<'EOF'\nsubprocess.run('git push --force', shell=True)\nEOF",
  "eval $(cat <<'EOF'\ngit commit --no-verify\nEOF\n)",
  // конвейер: cat печатает тело, bash исполняет
  "cat <<'EOF' | bash\ngit commit --no-verify\nEOF",
  // запись в защищённый файл из тела, которое исполняет bash
  "bash <<'EOF'\necho x > tools/protected-paths.json\nEOF",
  // e45: фальшивый фрейм — `<<` в кавычках, в комментарии и here-string оператором не считается
  'echo "<<END"\ngit commit --no-verify\nEND',
  '# cat <<EOF\ngit commit --no-verify\nEOF',
  'cat <<<EOF\ngit commit --no-verify\nEOF',
  // e45 (ревью): `.` — синоним `source`
  ". /dev/stdin <<'EOF'\ngit commit --no-verify\nEOF",
  // e45 (ревью): `}` внутри `$( … )` — не граница `${…}`, `<<EOF` — часть слова
  'echo ${u:-$(echo })<<EOF;}\ngit commit --no-verify\nEOF',
  // e45 (ревью): строка-оператор продолжается на следующих строках — оболочка начинает тело позже
  "cat <<'EOF' $(echo a;\ngit commit --no-verify)\nbody\nEOF",
  "cat <<'EOF' $(echo a;\necho x > tools/protected-paths.json)\nbody\nEOF",
  "cat <<'EOF' >/dev/null && { echo a;\ngit push --force origin main; }\nbody\nEOF",
  // e45: обратные кавычки на строке-операторе; `#` после `$( … )` — не комментарий
  "cat <<'EOF' `\ngit commit --no-verify`\nbody\nEOF",
  "cat <<'EOF' $(echo a)#b$(\ngit commit --no-verify\n)\nbody\nEOF",
  // e45: `<<` внутри `[[ ]]` и в шаблоне `case` — не оператор; разделитель раскрывается в рантайме
  '[[ $a == x<<EOF ]]\ngit commit --no-verify\nEOF',
  'case $x in a<<EOF)\ngit commit --no-verify\nEOF',
  "D=EOF && cat <<$D\ncat <<'A'\nEOF\ngit commit --no-verify\nA",
];

for (const command of MUST_DENY) {
  it(`blocks: ${command}`, () => {
    const result = runGuard(command);
    expect(
      deniedIn(result),
      `expected deny for: ${command}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    ).toBe(true);
  });
}

/** Должны проходить: ложные срабатывания из аудита + безобидные команды. */
const MUST_PASS: string[] = [
  // запись в одноимённый файл вне репозитория (ложное срабатывание из аудита)
  'cd /tmp && echo x > .oxlintrc.json',
  // -n у git log — это max-count, не --no-verify
  'git log -n 5',
  'git log -n5 --oneline',
  'echo hello',
  'git status',
  'pnpm verify',
  'pnpm verify --full',
  'echo x > README.md',
  'cd apps/web && echo x > package.json',
  // e45: запись файла через heredoc — тело-данные правила не читают
  "cat > README.md <<'EOF'\n# Title\nbody\nEOF",
  "cat <<'EOF' > docs/notes.md\nThe marker EOF ends the block\nEOF\necho done",
  'cat <<EOF > /tmp/notes.md\nLEFTHOOK=0 is forbidden\nEOF',
  // e45 (ревью): строка-оператор кончилась там, где её видит оболочка — тело по-прежнему данные
  "cat <<'EOF' $(echo a; echo b)\nLEFTHOOK=0 is forbidden\nEOF",
  "{ cat <<'EOF' > /tmp/notes.md; }\nLEFTHOOK=0 is forbidden\nEOF",
  "(cat <<'EOF' > /tmp/notes.md )\nLEFTHOOK=0 is forbidden\nEOF",
  'echo "$((1 + 2))" && cat <<\'EOF\' > /tmp/notes.md\nLEFTHOOK=0 is forbidden\nEOF',
  'echo "${VAR:-x}" && cat <<\'EOF\' > /tmp/notes.md\nLEFTHOOK=0 is forbidden\nEOF',
  "git add . && cat <<'EOF' > /tmp/notes.md\nLEFTHOOK=0 is forbidden\nEOF",
];

for (const command of MUST_PASS) {
  it(`allows: ${command}`, () => {
    const result = runGuard(command);
    expect(
      deniedIn(result),
      `expected pass for: ${command}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    ).toBe(false);
    // отрицательный контроль обязан быть строгим: «разрешил» ≠ «хук упал»
    expect(result.status, `expected exit 0 for: ${command}\nstderr: ${result.stderr}`).toBe(0);
  });
}

/** Сверхдлинный вход не анализируется и закрывает команду (защита от ReDoS-таймаута). */
it('blocks an oversized command instead of analyzing it', () => {
  const result = runGuard(`echo ${'x'.repeat(70_000)} > tools/protected-paths.json`);
  expect(deniedIn(result)).toBe(true);
});

/** Битый stdin закрывает хук (exit 2): код 1 Claude Code считает неблокирующим. */
it('fails closed on malformed stdin', () => {
  const result = spawnSync(process.execPath, [hook], {
    cwd: projectDir,
    input: 'not json',
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  });
  expect(result.status, `stderr: ${result.stderr}`).toBe(2);
  expect(result.stderr).toContain('guard-bash');
});

/** Отказ хука объясняет себя (З11): в deny-ответе есть причина. */
it('deny decision carries a reason', () => {
  const result = runGuard('echo x > tools/protected-paths.json');
  expect(result.stdout).toMatch(/"permissionDecisionReason":"[^"]{10,}"/);
});
