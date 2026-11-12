---
name: visual-diff-triage
description: How to triage failing screenshot tests (Vitest toMatchScreenshot and Playwright toHaveScreenshot) — read the diffs, classify as intended, regression or flaky, fix code for regressions, and hand intended changes to a human. Baselines are never updated by agents. Use when pnpm visual or the CI visual job fails.
---

# Visual diff triage

Пиксельный дифф решает, ты только разбираешь результат. VLM пропускают больше половины мелких UI-изменений (бенчмарк DiffSpot), поэтому «на глаз выглядит так же» не аргумент.

## Где диффы

- Локально после `pnpm visual`: `reports/visual/`
  - страницы: `e2e/playwright-report/` (HTML-отчёт с expected / actual / diff), `e2e/test-results/**/*-diff.*`
  - компоненты: `packages/ui/.vitest/attachments/`
- В CI это артефакт `visual-report` у job `visual`.

## Триаж

Для каждого упавшего скриншота открой expected, actual и diff и определи класс:

| Класс          | Признаки                                                                | Действие                                                                                                                             |
| -------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **regression** | Изменение, которого нет в задаче: сдвиг, другой цвет, пропал элемент    | Исправь код (CSS, разметку). Перезапусти `pnpm visual`                                                                               |
| **intended**   | Изменение прямо следует из задачи                                       | Не трогай базлайн. В PR опиши, какие скриншоты и почему меняются. Человек проверит и обновит базлайны сам                            |
| **flaky**      | Дифф в разных местах между прогонами, анимации, время, случайные данные | Сделай тест детерминированным: фиксированные данные (`seedTasks`), ожидание гидратации, `animations: 'disabled'`. Не повышай допуски |

## Запрещено

Любое обновление базлайнов (скрипт обновления, флаги update у Playwright и Vitest), правка файлов в `__screenshots__`, повышение `maxDiffPixels` / `threshold`. Всё это заблокировано хуками и CI.
