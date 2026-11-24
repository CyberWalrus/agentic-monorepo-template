# Песочница × `pnpm install`: где pnpm 12.21.0 держит блокировки хранилища

Задача e70 (ADR 0004). Дата прогонов: 2026-11-24, 20:37–21:55 MSK. База: `b8e50d72`; прогон «P4 после правки» — на ветке после слияния `origin/main` (`6a178952`) с незакоммичённой правкой preflight.

**Итог.** `allowWrite: ["~/Library/pnpm/store"]` не открывал блокировку хранилища потому, что pnpm 12.21.0 держит её не в хранилище, а в `/tmp/pnpm-store-operation-locks-<uid>` (на машине прогонов — `/private/tmp/pnpm-store-operation-locks-501`). Каталог блокировок в `allowWrite` не открывался: с ним установка проходит блокировку, но падает на записи файлов пакетов и оставляет проектный `.pnpm-store` с недособранным `node_modules`. Граница записана в ADR 0004 и architecture.md: `pnpm install` из песочечного Bash не поддерживается, зависимости ставит старт сессии агента или человек вне песочницы.

## Условия

| Что              | Значение                                                                                                                                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ОС               | macOS (darwin 25.5.0, arm64), uid 501                                                                                                                                                                                 |
| Node / pnpm      | v26.13.0 / 12.21.0 (`packageManager`); pnpm — нативный бинарник `~/Library/pnpm/.tools/pnpm/12.21.0/node_modules/pnpm/pnpm` (47,9 МБ, внутри строки `pnpm/crates/store-dir/src/…`)                                    |
| Хранилище        | `pnpm store path` → `~/Library/pnpm/store/v11`; `PNPM_HOME=~/Library/pnpm`; `XDG_RUNTIME_DIR` не задан                                                                                                                |
| Claude Code      | 2.1.330, нативный бинарник `~/.local/share/claude/versions/2.1.330`, песочница Seatbelt                                                                                                                               |
| Конфиг песочницы | `.claude/settings.json` на `b8e50d72`: `allowWrite: ["~/Library/pnpm/store"]`, `denyWrite` — 108 записей. База блокировок в песочнице — `/private/tmp` (P2: открытия этого каталога хватило, чтобы пройти блокировку) |
| Копия проекта    | `git archive HEAD package.json pnpm-lock.yaml pnpm-workspace.yaml apps packages e2e \| tar -x -C <каталог>` — без `node_modules`                                                                                      |

## 1. Где pnpm создаёт блокировки хранилища

**Известное из самого pnpm.** `node_modules/pnpm/CHANGELOG.md` установленного 12.21.0, запись 12.8.2 (строка 1611):

> pnpm now creates its store operation locks and other per-user lock files in `$XDG_RUNTIME_DIR` when it points to a directory only the user can write to. Otherwise, pnpm still uses `/tmp` on Linux and macOS. Sandboxes that block writes to `/tmp` can point `XDG_RUNTIME_DIR` at a writable directory [#16390].

То есть каталог блокировок не выводится из `store-dir`: он общий на пользователя и живёт во временном каталоге. Проверено на pnpm 12.21.0 без песочницы (21:40–21:41; минимальный проект с одной зависимостью, бинарник `.tools/pnpm/12.21.0` напрямую — shim без поля `packageManager` даёт 10.29.3):

| Прогон                                                    | Хранилище               | Где появились блокировки                                  |
| --------------------------------------------------------- | ----------------------- | --------------------------------------------------------- |
| `--store-dir <tmp>/alt-store`                             | `<tmp>/alt-store/v11`   | `/private/tmp/pnpm-store-operation-locks-501/<hash>.lock` |
| `XDG_RUNTIME_DIR=<tmp>/xdg` (0700) + другой `--store-dir` | `<tmp>/alt-store2/v11`  | `$XDG_RUNTIME_DIR/pnpm-store-operation-locks-501/`        |
| `PNPM_HOME=<tmp>/pnpm-home`, без `--store-dir`            | `<PNPM_HOME>/store/v11` | `/private/tmp/pnpm-store-operation-locks-501/<hash>.lock` |

Внутри каталога хранилища записей блокировок нет ни в одном прогоне; имя файла блокировки — хеш пути хранилища, поэтому для каждого нового хранилища в `/tmp/…-501` появляется новый `.lock`. `npm_config_store_dir` в окружении не задан.

**Контроль без песочницы (~20:45–20:49).** В копии проекта без `node_modules`:

```sh
pnpm install --frozen-lockfile --ignore-scripts --prefer-offline --offline
```

```text
Scope: all 7 workspace projects
…
Done in 1.5s using pnpm v12.21.0      → exit 0, 598 записей в node_modules/.pnpm
```

Каталоги блокировок в `/private/tmp` после контроля (`ls -la /private/tmp | grep pnpm`):

```text
drwx------@  2 andreypakhomov  wheel      64 Nov 24 20:44 pnpm-dir-locks-501
drwx------@  5 andreypakhomov  wheel     160 Nov 22 12:02 pnpm-store-operation-locks-501
drwx------@  2 andreypakhomov  wheel      64 Nov 24 19:54 pnpm-verify-deps-install-locks-501
```

В `pnpm-store-operation-locks-501` — `09efe768….lock`, `62df7706….lock`, `all-stores.lock` (пустые файлы, 0600; каталог 0700). До контроля каталога с точным именем `pnpm-store-operation-locks` в `/tmp` не было — поэтому его и не находили (журнал b8): у каталога суффикс `-<uid>`, а сообщение ошибки называет только базовое имя.

**Почему `allowWrite` его не покрывает.** Грант — `~/Library/pnpm/store` (развёртка `~` работает: живой прогон P1 ниже, запись в `store/v11/` разрешена). Блокировка лежит в `/private/tmp/pnpm-store-operation-locks-501` — вне гранта и вне корня проекта, а запись в `/tmp` песочница запрещает.

## 2. Эмуляция `sandbox-exec` (20:54–20:55, 21:10)

Профиль собран из `.claude/settings.json` генератором (приложение): запись разрешена в корень проекта и в `allowWrite`, поверх — `denyWrite` (транслятор глоб → regex как в журнале b8: `**/` → `(.*/)?`, `**` → `.*`, `*` → `[^/]*`).

| Прогон | `allowWrite` сверх корня проекта                                        | Результат                                                                                                                                                          |
| ------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B      | `~/Library/pnpm/store` (текущий конфиг)                                 | `exit=1`, `ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK`                                                                                                                 |
| C1     | + `/private/tmp/pnpm-store-operation-locks-501`                         | блокировка пройдена; `[WARN] … cannot be hard linked …`; `ERR_PNPM_NO_OFFLINE_TARBALL` (`--offline`, проектный store пуст)                                         |
| C2, C3 | + `pnpm-dir-locks-501` (+ `pnpm-verify-deps-install-locks-501`)         | то же, что C1                                                                                                                                                      |
| B′     | как B, но копия с уже установленными зависимостями; `--reporter=silent` | `exit=1`, та же ошибка блокировки: pnpm берёт блокировку и при no-op-установке. Ошибка уходит в stderr (205 байт), stdout пуст — команда проверки `pnpm preflight` |

Вывод B:

```text
Scope: all 7 workspace projects
Error: ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK

  × installing dependencies
  ╰─▶ Failed to open the store operation lock at "pnpm-store-operation-locks":
      Operation not permitted (os error 1)
```

Вывод C1 (начало):

```text
[WARN] The store at /Users/andreypakhomov/Library/pnpm/store/v11 is not used because packages cannot be hard linked from it into this project. Using the store at …/run/node_modules/.pnpm-store/v11 instead. Set storeDir to choose the project.
✓ Lockfile passes supply-chain policies (verified 10h ago)
Lockfile is up to date, resolution step is skipped
Error: ERR_PNPM_NO_OFFLINE_TARBALL
```

Эмуляция воспроизводит ошибку владельца запуска дословно; дальше блокировки её профиль не эталон (нет правил для жёстких ссылок), поэтому «после» проверялось живыми прогонами.

## 3. Живые прогоны в Claude Code 2.1.330

**Метод.** Вложенная сессия из корня worktree задачи: модель выполняет ровно одну команду. Вывод ниже — без ANSI-кодов, длинные пути сокращены (`<worktree>`, `<copy>`, `…`).

```sh
env -u CLAUDE_CODE_SESSION_ID -u CLAUDE_PROJECT_DIR -u CLAUDE_SESSION_ID \
  claude -p --permission-mode default --allowedTools Bash --no-session-persistence \
  --output-format json --settings '{"sandbox": <блок sandbox репозитория>}' \
  --debug-file /tmp/e70-cc-<проба>.debug.log \
  'Use the Bash tool exactly once to run this command, then reply with the single word DONE. …'
```

Вариант «после» отличается только `allowWrite` в `--settings`: `["~/Library/pnpm/store", "/private/tmp/pnpm-store-operation-locks-501"]`. Параметры сессий и границы метода:

- Первая попытка в отдельном корне вне репозитория отказала: «this workspace has not been trusted», а режим `auto` через шлюз не работает («Auto mode can't check actions in this session. … your requests go through api.z.ai»). Доверие в `~/.claude.json` не менялось; прогоны пошли из worktree задачи с `--permission-mode default --allowedTools Bash`.
- Восемь запусков `claude -p` (модель шлюза `glm-5.4[1m]`): один отказал на старте, семь выполнили команду — по 2 хода; `total_cost_usd` семи выполненных по оценке Claude Code в сумме ≈ 1,17, стоимость отказавшего не сохранена. Фактический счёт шлюза исполнителю не виден.
- Побочный эффект метода: Stop-хук репозитория в каждой из семи сессий в worktree запускал `tools/verify.ts --json` (`DOCS` в `tools/hooks/stop-verify.ts:32` исключает `backlog/`, а файл задачи перенесён) — 11,1–12,8 с, статус 0. Вывод verify хук не отдаёт; сам исполнитель `pnpm verify` не запускал.
- В отладочном логе каждой сессии три строки «[sandbox] admin sandbox mandate: ignoring … from project/local settings», в том числе «filesystem grants restricted to trusted settings tiers: ignoring 1 sandbox.filesystem.allowWrite …» — игнорируется запись `allowWrite` из `.claude/settings.json` проекта, гранты из `--settings` применяются (P1: запись в хранилище разрешена). Что происходит в доверенном рабочем пространстве владельца — не проверялось (раздел 5).

### P0. До изменения (20:58:51–20:59:21)

`allowWrite` текущего конфига; в копии без `node_modules` — `pnpm install --frozen-lockfile --ignore-scripts --prefer-offline --offline`:

```text
Scope: all 7 workspace projects
Error: ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK

  × installing dependencies
  ╰─▶ Failed to open the store operation lock at "pnpm-store-operation-locks":
      Operation not permitted (os error 1)

exit=1
```

Воспроизведено в настоящей песочнице Claude Code дословно.

### P1 и P2. Пробы записи и установка (21:05:22–21:06:28)

`sh -c ': >> <файл>'` из командного инструмента песочницы:

| Проба записи                                                | P1 (текущий конфиг) | P2 (+ каталог блокировок, + абсолютный путь вне проекта) |
| ----------------------------------------------------------- | ------------------- | -------------------------------------------------------- |
| корень проекта (контроль)                                   | WRITE_OK            | WRITE_OK                                                 |
| `~/Library/pnpm/store/v11/e70-probe.tmp`                    | WRITE_OK            | WRITE_OK                                                 |
| `/private/tmp/pnpm-store-operation-locks-501/e70-probe.tmp` | WRITE_FAIL          | WRITE_OK                                                 |
| `/private/tmp/pnpm-dir-locks-501/e70-probe.tmp`             | WRITE_FAIL          | WRITE_FAIL                                               |
| `/private/tmp/e70-probe.tmp`                                | WRITE_FAIL          | WRITE_FAIL                                               |
| `~/e70-probe.tmp`                                           | WRITE_FAIL          | WRITE_FAIL                                               |
| `~/.cache/e70-probe/allow-test/e70-probe.tmp` (только в P2) | WRITE_FAIL          | WRITE_OK                                                 |

Все отказы — `Operation not permitted`. Установка (`--offline`) в P1 упала на блокировке, как в P0; в P2:

```text
[WARN] The store at /Users/andreypakhomov/Library/pnpm/store/v11 is not used because packages cannot be hard linked from it into this project. Using the store at <worktree>/.pnpm-store/v11 instead. Set storeDir to choose the project.
✓ Lockfile passes supply-chain policies (verified 10h ago)
Lockfile is up to date, resolution step is skipped
Error: ERR_PNPM_NO_OFFLINE_TARBALL

  × installing dependencies
  ╰─▶ Failed to fetch tarball for flatted@3.4.4 from https://registry.npmjs.org/flatted/-/flatted-3.4.4.tgz in offline mode: snapshot not present in local store
exit=1
```

### P4. `pnpm preflight` в песочнице (21:11:07–21:12:08)

Текущий конфиг. `pnpm install --frozen-lockfile --reporter=silent` в копии с уже установленными зависимостями — та же ошибка блокировки, `exit=1`. Настоящий `pnpm preflight` в корне worktree (зависимости в sync: без песочницы та же команда даёт `exit 0`):

```text
  ✓ node — Node v26.13.0 соответствует .nvmrc (26)
  ✓ pnpm — pnpm 12.21.0 соответствует packageManager
  ✗ node_modules — pnpm install --frozen-lockfile завершился с кодом 1
      → исправь: pnpm install
  ✓ git-hooks — хуки Lefthook установлены (/Users/andreypakhomov/github.com/agentic-monorepo-template/.git/hooks)
  ✓ docker — Docker отвечает
  ✓ chromium — Chromium установлен (реестр Playwright)
  ✓ maintenance-mode — режим обслуживания выключен
  ⚠ gh — gh установлен, но не авторизован — pnpm backlog doctor неполен
      → исправь: gh auth login

preflight: FAIL — 2 из 8 проверок требуют внимания
exit=1
```

До правки preflight не падает, но ситуацию не объясняет: причина (`ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK`) остаётся в `result.stderr`, который `checkNodeModules` (`packages/preflight/src/checks.ts` на `b8e50d72`, строки 267–274) не показывает, а предложенный фикс — ровно та команда, которая только что упала.

### P4 после правки preflight (21:54:34–21:55:08)

Правка `packages/preflight/src/checks.ts` (незакоммичённая на момент прогона), конфиг песочницы тот же, метод тот же. Контроль вне песочницы — `pnpm preflight` в том же worktree: `✓ node_modules — node_modules соответствует lockfile`, PASS 8/8. В песочнице:

```text
  ✓ node — Node v26.13.0 соответствует .nvmrc (26)
  ✓ pnpm — pnpm 12.21.0 соответствует packageManager
  ✗ node_modules — ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK: песочница агента не даёт pnpm открыть блокировку хранилища (/tmp/pnpm-store-operation-locks-<uid>) — это не дрейф lockfile, повтор внутри песочницы не поможет (ADR 0004)
      → исправь: pnpm install --frozen-lockfile вне песочницы агента — в своём терминале
  ✓ git-hooks — хуки Lefthook установлены (/Users/andreypakhomov/github.com/agentic-monorepo-template/.git/hooks)
  ✓ docker — Docker отвечает
  ✓ chromium — Chromium установлен (реестр Playwright)
  ✓ maintenance-mode — режим обслуживания выключен
  ⚠ gh — gh установлен, но не авторизован — pnpm backlog doctor неполон
      → исправь: gh auth login

preflight: FAIL — 2 из 8 проверок требуют внимания
exit=1
```

Проверка остаётся красной (уровень `error`: сверить `node_modules` не удалось), сообщение называет причину и выход.

### P3. Жёсткие ссылки и установка с открытым каталогом блокировок (21:14:27–21:14:57)

```text
LINK_OK   store -> project
LINK_OK   inside project root
```

Установка в свежей копии, онлайн (`--frozen-lockfile --ignore-scripts --prefer-offline`):

```text
[WARN] The store at …/Library/pnpm/store/v11 is not used because packages cannot be hard linked from it into this project. Using the store at <worktree>/.pnpm-store/v11 instead.
Packages are cloned from the content-addressable store to the virtual store.
  Content-addressable store is at: <worktree>/.pnpm-store/v11
Downloading @oxlint/binding-darwin-arm64@1.94.0: 0.00 B/5.88 MB
Error:   × installing dependencies
  ╰─▶ failed to import "<worktree>/.pnpm-store/v11/files/14/6ce1b2…" to "<copy>/node_modules/.pnpm/docker-modem@5.0.7_supports-color@7.2.0/node_modules/docker-modem_pacquet-stage_…/.vscode/launch.json": Operation not permitted (os error 1)
exit=1 seconds=2
node_modules/.pnpm entries: 164
136M	<worktree>/.pnpm-store
```

### P5. Прямые пробы файлов пакетов; установка без скрытых сегментов пути (21:16:27–21:19:54)

```text
WRITE_OK   reports/e70-probe/w/a/file.txt
WRITE_FAIL reports/e70-probe/w/a/.gitignore — Operation not permitted
WRITE_FAIL reports/e70-probe/w/a/.eslintignore — Operation not permitted
WRITE_FAIL reports/e70-probe/w/a/.prettierignore — Operation not permitted
WRITE_FAIL reports/e70-probe/w/nm/.pnpm/cpu-features@0.0.10/node_modules/cpu-features/deps/cpu_features/.gitignore — Operation not permitted
WRITE_FAIL reports/e70-probe/w/a/.vscode/launch.json — Operation not permitted
```

Установка в `reports/e70-probe/fresh` (в отличие от P3 — путь без скрытых сегментов) повторила P3: тот же `[WARN]`, тот же отказ на `.vscode/launch.json` пакета `docker-modem`, `exit=1`.

## 4. Выводы

1. **Путь каталога блокировок:** `/tmp/pnpm-store-operation-locks-<uid>` (на macOS — `/private/tmp/…`), рядом `pnpm-dir-locks-<uid>` и `pnpm-verify-deps-install-locks-<uid>`; при `$XDG_RUNTIME_DIR`, доступном только владельцу, — там. К `store-dir` отношения не имеет, поэтому `allowWrite: ["~/Library/pnpm/store"]` его не покрывает.
2. **Блокировка берётся всегда**, в том числе при no-op-установке, — из песочницы падает и `pnpm install`, и проверка `node_modules` в `pnpm preflight`.
3. **Открытие каталога блокировок установку не чинит.** pnpm отказывается от общего хранилища, создаёт проектный `.pnpm-store` (136 МБ), начинает импорт пакетов и падает на `Operation not permitted`: первый отказ — `.vscode/launch.json` пакета `docker-modem` (этого пути нет в `denyWrite` репозитория, его защищает сам Claude Code); прямыми пробами (P5) подтверждены отказы на вложённых `.gitignore`, `.eslintignore`, `.prettierignore` — собственный `denyWrite`. Побочно остаются проектный store и недособранный `node_modules`.
4. **Решение:** `allowWrite` не расширять — открыть каталог блокировок значит заменить быстрый чистый отказ медленным падением с побочными эффектами. Граница записана в ADR 0004 (раздел «`pnpm install` из песочницы») и в architecture.md (3.5): `pnpm install` из песочечного Bash не поддерживается, зависимости ставит старт сессии агента или человек вне песочницы.
5. **Условие возврата** (к расширению `allowWrite` каталогом блокировок): принят вариант A находки 3 задачи b8 (`denyWrite` минус исключения для глобов, совпадающих с файлами пакетов) либо песочница Claude Code перестала защищать пути файлов пакетов; тогда — расширить и повторить живую установку по методике раздела 3. В прогонах e70 установка дошла до записи файлов пакетов — условие возврата к A из журнала b8 наступает, стоит только открыть каталог блокировок; решение по A — отдельная задача режима обслуживания.

## 5. Находки за рамками задачи

- **«admin sandbox mandate».** В отладочном логе всех семи сессий Claude Code 2.1.330 пишет, что игнорирует из настроек проекта (project/local) гранты песочницы: `sandbox.filesystem.allowWrite`, `sandbox.network.allowedDomains`, `allowUnixSockets`, `allowLocalBinding`. Управляемых настроек на машине нет (`managed-settings.json` отсутствует). Проверено только для сессий с `--settings`; в доверенном рабочем пространстве владельца (основной каталог репозитория) не проверялось. Если подтверждается — записи `allowWrite`, `allowedDomains` и `allowUnixSockets` в `.claude/settings.json` для Claude Code 2.1.330 не действуют (в том числе `docker.sock` для `pnpm visual` и `allowLocalBinding` для e2e); это отдельная задача.
- **Жёсткие ссылки.** Прямая проба `ln` из хранилища в проект проходит (P3), а pnpm 12.21.0 сообщает «packages cannot be hard linked from it into this project» и уходит на проектный store. Какую операцию проверяет pnpm и почему она запрещена — не установлено; в эмуляции `sandbox-exec` тот же `[WARN]` без правил для ссылок.
- **Вложенная сессия запускает хуки проекта:** `guard-bash`, `protect-result`, `stop-verify` (с `tools/verify.ts --json`) выполняются штатно. Кто повторяет методику, должен считать, что каждая проба запускает verify в worktree.

## Приложение. Генератор профиля эмуляции

Читает `.claude/settings.json`; аргументы — `<settings.json> <корень проекта> <out.sb> [дополнительные пути allowWrite…]`. Запуск: `sandbox-exec -f <out.sb> pnpm install …` из корня проекта.

```js
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [settingsPath, root, outPath, ...extraAllow] = process.argv.slice(2);
const filesystem = JSON.parse(readFileSync(settingsPath, 'utf8')).sandbox.filesystem;

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Транслятор глоб → regex (журнал b8, находка 3): `**/` → `(.*/)?`, `**` → `.*`,
// `*` → `[^/]*`.
function globToRegex(glob) {
  const absolute = glob.startsWith('/') || glob.startsWith('~') ? glob : join(root, glob);
  let pattern = '';
  for (let index = 0; index < absolute.length; index += 1) {
    if (absolute.startsWith('**/', index)) {
      pattern += '(.*/)?';
      index += 2;
    } else if (absolute.startsWith('**', index)) {
      pattern += '.*';
      index += 1;
    } else if (absolute[index] === '*') {
      pattern += '[^/]*';
    } else if (absolute[index] === '?') {
      pattern += '[^/]';
    } else {
      pattern += escapeRegex(absolute[index]);
    }
  }
  return `^${pattern}$`;
}

const expandHome = (path) => (path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);
const quote = (text) => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const subpath = (path) => `  (subpath ${quote(realpathSync(expandHome(path)))})`;

const lines = [
  '(version 1)',
  '(deny default)',
  '(import "system.sb")',
  '(allow process-exec*)',
  '(allow process-fork)',
  '(allow file-read*)',
  '(allow file-write*',
  subpath(root),
  ...filesystem.allowWrite.map(subpath),
  ...extraAllow.map(subpath),
  ')',
  '(allow network*)',
  ...filesystem.denyWrite.map((glob) => `(deny file-write* (regex #${quote(globToRegex(glob))}))`),
];

writeFileSync(outPath, `${lines.join('\n')}\n`);
```
