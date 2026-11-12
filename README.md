# agentic-monorepo-template

Шаблон монорепозитория (frontend + backend) для разработки силами AI-агентов. Агенты могут «вайбкодить» фичи, а инфраструктура быстро и объективно не пускает в `main` код, который недостаточно хорош.

Продукт внутри намеренно абстрактный (список задач). Ценность репозитория в обвязке. Зачем всё это: [docs/vision.md](docs/vision.md).

## Быстрый старт

```bash
nvm use            # Node из .nvmrc
pnpm install       # pnpm из packageManager; ставит git-хуки
pnpm verify        # все быстрые гейты (~1–5 с с кэшем)
pnpm dev           # web http://localhost:3000, api http://localhost:3001
```

Скриншот-тесты требуют Docker: `pnpm visual`.

## Стек

Node (`.nvmrc`) · pnpm (`packageManager`) · Turborepo · TypeScript · Oxlint + Oxfmt · Vite (Rolldown) · React + TanStack Start + TanStack Query · Hono + oRPC + Zod · Vitest browser mode · Playwright · dependency-cruiser · Knip · sherif · StrykerJS · Lefthook.

Версии зависимостей — только в каталоге `catalog:` в [pnpm-workspace.yaml](pnpm-workspace.yaml). Почему именно так: [ADR 0001](docs/adr/0001-initial-stack.md), [исследование стека](docs/research/2026-11-tech-stack.md).

## Контуры проверки

| Контур             | Где                                        | Что                                                                                                                                                  | Время на демо    |
| ------------------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| **L0 агент**       | хуки Claude Code (`.claude/settings.json`) | формат и type-aware линт каждой правки; запрет записи в защищённые пути и обхода гейтов; агент не может завершить работу, пока `pnpm verify` красный | ~0.2 с на правку |
| **L1 pre-commit**  | Lefthook                                   | Oxfmt + Oxlint по staged-файлам                                                                                                                      | < 1 с            |
| **L2 pre-push**    | Lefthook                                   | typecheck, unit, границы модулей                                                                                                                     | ~2 с             |
| **L3 PR**          | GitHub Actions `ci.yml`                    | статика, affected unit/mutation/E2E, скриншоты в Docker, перф-бюджеты, бюджет бандла, k6, защищённые пути → единый check **`gate`**                  | —                |
| **L4 merge queue** | ruleset + `merge_group`                    | всё то же на смёрженном состоянии, без affected-сокращений                                                                                           | —                |
| **L5 nightly**     | `nightly.yml`                              | E2E в случайном порядке x5, полный mutation, тренд перфа                                                                                             | —                |
| **Ревью**          | `agent-review.yml`                         | официальный `code-review` + 5 субагентов-ревьюеров (информационно, не блокирует)                                                                     | —                |

`pnpm verify --full` (статика + unit + сборка + бандл + E2E + перф) локально проходит примерно за 8 с.

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
e2e                 Playwright: features, visual, perf, agents (seed)
tools               гейты: verify, бюджеты, защищённые пути, Docker-скриншоты
.claude             хуки, скилы, субагенты-ревьюеры, Playwright Test Agents
.github             CI, агентное ревью, nightly, ruleset, CODEOWNERS, Renovate
```

## Документы

- [Зачем нужна система](docs/vision.md)
- [Исследование стека, ноябрь 2026](docs/research/2026-11-tech-stack.md)
- [ADR 0001: стек первой реализации](docs/adr/0001-initial-stack.md)
- [Архитектурные и инфраструктурные подходы](docs/architecture.md): законы обвязки, слои, правила изменения гейтов
- [План развития обвязки](docs/roadmap.md): аудит от 2026-11-12, что переделать, улучшить и добавить
- [Настройка GitHub](docs/github-setup.md): ruleset, labels, секреты
- [AGENTS.md](AGENTS.md) и [CLAUDE.md](CLAUDE.md): инструкции для агентов
