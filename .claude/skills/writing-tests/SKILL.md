---
name: writing-tests
description: Testing policy for this repo — which level to test at (unit, component browser tests, E2E, visual, perf, mutation), selector rules, isolation of parallel E2E, and what makes a test meaningful. Use whenever writing or changing tests.
---

# Writing tests

## Какой уровень

| Что проверяем                               | Уровень                  | Где                                  | Инструмент                                                  |
| ------------------------------------------- | ------------------------ | ------------------------------------ | ----------------------------------------------------------- |
| Схемы, чистые функции, доменная логика      | unit                     | рядом с кодом, `*.test.ts`           | Vitest (node)                                               |
| API: процедуры, ошибки, валидация, HTTP     | integration (in-process) | `apps/api/src/*.test.ts`             | Vitest + `app.request()` / oRPC-клиент с `fetch: app.fetch` |
| Компонент: поведение, a11y, состояния       | component                | `*.test.tsx`                         | Vitest browser mode (реальный Chromium)                     |
| Внешний вид компонента                      | visual                   | `<Component>.visual.test.tsx`        | `toMatchScreenshot` (только в Docker)                       |
| Пользовательский сценарий через всю систему | E2E                      | `e2e/features/<feature>/*.spec.ts`   | Playwright                                                  |
| Внешний вид страницы                        | visual                   | `e2e/features/<feature>/*.visual.ts` | `toHaveScreenshot` (только в Docker)                        |
| Скорость загрузки и сценариев               | perf                     | `e2e/perf/*.perf.ts`                 | Playwright + бюджеты                                        |
| Ловят ли тесты ошибки                       | mutation                 | `pnpm mutation`                      | StrykerJS                                                   |

Правило: проверяй на самом низком уровне, где поведение наблюдаемо. E2E отвечают за то, что части системы правильно соединены, а не за перебор всех случаев.

## Хороший тест

- Одно поведение на тест, имя описывает поведение («toggles a task and keeps the state after reload»).
- Arrange / Act / Assert разделены пустой строкой.
- Проверяет наблюдаемый результат, а не детали реализации.
- Граничные случаи: пусто, максимум, максимум+1, ошибка сервера, неизвестный id.
- Чинишь баг — сначала напиши падающий тест.

## Селекторы

`getByRole(role, { name })` → `getByLabel` → `getByText` → `getByTestId` (только когда семантики нет). CSS и XPath запрещены. Если элемент нельзя найти по роли, это проблема доступности: чини компонент.

## E2E

- `features/` выполняются параллельно против одного API. Используй `uniqueTitle()` из `fixtures.ts`, не проверяй порядок и общее количество.
- Тестам, которым нужны фиксированные данные (visual, perf), нужны `seedTasks()` и `{ lock: SHARED_DATA_LOCK }`.
- Никаких `waitForTimeout`. Жди состояние: `expect(...).toBeVisible()`, `toBeEnabled()`.
- `@critical` в названии означает продуктовый инвариант. Такие тесты идут и в merge queue.
- Видео прогона как доказательство: `VIDEO=on pnpm e2e`.

## Запрещено

`.only`, `.skip`, `.fixme`, `test.fail`, `it.todo` (гейт `test-integrity`), ослабление проверок ради зелёного прогона, обновление скриншот-базлайнов, повышение порогов покрытия и мутаций.

## Отладка падений

- `pnpm exec playwright test --debug=cli` подключает агента к упавшему тесту.
- `pnpm exec playwright trace open <trace.zip>`, затем `actions`, `requests`, `console`, `snapshot <id>` — разбор трейса без GUI.
- `--repeat-each=10` перед тем, как объявить тест стабильным.
