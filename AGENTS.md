# AGENTS.md

Инструкции для AI-агентов (и людей) в этом репозитории. Зачем репозиторий существует: [docs/vision.md](docs/vision.md).

Коротко: монорепо frontend + backend, в котором агенты пишут фичи, а детерминированные гейты не пускают в `main` недостаточно хороший код. Твоя задача — довести фичу до зелёного `pnpm verify --full`, не ослабляя ни одного гейта.

## Стек

Node (`.nvmrc`) · pnpm (`packageManager`) · Turborepo · TypeScript · Oxlint + Oxfmt · Vite · React + TanStack Start + TanStack Query · Hono + oRPC + Zod · Vitest (browser mode) · Playwright · dependency-cruiser · Knip · StrykerJS.

Версии зависимостей — только в каталоге `catalog:` в [pnpm-workspace.yaml](pnpm-workspace.yaml). Почему такой стек: [ADR 0001](docs/adr/0001-initial-stack.md).

## Структура

```
apps/api/                Hono + oRPC. src/<module>/ — домен, app.ts/router.ts — HTTP-слой
apps/web/                TanStack Start. src/features/<feature>/ — независимые фичи, src/lib/ — общее
packages/contracts/      oRPC-контракт + Zod-схемы. Единый источник правды API. openapi.json генерируется
packages/ui/             Презентационные React-компоненты. Без домена и транспорта
e2e/                     Playwright: features/ (функциональные), *.visual.ts (скриншоты), perf/ (бюджеты)
tools/                   Гейты: verify, бюджет бандла, защищённые пути, визуальные тесты в Docker
perf-budgets.json        Перф-бюджеты (защищён)
```

## Команды

| Команда                                 | Что делает                                                                  | Когда                          |
| --------------------------------------- | --------------------------------------------------------------------------- | ------------------------------ |
| `pnpm verify`                           | Формат, линт, типы, unit, границы, мёртвый код, дрейф OpenAPI (~2–5 с, кэш) | После каждого логического шага |
| `pnpm verify --full`                    | + сборка, бюджет бандла, E2E, перф-бюджеты (~10–30 с)                       | Перед PR                       |
| `pnpm verify --json`                    | То же, машиночитаемо                                                        | Агентам и хукам                |
| `pnpm --filter <pkg> test`              | Тесты одного пакета                                                         | Во время разработки            |
| `pnpm e2e` / `pnpm perf`                | E2E / перф-бюджеты (собирает web)                                           | При изменении поведения или UI |
| `pnpm visual`                           | Скриншот-тесты в Docker (как в CI)                                          | При изменении UI               |
| `pnpm mutation`                         | Мутационное тестирование API                                                | При изменении доменной логики  |
| `pnpm --filter @repo/contracts openapi` | Перегенерировать openapi.json                                               | После изменения контракта      |
| `pnpm format` / `pnpm lint:fix`         | Автоисправление                                                             | Когда линт или формат красные  |

Окружение: `nvm use` (версия в `.nvmrc`), pnpm из `packageManager`.

## Как делать фичу

Подробно описано в скиле `feature-workflow`. Кратко:

1. **План** с критериями приёмки. Для нетривиальной задачи отдай план ревьюерам `architecture-reviewer` и `sanity-reviewer` до того, как писать код.
2. **Контракт** (если меняется API): `packages/contracts` → `openapi` → реализация в `apps/api` с тестами.
3. **UI**: компоненты в `packages/ui` (поведенческий тест + визуальный), экран в `apps/web/src/features/<feature>/`.
4. **E2E**: сценарии фичи в `e2e/features/<feature>/`. Критичные пользовательские пути помечай `@critical`.
5. `pnpm verify --full` зелёный → ревьюеры `test-quality-reviewer`, `security-reviewer`, `product-logic-reviewer` → PR по шаблону с доказательствами.

## Правила

**Никогда:**

- Не меняй защищённые пути из [tools/protected-paths.json](tools/protected-paths.json): скриншот-базлайны, `perf-budgets.json`, конфиги линтеров, границ и CI, пороги покрытия и мутаций, `tools/`. Хук заблокирует запись, CI заблокирует PR. Если гейт мешает, чини код. Если считаешь, что неправ сам гейт, остановись и объясни человеку.
- Не обновляй скриншот-базлайны (`pnpm visual:update`, `--update-snapshots`, `vitest -u`). Это делает человек после просмотра диффа.
- Не ослабляй тест, чтобы он прошёл. Не добавляй `.only`, `.skip`, `.fixme`, `test.fail`.
- Не подавляй ошибки: никаких `any`, `@ts-ignore`, `oxlint-disable`, `eslint-disable`. Допустим `@ts-expect-error -- <причина>` с объяснением.
- Не импортируй код между фичами (`features/a` → `features/b`), между приложениями и из пакетов в приложения. Общее выноси в `src/lib` или `packages/`.
- Не используй `git commit --no-verify`, `LEFTHOOK=0`, `git push --force`.

**Всегда:**

- Contract-first: любое изменение API начинается в `packages/contracts`, затем перегенерируй `openapi.json`.
- Валидация через общие Zod-схемы из контрактов, на клиенте и на сервере одна и та же.
- Селекторы в тестах: `getByRole` / `getByLabel` / `getByText`. `data-testid` только когда семантики нет.
- E2E-тесты в `features/` работают параллельно: используй `uniqueTitle()`, не полагайся на порядок и общие данные.
- Новые зависимости — только при реальной необходимости, версия в `catalog:` в `pnpm-workspace.yaml` (это ревьюится).
- Перф-регрессия → чини код (скил `perf-regression`). Визуальный дифф → триаж (скил `visual-diff-triage`).

## Definition of Done

- `pnpm verify --full` зелёный.
- Новое поведение покрыто тестами на правильном уровне (скил `writing-tests`), мутанты в изменённой доменной логике убиты.
- Если менялся UI, `pnpm visual` зелёный или в PR явно перечислены ожидаемые визуальные изменения для человека.
- PR заполнен по шаблону: что сделано, как проверено, доказательства (trace / video / отчёты).

## Развитие самой обвязки

Если задача меняет не продукт, а сам шаблон (гейты, хуки, CI, структуру репозитория, инструкции агентов), сначала прочитай:

- [docs/architecture.md](docs/architecture.md): законы обвязки и принятые архитектурные и инфраструктурные подходы. Изменение не должно им противоречить.
- [docs/roadmap.md](docs/roadmap.md): что переделать, улучшить и добавить, с доказательствами, подводными камнями и критериями готовности. Задачи с пометкой 🔒 трогают защищённые пути и требуют режима обслуживания.
