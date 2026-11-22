# Состояние настройки GitHub (репозиторий шаблона)

> Dev-only файл: в проект не едет — попадает в `_exclude` `copier.yml` (задача d8.2). Ссылаться на него может только документ, который сам не едет в проект (сейчас — [roadmap.md](roadmap.md)): ссылка из едущего документа сломала бы `docs:check` в копии, где этого файла нет. Инструкция настройки без состояния — [github-setup.md](github-setup.md).

Состояние на 2026-11-22: пункты 1–3, 7 и 8 инструкции выполнены, отмечены ✅; a9.1 довыполнена (strict в ruleset `main`, авто-удаление веток, чистка origin — раздел 9).

### Реестр живых правил (a11 — парсится tools/check-ruleset-drift.ts)

| id       | снимок                       |
| -------- | ---------------------------- |
| 27137353 | .github/rulesets/main.json   |
| 27351411 | .github/rulesets/tags-v.json |

Ночной чек дрейфа сверяет живой ruleset с этими снимками; изменение живого правила в интерфейсе — обнови id/снимок в этом реестре тем же PR, что меняет снимок.

## 1. ✅ Ruleset для `main`

Создан в UI (Settings → Rules → Rulesets, id `27137353`) по снимку `.github/rulesets/main.json`.

Строгая база включена 2026-11-22 (a9.1): `strict_required_status_checks_policy: true` («Require branches to be up to date before merging») — живой ruleset приведён к снимку PUT-ом через REST API из payload снапшота, по прямому поручению человека в чате («сам это сделай» в адрес списка человеческих действий; прецедент — раздел 7, d8.5). Чекер дрейфа (a11) после переворота зелёный: живой ruleset ≡ снимок.

Merge queue для этого репозитория недоступна (пункт тарифа) — включается, когда появится.

## 2. ✅ Labelы для гейтов

Созданы: `gate-change-approved` и `nightly-failure`.

## 3. ✅ Политика исполнения workflow (pull_request_target)

Создана (Settings → Actions → Policies, id `13436`, Active): таргет — только `.github/workflows/gate-integrity.yml`, события — `pull_request_target` и `merge_group`.

## 7. ✅ Ruleset для тегов `v*`

Создан 2026-11-16 (id `27351411`, Active): таргет — `tag`, условие `refs/tags/v*`, правила `update` и `deletion`, `bypass_actors` пуст — обойти нельзя никому, включая админа. Создан не в интерфейсе, а REST API (`gh api …/rulesets -X POST`) из payload снимка `.github/rulesets/tags-v.json` — по прямому поручению человека «сделай сам» (d8.5, вместо ручного действия из `needs_human`; GET вернул структуру снимка без отличий).

Доказательства защиты (на временном теге `v0.0.0-probe`, созданном до включения защиты): удаление — HTTP 422 «Cannot delete this tag»; перестановка — GH013 «Cannot update this protected ref»; создание нового тега `v*` при активном ruleset проходит — создание не ограничено. Пробные теги удалены через короткое окно `enforcement: disabled`, ruleset возвращён в `active`.

Что дальше: первый тег `v0.1.0` (d8.6) — поставлен, см. раздел 8.

## 8. ✅ Тег `v0.1.0` (d8.6)

Поставлен 2026-11-19 на `848ad4b` (squash-мёрж #65 — канарейка копии d8.3 и фикс доверенного workflow; `gate` на push зелёный): состояние main с рабочим `copier.yml` и зелёной канарейкой копии. Аннотированный тег `58641d0`; ruleset тегов `v*` (d8.5) защищает от перестановки и удаления. Мёрж #65 выполнен через разовое bypass-окно ruleset `main` — доверенные job-ы были сломаны на main невалидным `gh pr view --json pushedAt` (ехало в #63, впервые исполнилось на #65); ruleset снят и восстановлен байт-в-байт, окно ~2 минуты, детали в журнале d8.3.

Проба из тега (человек; PyPI вне allowlist песочницы, З5-исключение — CI гоняет идентичный цикл из HEAD):

```sh
pipx install --force copier==$(cat tools/copier-version.txt)
copier copy gh:CyberWalrus/agentic-monorepo-template /tmp/probe-v0.1.0 --vcs-ref=v0.1.0 \
  -d project_name=probe-v010 -d repo_owner=@CyberWalrus
cd /tmp/probe-v0.1.0 && pnpm install && pnpm verify
```

Результат пробы — в «Журнал» задачи d8.6.

## Канарейка копии (d8.3)

Живёт в `pnpm canaries` (хвост скрипта) и в CI: canaries.yml — по изменению `copier.yml`, `.github/rulesets/**`, пары CODEOWNERS и `tools/copier-version.txt` — и в nightly. Из песочницы агента не запускается: copier ставится из PyPI, вне allowlist доменов (ADR 0004; З5-исключение — [architecture.md](architecture.md)). Локальный прогон человеком:

1. `pipx install --force copier==$(cat tools/copier-version.txt)` — версия из одного источника (З10); `--force` переустанавливает при смене пина.
2. Закоммитить работу — канарейка копирует закоммиченный HEAD (`--vcs-ref=HEAD`).
3. `pnpm canaries` — в хвосте: `copier copy`, проверка содержимого копии, `pnpm install && pnpm verify` в ней.

## CODEOWNERS

Владелец шаблона — `@CyberWalrus` (в копию едет рендер с владельцем проекта — d8.2).

## 9. ✅ Авто-удаление веток и чистка origin (a9.1)

Включено 2026-11-22 (a9.1): «Automatically delete head branches» = `delete_branch_on_merge: true` (REST API PATCH репозитория, по прямому поручению человека в чате — прецедент раздела 7). Строгая база — в разделе 1. Origin почищен от смёрженных веток задач: 37 веток `task/*`, `chore/*`, `fix/*` удалены API-ом; открытые PR не тронуты; `task/evil-probe` и `task/evil-touches-probe` — рабочие пробные ветки копийных канареек, не удалять.
