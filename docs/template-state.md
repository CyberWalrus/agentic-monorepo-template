# Состояние настройки GitHub (репозиторий шаблона)

> Dev-only файл: в проект не едет — попадает в `_exclude` `copier.yml` (задача d8.2). Ссылаться на него может только документ, который сам не едет в проект (сейчас — [roadmap.md](roadmap.md)): ссылка из едущего документа сломала бы `docs:check` в копии, где этого файла нет. Инструкция настройки без состояния — [github-setup.md](github-setup.md).

Состояние на 2026-11-12: пункты 1–3 инструкции выполнены, отмечены ✅.

## 1. ✅ Ruleset для `main`

Создан в UI (Settings → Rules → Rulesets, id `27137353`) по снимку `.github/rulesets/main.json`.

Merge queue для этого репозитория недоступна (пункт тарифа) — включается, когда появится.

## 2. ✅ Labelы для гейтов

Созданы: `gate-change-approved` и `nightly-failure`.

## 3. ✅ Политика исполнения workflow (pull_request_target)

Создана (Settings → Actions → Policies, id `13436`, Active): таргет — только `.github/workflows/gate-integrity.yml`, события — `pull_request_target` и `merge_group`.

## Ruleset для тегов `v*`

Не создан: снимок появится в d8.4, ruleset в интерфейсе создаст человек (d8.5), отметку о выполнении занести сюда (d8.5, d8.6 — тег `v0.1.0`).

## CODEOWNERS

Владелец шаблона — `@CyberWalrus` (в копию едет рендер с владельцем проекта — d8.2).
