# Как удалить часть шаблона

Шаблон поставляет одну форму проекта: web + api + Postgres + визуальные тесты + перф-бюджеты ([ADR 0008](adr/0008-template-distribution.md)). Форма осознанная: профили Copier («только API», «без визуальных тестов») не вводятся — каждый вопрос умножает число комбинаций, которые обязана проверять канарейка копии. Если проекту нужна другая форма, удаляйте части по этому документу: для каждой части — чек-лист «что удалить → что краснеет → что переделать в CI».

Фактура — исследование e6 в репозитории шаблона (`docs/research/2026-11-template-profiles.md`, в проект из шаблона не едет, поэтому без ссылки): каждая часть удалялась в чистой копии с прогонами `pnpm verify --json` и точечными CI-командами.

Порядок работы: после каждого пункта запускайте `pnpm verify` — шаги `knip` и `docs` сами подскажут хвосты: записи каталога `catalog:` без потребителей, битые ссылки, команды `pnpm --filter <удалённый пакет>` в `README.md`.

## Web (`apps/web`)

**Что удалить**

1. Каталог `apps/web/`.
2. `@repo/web@workspace:*` из devDependencies `e2e/package.json` — без этого `pnpm install` падает: это первая стена, она стоит до любых гейтов.
3. `apps/web` из `workspaces` и e2e-исключения из `knip.json`.
4. Записи react-стека из каталога `catalog:` в `pnpm-workspace.yaml` (knip перечислит их: «Unused catalog entries», 5 записей + hints).
5. Команды `pnpm --filter @repo/web …` из `README.md` (гейт `docs` красит `--filter` на несуществующий пакет).
6. Сценарии `e2e/features/**`, гоняющие web, и перф-тесты `e2e/perf/**` — переписать или удалить вместе с частью.

**Что краснеет**

- `pnpm verify`: `knip` (catalog-записи и configuration hints), `docs` (команды README).
- `pnpm verify --full` и CI: `bundle` — exit 1 «No build output»; CI-jobs `perf` и `bundle-delta` — `turbo build --filter=@repo/web` exit 1 (громко); jobs e2e/visual — таймаут webServer: старт web из `e2e/playwright.config.ts` при отсутствии пакета завершается exit 0 молча, сценарии падают позже по health-таймауту — сигнал громкий, но диагностика вводит в заблуждение.
- Тихого ослабления нет.

**Что переделать в CI**

Погасить или перестроить jobs `bundle`, `bundle-delta`, `perf`, `visual`, `e2e` в `.github/workflows/ci.yml`. `.github/**` — защищённый путь класса deny: правка только через режим обслуживания (в вашем проекте — свои правила из `AGENTS.md`, файл `.claude/settings.local.json`).

## API (`apps/api`)

**Что удалить**

1. Каталог `apps/api/`.
2. `@repo/api@workspace:*` из devDependencies `e2e/package.json` (та же стенка `pnpm install`).
3. Исключения `knip.json`, ссылающиеся на api.
4. Записи каталога `catalog:`, оставшиеся без потребителей (knip перечислит; у api это 9 записей: stryker, testcontainers, pg, drizzle, coverage).
5. Команды `pnpm --filter @repo/api …` из `README.md`.
6. `docs/test-database-isolation.md` — удалить или переписать вместе со слоем Postgres (см. ниже): он ссылается на тесты api.

**Что краснеет**

- `pnpm install` падает (`@repo/api@workspace:*` в e2e) — стенка до гейтов.
- `pnpm verify`: `knip` (catalog-записи), `docs` (`README.md`, `docs/test-database-isolation.md`).
- e2e/perf: таймаут webServer (старт api из `e2e/playwright.config.ts`).
- **Мутационное тестирование не выключается.** Носители задачи `mutation` — `apps/api`, `apps/web`, `packages/contracts`. После удаления api остаются два носителя: покрытие сжимается с трёх пакетов до двух, но задача продолжает гоняться. Тихое выключение (`turbo run mutation` → «No tasks were executed», зелёный job) возможно только при удалении всех трёх stryker-носителей — и тогда шаг `required-tasks` гейта verify краснеет громко: «mutation: ни одного пакета» (`tools/check-required-tasks.ts`). До гейта e20 удаление api действительно выключало mutation молча — это закрыто.
- Храповик `test:count` пропустит исчезнувший отчёт api молча (warning-only): запись api в `test-count-baseline.json` удалите вручную, иначе храповик слепнет к этой части.

**Что переделать в CI**

Affected-jobs сузятся сами; полный mutation (nightly, merge queue) продолжит гонять `apps/web` и `packages/contracts`. Если это не нужно — гасите jobs в `.github/**` (deny, режим обслуживания).

## Postgres (слой БД)

Postgres — самая «мягкая» часть: API умеет работать in-memory (без `DATABASE_URL` выбор хранилища даёт `resolveServerStorage` в `apps/api/src/server-config.ts`), поэтому красный след минимален.

**Что удалить**

1. `apps/api/src/tasks/database.ts`, `postgres-repository.ts`, `schema-sync.ts` и варианты `schema-sync*.ts`, `schema.ts`.
2. `apps/api/migrations/`, `apps/api/drizzle.config.ts`.
3. Postgres-тесты в `apps/api/test/` (интеграционные, Testcontainers).
4. Скрипты `db:*` из `apps/api/package.json`.
5. Зависимости pg, drizzle, testcontainers и их записи `catalog:`.
6. Проводку в `apps/api/src/server.ts` — свести к `InMemoryTaskRepository`.
7. `docs/test-database-isolation.md` — удалить или переписать: гейт `docs` красит висячую ссылку из него.

**Что краснеет**

- Только `docs` (висячая ссылка выше). `turbo test` остаётся зелёным: API уже живёт in-memory. Mutation и перф — без изменений. `pnpm install` не падает, если зависимости удалены вместе с кодом.
- Тихого ослабления нет.

## Визуальные тесты

**Что удалить**

1. Сценарии: `e2e/features/**/**.visual.ts`, `packages/ui/src/**/*.visual.test.tsx`.
2. `packages/ui/src/testing/visual-frame.tsx` (knip пометит unused).
3. Базлайны: `packages/ui/src/__screenshots__/**`, `e2e/__screenshots__/**`.

**Что краснеет**

- `knip`: unused `visual-frame.tsx`, hint «**/*.visual.ts … no matches».
- CI job `visual`: `vitest run --project visual` → exit 1 «No test files found» — громко.
- Базлайны `__screenshots__` — защищённый путь (deny в `tools/protected-paths.json`): хуки и CI заблокируют их удаление без режима обслуживания. Хуки `.claude/**` едут в проект — запрет действует у потребителя так же, как в шаблоне.

**Что переделать в CI**

Погасить job `visual` в `.github/workflows/ci.yml` (deny — режим обслуживания), иначе «no tests found» красит PR.

## Общее

- Гейты `boundaries`, `typecheck`, `openapi`, `sherif`, `tool-class` остаются зелёными при любом удалении — это норма: их правила матчат имена путей, а не наличие пакетов. Не ждите от них сигнала о пропавшей части.
- Ссылки в этом документе ведут только на файлы, которые едут в проект из шаблона: документ сам едет в копию, а документ из копии не может ссылаться на документ вне копии ([ADR 0008](adr/0008-template-distribution.md)).
- Возврат к вопросу «а сделать профили?» — через ADR в репозитории шаблона: решение «одна форма, два вопроса» закреплено [ADR 0008](adr/0008-template-distribution.md).
