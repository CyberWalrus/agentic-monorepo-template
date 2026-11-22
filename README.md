# agentic-monorepo-template

Шаблон монорепозитория (frontend + backend) для разработки силами AI-агентов. Агенты могут «вайбкодить» фичи, а инфраструктура быстро и объективно не пускает в `main` код, который недостаточно хорош.

Продукт внутри намеренно абстрактный (список задач). Ценность репозитория в обвязке. Зачем всё это: [docs/vision.md](docs/vision.md).

## Как этим пользоваться

Систему ведут три роли. Полные правила агента — [AGENTS.md](AGENTS.md); механика доски задач — [ADR 0007](docs/adr/0007-task-board.md); роль и границы оператора — [ADR 0009](docs/adr/0009-operator-delegation.md).

| Роль     | Как запустить                              | Что делает                                                                                    |
| -------- | ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Агент    | обычная сессия, фраза «продолжай по плану» | берёт свободную задачу (`pnpm backlog next`) и доводит её до PR с зелёными гейтами            |
| Оператор | сессия с computer use, слова «ты оператор» | ведёт задачи режима обслуживания — те, что трогают защищённые пути гейтов                     |
| Человек  | —                                          | принимает решения, которые не делегируются ([ADR 0009](docs/adr/0009-operator-delegation.md)) |

Что человек делает сам — приёмка PR (approve, label `gate-change-approved`, merge), одобрение базлайнов скриншот-тестов, секреты и аккаунты, `pnpm backlog release`. Полный канон с причинами и границами оператора — [ADR 0009](docs/adr/0009-operator-delegation.md), «Что остаётся человеку».

Только в репозитории шаблона: защищённый тег версии и запуск `copier update` ([ADR 0008](docs/adr/0008-template-distribution.md)), облачный контур агентов ([ADR 0010](docs/adr/0010-cloud-agents.md)). Проект из шаблона создаётся Copier из защищённого тега — первый тег `v0.1.0` поставлен 2026-11-19; как создать проект — [github-setup.md](docs/github-setup.md), раздел 8.

Очередь задач: `pnpm backlog list`.

## Быстрый старт

```bash
nvm use                     # Node из .nvmrc
npm install -g pnpm@12.16.1 # pnpm: corepack в Node ≥25 не входит (ADR 0012); версия — дословно из packageManager
pnpm install                # зависимости и git-хуки
pnpm verify                 # все быстрые гейты; время — таблица 3.1 в docs/architecture.md
                            # подмножество шагов: pnpm verify --only docs (список — через запятую)
pnpm dev                    # web и api на портах из worktree (выбор — в reports/ports.json)
                            # e2e против живого dev-сервера: REUSE_SERVER=1 pnpm e2e
```

## Требования окружения

- Node из `.nvmrc` и pnpm из `packageManager`;
- Docker: интеграционные тесты API поднимают Postgres через Testcontainers (это часть `pnpm verify`); скриншот-тесты (`pnpm visual`) — тоже Docker: первый прогон собирает образ с зависимостями (слой привязан к `pnpm-lock.yaml`), повторные без смены локфайла его переиспользуют;
- Chromium: браузеры Playwright для browser-тестов unit и E2E (`playwright install --with-deps chromium`); нужна сеть до npm registry и CDN Playwright;
- для облачных агентов — минимальный контур в [ADR 0010](docs/adr/0010-cloud-agents.md);
- телеметрия Turborepo: в CI выключена переменной `TURBO_TELEMETRY_DISABLED`, локально один раз на машину выполни `pnpm exec turbo telemetry disable` (иначе turbo ходит на `telemetry.vercel.com`, а песочница агента режет эти запросы).

## Production-запуск

```bash
# api: Node 26 запускает TS напрямую (readiness: GET /health)
PORT=3877 pnpm --filter @repo/api start

# web: production-entry на Node — статика dist/client + прокси /rpc + SSR
# (readiness: GET /healthz); перед запуском нужна сборка
pnpm --filter @repo/web build
PORT=3876 API_URL=http://127.0.0.1:3877 pnpm --filter @repo/web start:prod
```

Окружение валидируется при старте (fail-closed): без `PORT` (и без `API_URL` у web) процесс не поднимется. Хост привязки — `HOST` (дефолт `127.0.0.1`, в контейнере `0.0.0.0`). Модель запуска и образы — [ADR 0012](docs/adr/0012-production-server.md).

```bash
# Образы (контекст — корень репозитория; рантайм non-root, readiness в HEALTHCHECK)
docker build -f apps/api/Dockerfile -t template-api .
docker build -f apps/web/Dockerfile -t template-web .
docker run -p 3000:3000 template-api
# host.docker.internal есть в Docker Desktop (macOS/Windows); на Linux добавьте --add-host:
docker run -p 3000:3000 -e API_URL=http://host.docker.internal:3877 template-web
docker run --add-host=host.docker.internal:host-gateway -p 3000:3000 -e API_URL=http://host.docker.internal:3877 template-web
```

E2E, перф и визуальные тесты поднимают приложения тем же production-entry, что деплоится (e2e webServer — `pnpm --filter @repo/web start:prod`, C3.4); `vite preview` и dev-серверы — только интерактивная разработка. CI-сборка образов — C3.3.

## Стек

Node (`.nvmrc`) · pnpm (`packageManager`) · Turborepo · TypeScript · Oxlint + Oxfmt · Vite (Rolldown) · React + TanStack Start + TanStack Query · Hono + oRPC + Zod · Vitest (browser mode) · Playwright · dependency-cruiser · Knip · sherif · StrykerJS · Lefthook.

Версии зависимостей — только в каталоге `catalog:` в [pnpm-workspace.yaml](pnpm-workspace.yaml). Почему именно так: [ADR 0001](docs/adr/0001-initial-stack.md); исследование стека лежит в `docs/research/` и в проект из шаблона не едет, поэтому даётся без ссылки.

## Контуры проверки

Статусы — снимок на 2026-11-17. Время контуров здесь не дублируем: единственное место чисел — таблица 3.1 в [docs/architecture.md](docs/architecture.md).

| Контур             | Где                                        | Что                                                                                                                                                  | Статус                                                                                                                                                                            |
| ------------------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **L0 агент**       | хуки Claude Code (`.claude/settings.json`) | формат и type-aware линт каждой правки; запрет записи в защищённые пути и обхода гейтов; агент не может завершить работу, пока `pnpm verify` красный | действует в Claude Code; в ZCode хуков пока нет (C10.1, C10.3)                                                                                                                    |
| **L1 pre-commit**  | Lefthook                                   | Oxfmt + Oxlint по staged-файлам                                                                                                                      | действует                                                                                                                                                                         |
| **L2 pre-push**    | Lefthook                                   | typecheck, unit, границы модулей                                                                                                                     | действует                                                                                                                                                                         |
| **L3 PR**          | GitHub Actions `ci.yml`                    | статика, affected unit/mutation/E2E, скриншоты в Docker, перф-бюджеты, бюджет бандла, k6, защищённые пути → единый check **`gate`**                  | действует                                                                                                                                                                         |
| **L4 merge queue** | ruleset + `merge_group`                    | всё то же на смёрженном состоянии, без affected-сокращений                                                                                           | частично (2026-11-17, A9): строгая база в снимке ruleset, применяется A9.1 — `gate` на смёрженном состоянии; affected-сокращения снимает только merge queue, недоступна на тарифе |
| **L5 nightly**     | `nightly.yml`                              | E2E в случайном порядке x5, полный mutation, тренд перфа                                                                                             | действует                                                                                                                                                                         |
| **Ревью**          | `agent-review.yml`                         | 5 субагентов-ревьюеров, read-only контур (b5), по `ready_for_review` и вручную; блокеры — аннотациями (информационно, не блокирует)                  | действует, информационно (живой прогон — после подключения ANTHROPIC_API_KEY)                                                                                                     |

## Что считается «достаточно хорошим» кодом

- формат, линт (type-aware, без подавлений), типы TS 7;
- границы: пакеты не знают о приложениях, фичи не импортируют друг друга, домен API не зависит от HTTP, UI без домена;
- нет мёртвого кода и лишних зависимостей (Knip), версии консистентны и берутся из каталога `catalog:` (sherif);
- нет `.only/.skip/.fixme/test.fail` (`test-integrity`);
- документация не врёт: команды `pnpm …` и ссылки в инструкциях целы (`docs:check`);
- контракт API согласован: `openapi.json` перегенерирован;
- unit + browser-тесты, покрытие API выше порогов, мутанты убиты (Stryker);
- E2E зелёные, включая `@critical` продуктовые инварианты;
- скриншоты совпадают с базлайнами (обновляет только человек);
- перф-бюджеты: TTFB/LCP/CLS, время сценариев (CPU x4), gzip-бандл, p95 API;
- защищённые файлы гейтов не тронуты без label `gate-change-approved`.

## Структура

```
apps/api            Hono + oRPC, Node 26 запускает TS напрямую
apps/web            TanStack Start, фичи в src/features/<feature>
packages/contracts  oRPC-контракт + Zod — единый источник правды API
packages/ui         презентационные компоненты + визуальные тесты
e2e                 Playwright: features, visual, perf, specs (планы тестов), agents (seed)
tools               гейты: verify, бюджеты, защищённые пути, Docker-скриншоты
.claude             хуки, скилы, субагенты-ревьюеры, Playwright Test Agents
.github             CI, агентное ревью, nightly, ruleset, Renovate; CODEOWNERS в docs/
```

Если проекту нужна другая форма — части шаблона удаляются по [docs/removal.md](docs/removal.md): по каждой части чек-лист «что удалить → что краснеет → что переделать в CI»; профили Copier не вводятся ([ADR 0008](docs/adr/0008-template-distribution.md)).

## Документы

- [Зачем нужна система](docs/vision.md)
- Исследование стека, ноябрь 2026 — `docs/research/` (в проект из шаблона не едет, поэтому без ссылки)
- [ADR 0001: стек первой реализации](docs/adr/0001-initial-stack.md)
- [Архитектурные и инфраструктурные подходы](docs/architecture.md): законы обвязки, слои, правила изменения гейтов
- Задачи развития обвязки — доска `backlog/` (`pnpm backlog`, [ADR 0007](docs/adr/0007-task-board.md))
- [Настройка GitHub](docs/github-setup.md): ruleset, labels, секреты
- [AGENTS.md](AGENTS.md): инструкции для агентов для всех клиентов; [CLAUDE.md](CLAUDE.md) только импортирует его для Claude Code
