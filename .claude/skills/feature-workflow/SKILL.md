---
name: feature-workflow
description: End-to-end workflow for building a feature or changing product behaviour in this monorepo — plan with acceptance criteria, plan review, contract-first API, UI, tests at the right levels, verify, reviewer agents, PR with evidence. Use for any new feature or non-trivial behaviour change.
---

# Feature workflow

Цель: фича проходит все гейты с первого PR, и ни один гейт не ослаблен.

## 1. План (до кода)

Запиши в ответе или в `e2e/specs/<feature>.md`:

- **Что и зачем** — 2–3 предложения.
- **Критерии приёмки** — проверяемые утверждения («пользователь видит X после Y»). Каждый критерий потом станет тестом.
- **Затронутые слои**: contracts / api / ui / web feature / e2e / perf.
- **Чего не делаем** (scope).

Для нетривиального изменения запусти параллельно `architecture-reviewer` и `sanity-reviewer`, передав им план. Блокеры исправь до кода.

## 2. Контракт (если меняется API)

Следуй скилу `api-contract-change`. Коротко: `packages/contracts/src/<domain>.ts` → `pnpm --filter @repo/contracts openapi` → реализация в `apps/api/src/<module>/` + `router.ts` → тесты репозитория и транспорта.

## 3. UI

- Переиспользуемый визуальный элемент кладётся в `packages/ui/src/<component>/`: компонент, CSS module, `*.test.tsx` (поведение, a11y), сценарий в `<Component>.visual.test.tsx` рядом с компонентом. Никакого домена и API.
- Экран и логика лежат в `apps/web/src/features/<feature>/`. Данные через TanStack Query (`orpc.<domain>.<proc>.queryOptions()`), мутации с инвалидацией после последней мутации (образец: `features/tasks/use-tasks.ts`).
- До гидратации контролы `disabled` (`useHydrated` из `src/lib`).
- Состояния: пусто / загрузка / ошибка / успех. Каждое видно пользователю и проверено тестом.

## 4. Тесты

Следуй скилу `writing-tests`. Минимум:

- unit на доменную логику и схемы;
- поведенческие тесты компонентов (Vitest browser mode);
- E2E в `e2e/features/<feature>/` на каждый критерий приёмки; критичный пользовательский путь помечается `@critical`;
- новая страница или ключевой сценарий: попроси человека добавить бюджет в `perf-budgets.json` (сам файл не трогай) и напиши перф-тест по образцу `e2e/perf/tasks.perf.ts`.

## 5. Проверка

```bash
pnpm verify --full
```

Если менялся UI, запусти `pnpm visual`. Упавшие диффы разбери по скилу `visual-diff-triage`. Ожидаемые изменения перечисли в PR, базлайны обновит человек.

Если менялась доменная логика API, запусти `pnpm mutation` и убей выживших мутантов тестами.

## 6. Ревью агентами

Запусти параллельно `test-quality-reviewer`, `security-reviewer`, `product-logic-reviewer` (и `architecture-reviewer`, если менялась структура). Передай им критерии приёмки и `git diff main...HEAD`. Блокеры исправь. Спорное вынеси пользователю.

## 7. PR

Заполни шаблон PR: что сделано, критерии приёмки → какими тестами покрыты, как проверено, доказательства (`VIDEO=on pnpm e2e` → видео из `e2e/test-results`, отчёты из `reports/`), ожидаемые визуальные изменения.
