# Исследование стека: ноябрь 2026

> Статус: решения приняты в [ADR 0001](../adr/0001-initial-stack.md) · Дата: 2026-11-01
> Цель: выбрать инструменты под [vision](../vision.md), то есть монорепо frontend + backend, 5–50 человек плюс агенты, быстрые и надёжные gates.
> Методика: исходный анализ автора сверен с первоисточниками (release notes, официальные доки, блоги команд). Где источники расходятся или подтверждения не нашлось, это отмечено. Версии актуальны на дату документа, при бутстрапе их нужно перепроверить.

## TL;DR: предлагаемый стек

| Слой                            | Выбор                                                                                                                    | Альтернатива                             | Почему                                                                                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime                         | **Node.js 26 LTS** (Active LTS с 28.10.2026)                                                                             | Node 24 (Maintenance до 04.2028)         | Свежая LTS, встроенный Temporal. Knip требует Node 24+, Vitest 5 не работает на Node 20                                                                                                          |
| Пакетный менеджер               | **pnpm 11** (тег `latest` на npm), catalogs                                                                              | **pnpm 12** (переписан на Rust, drop-in) | Supply-chain дефолты в 11: `minimumReleaseAge` = 1 день, `blockExoticSubdeps`, `allowBuilds`. pnpm 12 использует тот же lockfile и конфиг, поэтому переход сводится к смене пина после бенчмарка |
| Оркестратор задач               | **Turborepo 2.10**                                                                                                       | Nx 22, Vite+ `vp run`                    | Простой, кэширует по умолчанию, `--affected` и `--filter` комбинируются, self-hosted remote cache по открытой спецификации                                                                       |
| Язык                            | **TypeScript 7.0** (нативный, на Go)                                                                                     | —                                        | Сборка и typecheck в 8–12 раз быстрее. Нюанс: JS API появится только в 7.1, инструментам на Compiler API нужен `@typescript/typescript6` рядом                                                   |
| Линтер                          | **Oxlint 1.x** (type-aware через tsgolint, нативные правила React Compiler)                                              | Biome 2.6                                | Самый быстрый, использует настоящий TS-чекер, покрывает 59 из 61 type-aware правила typescript-eslint                                                                                            |
| Форматтер                       | **Oxfmt** (0.x beta, совместим с Prettier)                                                                               | Biome formatter                          | В 3 раза быстрее форматтера Biome. Риск: ещё не 1.0                                                                                                                                              |
| Сборка                          | **Vite 8** (Rolldown), **tsdown** для пакетов                                                                            | —                                        | Rolldown 1.0 стабилен с мая 2026, сборки в разы быстрее                                                                                                                                          |
| Frontend                        | **React 19.3** + **TanStack Start 1.0**                                                                                  | Next.js 16                               | Vite-нативный (единый тулчейн с Vitest и Playwright), type-safe роутинг снижает ошибки агентов. Риск: 1.0 вышел только 13.10.2026                                                                |
| Backend                         | **Hono** + **oRPC** (contract-first, генерирует OpenAPI)                                                                 | Fastify, NestJS                          | Контракт в отдельном пакете служит единым источником правды для фронта и бэка, OpenAPI генерируется из кода                                                                                      |
| БД                              | **PostgreSQL** + **Drizzle 0.45** (1.0 в RC)                                                                             | Prisma 7                                 | Схема на TS без кодогенерации, агент видит модель прямо в коде                                                                                                                                   |
| Unit / integration              | **Vitest 5** (nested projects, benchmark API, trace view)                                                                | —                                        | Стандарт де-факто, Browser Mode стабилен                                                                                                                                                         |
| Компонентные и визуальные тесты | **Vitest Browser Mode** + `toMatchScreenshot`                                                                            | Storybook 10 + addon-vitest              | Нативный пиксельный дифф с stable-detection, без самописного pixelmatch                                                                                                                          |
| E2E и визуал страниц            | **Playwright 1.64** + `toHaveScreenshot` (WebP)                                                                          | —                                        | Встроенные MCP и CLI, Test Agents, `--shuffle`, test locks                                                                                                                                       |
| Визуальное ревью (опционально)  | **Argos**                                                                                                                | Chromatic, только HTML-отчёт в CI        | Agent-first: MCP, CLI с `--json`, скилы. $100 в месяц за команду без ограничения числа участников                                                                                                |
| Перф: фронт                     | **Lighthouse CI** (бюджеты, медиана 3 прогонов) + замеры сценариев в Playwright + бюджет размера бандла                  | —                                        | Блокирует PR при регрессии Core Web Vitals                                                                                                                                                       |
| Перф: бэк                       | **k6** (smoke, порог p95 относительно базлайна) + **CodSpeed** для микро-бенчмарков                                      | Self-hosted Vitest bench                 | CodSpeed в режиме симуляции даёт стабильные цифры на обычных GitHub-раннерах                                                                                                                     |
| Архитектура и гигиена           | **dependency-cruiser** (границы, циклы), **Knip** (мёртвый код и зависимости), **sherif** (консистентность package.json) | Turborepo boundaries (experimental)      | Каждый закрывает свою часть, все блокируют в CI                                                                                                                                                  |
| Качество тестов                 | **StrykerJS 10.1+** (Vitest runner, incremental, только изменённый код)                                                  | —                                        | Отвечает на вопрос «тесты агента вообще что-то проверяют?»                                                                                                                                       |
| Git hooks                       | **Lefthook**                                                                                                             | `vp hooks` / husky                       | Один Go-бинарь, параллельный запуск, фильтры по путям                                                                                                                                            |
| CI                              | **GitHub Actions** + **merge queue** + единый gate-джоб                                                                  | Mergify                                  | Стандартный паттерн для монорепо с affected-джобами                                                                                                                                              |
| Агентный слой                   | **AGENTS.md** + Claude Code (`.claude/`: settings, hooks, skills, agents) + `claude-code-action@v1`                      | —                                        | Открытый стандарт инструкций плюс детерминированные хуки                                                                                                                                         |
| Агентный браузер                | **Playwright MCP/CLI** (встроены с 1.62) + **Chrome DevTools MCP**                                                       | —                                        | Playwright управляет браузером, DevTools MCP отлаживает: perf-трейсы, Lighthouse, heap                                                                                                           |

## Детали по слоям

### Фундамент: runtime, пакеты, монорепо

- **Node.js 26** стал Active LTS 28.10.2026 (Maintenance с 20.10.2027, EOL 30.04.2029). Node 24 ушёл в Maintenance, Node 20 мёртв с 30.04.2026. С Node 27 проект переходит на один мажор в год, и каждая версия будет LTS. **Локально сейчас стоит Node 22.20, его нужно обновить.**
- **pnpm 11**: SQLite-индекс стора, supply-chain защита по умолчанию (`minimumReleaseAge` 1 день, `blockExoticSubdeps`), единый `allowBuilds`, команды `pnpm ci` и `pnpm sbom`. Конфиг больше не читается из поля `pnpm` в package.json, только из `pnpm-workspace.yaml`. Catalogs поддерживают `workspace:` (11.26).
- **pnpm 12** (26.08.2026) переписан на Rust с сохранением команд, флагов, lockfile и раскладки `node_modules` от 11-й версии. На npm тег `latest` всё ещё указывает на 11-ю линию. С 12.12 есть remote cache для результатов задач и сборок зависимостей. Предлагаю замерить установку на нашем репо и переключиться, если выигрыш заметен.
- **Turborepo vs Nx vs Vite+**:
  - Turborepo 2.10 (24.06.2026): `--affected` вместе с `--filter`, отложенное хеширование входов, вытеснение локального кэша. Кэширует по умолчанию, self-hosted remote cache по открытой спецификации, артефакты подписываются HMAC.
  - Nx 22: сильнее в распределённом CI (агенты Nx Cloud, self-healing CI, детекция флаков), но в мае 2026 Nx объявил устаревшими self-hosted пакеты кэша из-за CVE-2025-36852 (CREEP). Поддерживаемые варианты: Nx Cloud или своя реализация OpenAPI-спеки.
  - Vite+ 1.0 (28.09.2026): единая CLI `vp` (dev, check, test, build, pack, run, hooks, staged) поверх Vite, Vitest, Rolldown, Oxlint, Oxfmt, tsdown. Remote cache пока только в планах. VoidZero объявил о переходе в Cloudflare. Есть критика за лишний слой абстракции и lock-in.
  - **Вывод:** берём те же инструменты, что внутри Vite+, но подключаем напрямую и оркеструем через Turborepo. Если позже захотим `vp`, переход дешёвый, потому что инструменты совпадают. К Nx вернёмся, если CI перестанет укладываться в бюджет и понадобится распределённое выполнение.

### Язык и статический анализ

- **TypeScript 7.0** (стабильный с 08.07.2026, сейчас 7.0.2): компилятор и language service портированы на Go, сборка в 8–12 раз быстрее. Команда осталась `tsc` в пакете `typescript`. Программного JS API пока нет (обещан в 7.1). Инструменты на Compiler API (ts-morph и подобные) требуют `@typescript/typescript6`. tsgolint не поддерживает `moduleResolution: node10`, используем `bundler`.
- **Oxlint vs Biome:**
  - Oxlint 1.x: 840+ встроенных правил. Type-aware режим через tsgolint работает на настоящем TS-чекере, правила стабилизированы в июле 2026 (v1.75). С августа 2026 есть 22 нативных правила React Compiler (Rust-порт компилятора). JS-плагины, совместимые с ESLint, пока в alpha. CSS не поддерживается.
  - Biome 2.6: линтер и форматтер в одном инструменте, поддерживает CSS, JSON, GraphQL, HTML. Type-aware правила на собственном выводе типов, их заметно меньше, чем в Oxlint.
  - По скорости на реальном репо они близки (118 мс против 131 мс), но Oxlint точнее на type-aware правилах и лучше сочетается с TS 7.
  - **Вывод:** Oxlint + Oxfmt для TS/JS, для CSS (если понадобится) Biome только на CSS или Stylelint. ESLint как запасной вариант для редких плагинов через JS-плагины Oxlint.
- **Границы и гигиена:** dependency-cruiser проверяет архитектурные правила, циклы и type-only импорты, умеет работать с baseline. Knip находит неиспользуемые файлы, экспорты и зависимости, а также используемые, но не объявленные зависимости (с 6.24 требует Node 24+). sherif следит за рассинхроном версий и правилами package.json.

### Frontend

- **React 19.3** (09.09.2026): стабильные View Transitions и Fragment Refs. React 20 не анонсирован. **React Compiler 1.0** стабилен с октября 2025.
- **TanStack Start 1.0** (13.10.2026): Vite, type-safe роутинг, TanStack Query как слой данных, деплой через Nitro куда угодно. RSC пока экспериментальны и выключены по умолчанию. На бенчмарках SSR он заметно быстрее Next.js.
- **Next.js 16** остаётся безопасным дефолтом по экосистеме и найму (около 55 млн загрузок в неделю против 16 млн у Start). Он выигрывает, если нужны RSC или CMS.
- **Вывод:** для шаблона с упором на агентов и единый Vite-тулчейн выбираем TanStack Start. Риск свежего 1.0 принимаем, потому что демо-продукт небольшой.

### Backend и контракты

- **Hono**: работает на Node, Bun, Deno и в edge, минимальный, с лучшим выводом типов через Zod. **Fastify** даёт schema-first и OpenAPI «из коробки». **NestJS** даёт максимум структуры (модули, DI), но это много бойлерплейта и медленный холодный старт.
- **oRPC**: contract-first (пакет `@orpc/contract` служит единым источником правды), отдаёт и RPC, и REST/OpenAPI, монтируется в Hono или Fastify. У tRPC contract-first нет, а `@trpc/openapi` в alpha.
- **Вывод:** `packages/contracts` (oRPC + Zod) → backend на Hono → типизированный клиент во фронте → OpenAPI как артефакт для контрактных проверок и внешних потребителей.
- **Drizzle vs Prisma:** Drizzle 0.45 (1.0 в RC, проект поддерживает PlanetScale с марта 2026) обходится без кодогенерации, весит около 12 КБ, холодный старт около 35 мс. Prisma 7 избавилась от Rust-движка, Prisma 8 в RC и сильно меняет API. Для агентов удобнее Drizzle: схема написана на TS и лежит рядом с кодом.

### Тестирование

**Пирамида и место агентов.** Консенсус 2026 года, подтверждённый исследованием Slack Engineering (200+ прогонов):

| Подход                        | Простой флоу | Сложный флоу                      | Время                      | Стоимость        |
| ----------------------------- | ------------ | --------------------------------- | -------------------------- | ---------------- |
| Агент + Playwright MCP        | 0% падений   | ~12%                              | 5–8 мин                    | $15–30 за прогон |
| Агент + Playwright CLI        | ~12%         | ~20%                              | 9–11 мин                   | —                |
| Сгенерированные агентом тесты | ~8%          | ~48% (доходят до 70–80% сценария) | ~3 мин, выполнение 30–45 с | —                |

Главный драйвер стоимости — накопление контекста: снапшоты доступности переотправляются на каждом ходу. Вывод Slack: детерминированные тесты остаются ядром CI-регрессии, агенты стоят на вершине пирамиды и используются для исследования, отладки флаков и воспроизведения багов.

**Playwright 1.56–1.64: что важно для нас**

| Версия | Фича                                                                                                                                              | Как используем                                                                                                                       |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1.56   | Test Agents: Planner, Generator, Healer (`npx playwright init-agents --loop=claude`)                                                              | Генерация и починка E2E. Healer правит только через патч в PR. Определения агентов перегенерируются после каждого апдейта Playwright |
| 1.59   | `browser.bind()`: один браузер на сессию для MCP и CLI                                                                                            | Агент и тесты работают в одном браузере                                                                                              |
| 1.59   | `--debug=cli`, `npx playwright trace`                                                                                                             | Агент разбирает упавший тест и трейс без GUI                                                                                         |
| 1.62   | MCP-сервер и CLI встроены в пакет (`npx playwright mcp`, `npx playwright cli`)                                                                    | Не нужен отдельный `@playwright/mcp`, версия совпадает с проектной. Ставить 1.62.1+, в 1.62.0 были регрессии                         |
| 1.62   | Component testing переехал на модель stories/gallery, пакеты `experimental-ct-*` объявлены устаревшими и затем удалены                            | Компонентные тесты пишем в Vitest Browser Mode, не на CT                                                                             |
| 1.63   | Test locks                                                                                                                                        | Защита общих ресурсов (БД, сиды) при параллельном запуске                                                                            |
| 1.64   | `toHaveScreenshot` с `type: 'webp'`, `--shuffle`, `testProject.default`, `Locator.within()`, `getByRef()`, WebMCP, видео в VP9 с настройкой `fps` | WebP для базлайнов, `--shuffle` в nightly ловит зависимые тесты, видео прикладываем к PR как доказательство                          |

**Скриншот-тесты**

- Страницы: Playwright `toHaveScreenshot` в WebP. Генерация и сравнение только в одном Docker-образе `mcr.microsoft.com/playwright:v1.64.x`, потому что шрифты на локальной машине и в CI почти всегда расходятся.
- Компоненты: Vitest Browser Mode `toMatchScreenshot`. Стабилен с Vitest 4. Внутри pixelmatch (в main-доках уже есть `standard-ssim`), есть Stable Screenshot Detection и кастомные компараторы. Базлайны лежат в `__screenshots__` рядом с тестом, для больших наборов используем Git LFS. Ограничения: нет `fullPage`, у Playwright-провайдера бывают проблемы с размером вьюпорта.
- Storybook test-runner официально прекращён в пользу `@storybook/addon-vitest`. Аддон (по данным на ноябрь 2025) не поддерживает `toMatchScreenshot`, поэтому Storybook как основу визуальных тестов не берём.
- Мёртвые и замороженные инструменты: lost-pixel (архивирован 22.04.2026, команда ушла в Figma), Playwright CT-пакеты.

**Правила работы агентов с базлайнами** (основа для хуков и CI):

1. Пиксельный дифф решает, LLM только разбирает результат. На бенчмарке DiffSpot (Tencent, май 2026) лучшая модель находит 40.7% изменений по статье и 47.2% в обновлённом лидерборде, на сложном уровне все модели ниже 23%, и модели галлюцинируют изменения там, где их нет.
2. Упал дифф → агент читает его (CLI `--json` или MCP) → триаж: intended, regression или flaky.
3. Regression → агент правит код, а не базлайн.
4. Обновление базлайна — отдельная gated-команда, которую запускает человек. У агента нет прав записи в `__screenshots__` и `*-snapshots/`: это закрыто хуком, CI-проверкой и CODEOWNERS.

**Качество тестов.** Coverage не отвечает на вопрос, ловят ли тесты ошибки. Исследование Supercov (октябрь 2026) показало, что сгенерированные агентом наборы со 100% покрытием пропускают до 22% мутантов. StrykerJS 10.1.1+ поддерживает Vitest 5, `coverageAnalysis: 'perTest'` и `incremental`. В PR мутируем только изменённые файлы, полный прогон делаем в nightly. Mutation score становится критерием приёмки.

### Производительность и деградации

| Что                                                   | Инструмент                                                                                                        | Где                 |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------- |
| Core Web Vitals (LCP, INP, CLS, TBT) ключевых страниц | Lighthouse CI: бюджеты, медиана 3 прогонов, throttling `devtools` (в режиме `simulate` LCP скачет)                | PR CI               |
| Время пользовательских сценариев                      | Playwright + `PerformanceObserver`/web-vitals, сравнение с базлайном из `main`                                    | PR CI / merge queue |
| Размер бандла                                         | Бюджет на чанки (size-limit или встроенная статистика Rolldown)                                                   | PR CI               |
| p95 API и error rate                                  | k6 smoke, порог ~120% от базлайна                                                                                 | PR CI (affected)    |
| Горячие функции                                       | CodSpeed + Vitest bench (режим симуляции CPU)                                                                     | PR CI               |
| Глубокий разбор регрессии                             | Chrome DevTools MCP: `performance_start_trace`, `performance_analyze_insight`, `lighthouse_audit`, heap snapshots | Агент по запросу    |

Для Chrome DevTools MCP отключаем телеметрию флагами `--no-usage-statistics` и `--no-performance-crux`, иначе URL трейсов уходят в CrUX API.

### Агентный слой

- **AGENTS.md** — открытый стандарт, передан в Agentic AI Foundation (Linux Foundation) в декабре 2025, принят в 60 000+ репозиториев. Держим его коротким: команды, селектор-политики, правила. `CLAUDE.md` импортирует AGENTS.md и добавляет специфику Claude Code.
- **Claude Code** (`.claude/` в репозитории):
  - `settings.json`: явные allow/ask/deny и хуки. Хуки гарантированно исполняются, в отличие от инструкций.
  - Хуки (33 события, типы `command`, `http`, `prompt`, `agent`, `mcp_tool`):
    - `PreToolUse`: deny на запись в защищённые пути (базлайны, пороги, конфиги CI и линтеров).
    - `PostToolUse`: формат и линт изменённого файла.
    - `Stop`: не даёт агенту завершить работу, пока `verify` для затронутого не зелёный (exit 2 возвращает причину агенту).
    - `SessionStart`: подгрузка контекста.
  - Skills (`.claude/skills/*/SKILL.md`): как написать фичу end-to-end, как писать E2E и визуальные тесты, как триажировать визуальный дифф, как разбирать перф-регрессию.
  - Subagents (`.claude/agents/`): специализированные ревьюеры (архитектура, здравый смысл, качество и полнота тестов, безопасность, продуктовая логика). Их можно вызывать на этапе плана и на этапе PR.
  - Позже упакуем всё это в плагин для переиспользования в других репозиториях.
- **В PR:** `anthropics/claude-code-action@v1` с официальным плагином `code-review` (`plugin_marketplaces: https://github.com/anthropics/claude-plugins-official.git`, `plugins: code-review@claude-plugins-official`) и нашими субагентами-ревьюерами. Дополнительно `anthropics/claude-code-security-review@v1`. Комментарии ревьюеров информационные, merge блокирует только явный «блокер», подтверждённый детерминированной проверкой или человеком.
- **Playwright Test Agents** для генерации и починки E2E. **Argos skills** (`argos-cli`, `argos-pr-review`) для триажа визуальных диффов, если подключаем Argos.

### CI/CD на GitHub

- **Merge queue** через repository ruleset. Все обязательные workflow должны слушать `merge_group`, иначе очередь будет ждать вечно.
- **Единый gate-джоб** (rollup): affected-джобы могут быть пропущены, а required check только один, и он агрегирует результаты (`if: always()`). Лёгкие проверки идут на `pull_request`, тяжёлые и продуктовые инварианты на `merge_group`.
- **Affected:** `turbo run ... --affected` + remote cache (self-hosted или Vercel) + `concurrency` с отменой устаревших прогонов + шардирование Playwright.
- **Защищённые пути:** отдельный джоб падает, если PR меняет базлайны, пороги или конфиги проверок без одобрения CODEOWNERS.
- **Безопасность и зависимости:** CodeQL, сканирование секретов, Renovate с группировкой, supply-chain дефолты pnpm.

## Сверка с исходным анализом

✅ подтверждено · ⚠️ частично или с уточнением · ❌ не подтвердилось · ❔ не проверял

| Утверждение                                                                     | Статус | Комментарий                                                                                                                                                                                       |
| ------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP и CLI встроены в Playwright с 1.62                                          | ✅     | 1.62 вышел 24.07.2026. Брать 1.62.1+                                                                                                                                                              |
| Test Agents с 1.56, `init-agents --loop=claude`, перегенерация после апдейта    | ✅     |                                                                                                                                                                                                   |
| `browser.bind()` с 1.59                                                         | ✅     |                                                                                                                                                                                                   |
| Video receipts с 1.59, VP9 и настраиваемый fps                                  | ⚠️     | VP9 и опция `fps` появились в **1.64**                                                                                                                                                            |
| `--debug=cli`, `npx playwright trace`                                           | ✅     | 1.59                                                                                                                                                                                              |
| Aria-снапшоты для AI, `getByRef()`, `Locator.within()`                          | ✅     | `getByRef` и `within` в 1.64. `browser_find` ❔                                                                                                                                                   |
| Виртуальные passkeys в 1.61                                                     | ❔     | В 1.64 добавлен `sign_count` для virtual credential, значит фича существует, версию не проверял                                                                                                   |
| Test locks в 1.63, WebMCP в 1.64                                                | ✅     | В 1.64 locks работают на файл и группу                                                                                                                                                            |
| Цифры Slack Engineering                                                         | ✅     | Совпадают: 0/12% MCP, 48% у сгенерированных на сложном флоу, 70–80% сценария, $15–30, контекст как драйвер стоимости                                                                              |
| Octomind закрылся, Microsoft Playwright Testing закрыт в марте                  | ❔     |                                                                                                                                                                                                   |
| Selenium: 45% против 22%, флак 0.8% против 4.1%                                 | ❔     | Похоже на маркетинговую статистику, не опираемся                                                                                                                                                  |
| `toHaveScreenshot` с WebP в 1.64                                                | ✅     |                                                                                                                                                                                                   |
| `--update-snapshots=missing` засчитывается как passed                           | ❔     | Сам флаг существует давно, поведение «passed» не проверял                                                                                                                                         |
| Component testing → stories/galleries в 1.62                                    | ✅     | Более того, в текущих доках CT-пакеты уже удалены                                                                                                                                                 |
| Vitest `toMatchScreenshot` стабилен с 4, жив в 5.0                              | ✅     | Vitest 5.0 вышел 03.09.2026. В main-доках есть встроенный `standard-ssim`                                                                                                                         |
| Chromatic для Vitest в GA с сентября 2026, от $249                              | ❌     | Документация Chromatic всё ещё помечает интеграцию как beta / early access. По сравнению Argos, Chromatic стоит от $179 в месяц                                                                   |
| Argos: $10 за пользователя, бесплатно для OSS                                   | ❌     | Hobby бесплатно до 5k скриншотов в месяц, Pro **$100 в месяц фиксировано** без ограничения участников (35k скриншотов). Отдельной OSS-программы на странице цен нет. MCP, CLI `--json` и скилы ✅ |
| MUI ушёл с Argos на GitHub Actions                                              | ❔     |                                                                                                                                                                                                   |
| lost-pixel заархивирован в апреле 2026                                          | ✅     | 22.04.2026, команда ушла в Figma                                                                                                                                                                  |
| Storybook test-runner прекращён, замена на addon-vitest без `toMatchScreenshot` | ✅     | По состоянию на ноябрь 2025, могло измениться                                                                                                                                                     |
| BackstopJS дормант, Loki без Storybook 10, Differencify мёртв                   | ❔     |                                                                                                                                                                                                   |
| DiffSpot: VLM ловят в среднем 43%, на мобильных 15%                             | ⚠️     | Лучшая модель 40.7% (статья) / 47.2% (лидерборд), Hard-tier ниже 23%. Цифру для мобильных не нашёл. Вывод «LLM не заменяет пиксельный дифф» остаётся в силе                                       |
| Chrome DevTools MCP: perf-трейсы, Lighthouse, heap                              | ✅     | Телеметрию нужно отключать флагами                                                                                                                                                                |
| Рекомендация: агент через CLI, MCP для exploratory, связка через `bind()`       | ⚠️     | У Slack CLI оказался **менее** надёжным, чем MCP (12–20% против 0–12%) и медленнее. Берём оба, но для исследовательских прогонов по умолчанию MCP                                                 |

## Открытые решения (кандидаты в ADR)

1. **Vite+ целиком или те же инструменты напрямую + Turborepo.** Предлагаю второй вариант.
2. **TanStack Start или Next.js 16.** Предлагаю Start.
3. **Hono + oRPC, Fastify или NestJS.** Предлагаю Hono + oRPC.
4. **pnpm 11 или 12.** Решаем бенчмарком при бутстрапе.
5. **Визуальное ревью: Argos или только артефакты в CI.** Предлагаю начать с артефактов, Argos подключить, когда диффов станет много.
6. **CodSpeed (SaaS) или self-hosted бенчмарки.**
7. **Когда переходить на Nx** с распределённым CI: триггер — p50 PR CI больше 10 минут при включённом кэше.

## Источники

- Playwright: [release notes](https://playwright.dev/docs/release-notes), [разбор 1.64 (TestDino)](https://testdino.com/blog/playwright-1-64-release), [1.62 (bug0)](https://bug0.com/blog/whats-new-playwright-1-62), [component testing stories (issue #42139)](https://github.com/microsoft/playwright/issues/42139)
- [Slack Engineering: Agentic Testing](https://slack.engineering/agentic-testing-where-agents-fit-in-the-e2e-testing-stack/)
- Vitest: [releases](https://vitest.dev/releases), [visual regression testing](https://vitest.dev/guide/browser/visual-regression-testing)
- [Chromatic for Vitest (beta)](https://chromatic.com/docs/vitest), [Argos pricing](https://argos-ci.com/pricing), [Argos для агентов](https://argos-ci.com/ai-agents), [lost-pixel (archived)](https://github.com/lost-pixel/lost-pixel), [Storybook test-runner](https://storybook.js.org/docs/writing-tests/integrations/test-runner)
- [DiffSpot (arXiv 2605.29615)](https://arxiv.org/html/2605.29615v1), [Tencent/DiffSpot](https://github.com/Tencent/DiffSpot)
- [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)
- TypeScript 7: [обзор RC](https://www.digitalapplied.com/blog/typescript-7-0-rc-go-native-compiler-2026-upgrade-guide), [Wikipedia](https://en.wikipedia.org/wiki/TypeScript)
- [Vite 8](https://vite.dev/blog/announcing-vite8), [Rolldown 1.0](https://voidzero.dev/posts/announcing-rolldown-1-0), [Vite+ 1.0](https://voidzero.dev/posts/announcing-vite-plus-1-0)
- Oxc: [JS plugins alpha](https://oxc.rs/blog/2026-03-11-oxlint-js-plugins-alpha), [React Compiler support](https://oxc.rs/blog/2026-08-18-react-compiler-support), [Oxlint vs Biome vs ESLint (бенчмарк)](https://dev.to/fabwaseem/oxlint-vs-biome-vs-eslint-in-2026-benchmarked-on-a-real-nextjs-codebase-3lal)
- [Turborepo 2.10](https://turborepo.dev/blog/2-10), [Nx vs Turborepo](https://nx.dev/docs/guides/adopting-nx/nx-vs-turborepo)
- pnpm: [11 RC (InfoQ)](https://www.infoq.com/news/2026/04/pnpm-11-rc-release/), [12.0](https://pnpm.io/blog/releases/12.0/)
- [Node.js release schedule](https://nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule)
- [React 19.3](https://react.dev/blog/2026/09/09/react-19-3), [TanStack Start 1.0](https://tech-insider.org/tanstack-start-1-0-stable-release-2026/), [TanStack Start vs Next.js](https://makerkit.dev/blog/tutorials/tanstack-start-vs-nextjs)
- [oRPC comparison](https://orpc.dev/docs/comparison), [Hono/Fastify/NestJS (Encore, ангажированный источник)](https://encore.dev/articles/nestjs-vs-fastify-vs-hono), [Drizzle vs Prisma 2026](https://dev.to/fabwaseem/drizzle-vs-prisma-in-2026-benchmarks-drizzle-10-prisma-8-and-which-to-choose-je2)
- [StrykerJS releases](https://github.com/stryker-mutator/stryker-js/releases), [Supercov: mutation testing AI-тестов](https://supercov.com/blog/mutation-testing-ai-generated-tests)
- [Knip, dependency-cruiser, sherif: обзор](https://repowise.dev/blog/comparisons/best-dependency-graph-tools-monorepos), [Lefthook vs husky](https://www.pkgpulse.com/guides/husky-vs-lefthook-vs-lint-staged-git-hooks-nodejs-2026)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks), [claude-code-action](https://github.com/marketplace/actions/claude-code-action-official), [AGENTS.md и AAIF](https://openai.com/index/agentic-ai-foundation/)
- [GitHub merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue), [required checks в монорепо (Mixpanel)](https://medium.com/mixpaneleng/enforcing-required-checks-on-conditional-ci-jobs-in-a-github-monorepo-8d4949694340)
- [Lighthouse CI + k6 в PR](https://contextqa.com/blog/performance-testing-tools-2026/)
