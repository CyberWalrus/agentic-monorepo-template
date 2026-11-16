# Состояние настройки GitHub (репозиторий шаблона)

> Dev-only файл: в проект не едет — попадает в `_exclude` `copier.yml` (задача d8.2). Ссылаться на него может только документ, который сам не едет в проект (сейчас — [roadmap.md](roadmap.md)): ссылка из едущего документа сломала бы `docs:check` в копии, где этого файла нет. Инструкция настройки без состояния — [github-setup.md](github-setup.md).

Состояние на 2026-11-16: пункты 1–3 и 7 инструкции выполнены, отмечены ✅.

## 1. ✅ Ruleset для `main`

Создан в UI (Settings → Rules → Rulesets, id `27137353`) по снимку `.github/rulesets/main.json`.

Merge queue для этого репозитория недоступна (пункт тарифа) — включается, когда появится.

## 2. ✅ Labelы для гейтов

Созданы: `gate-change-approved` и `nightly-failure`.

## 3. ✅ Политика исполнения workflow (pull_request_target)

Создана (Settings → Actions → Policies, id `13436`, Active): таргет — только `.github/workflows/gate-integrity.yml`, события — `pull_request_target` и `merge_group`.

## 7. ✅ Ruleset для тегов `v*`

Создан 2026-11-16 (id `27351411`, Active): таргет — `tag`, условие `refs/tags/v*`, правила `update` и `deletion`, `bypass_actors` пуст — обойти нельзя никому, включая админа. Создан не в интерфейсе, а REST API (`gh api …/rulesets -X POST`) из payload снимка `.github/rulesets/tags-v.json` — по прямому поручению человека «сделай сам» (d8.5, вместо ручного действия из `needs_human`; GET вернул структуру снимка без отличий).

Доказательства защиты (на временном теге `v0.0.0-probe`, созданном до включения защиты): удаление — HTTP 422 «Cannot delete this tag»; перестановка — GH013 «Cannot update this protected ref»; создание нового тега `v*` при активном ruleset проходит — создание не ограничено. Пробные теги удалены через короткое окно `enforcement: disabled`, ruleset возвращён в `active`.

Что дальше: первый тег `v0.1.0` (d8.6) — после merge d8.4 и этой задачи и зелёной канарейки копии (d8.3).

## CODEOWNERS

Владелец шаблона — `@CyberWalrus` (в копию едет рендер с владельцем проекта — d8.2).
