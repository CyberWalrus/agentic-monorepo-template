# Настройка GitHub

Пайплайны лежат в репозитории, но часть настроек живёт в самом GitHub. Их делает мейнтейнер один раз, после создания проекта из шаблона.

## 1. Ruleset для `main` (единый gate)

Создайте в UI (Settings → Rules → Rulesets) по снимку [`.github/rulesets/main.json`](../.github/rulesets/main.json):

- merge только через PR;
- обязательные check-и — **`gate`** (агрегирует job-ы CI) и **`gate-integrity`** ([ADR 0002](adr/0002-gate-integrity.md): доверенный workflow на `pull_request_target` из базовой ветки, код PR не читается и не исполняется);
- 1 апрув, обязательное ревью **CODEOWNERS**, сброс апрува при новом push, апрув последнего push, разрешённые треды;
- запрет force-push и удаления ветки, линейная история; merge-метод — только squash;
- **строгая база** (`Require branches to be up to date before merging`, в снимке — `strict_required_status_checks_policy: true`): PR сливается только с веткой, обновлённой до текущего `main`, то есть `gate` проходит на смёрженном состоянии. Два PR, зелёных по отдельности, не дают вместе красный `main` — это контур L4 без merge queue (A9).

Merge queue, если доступна на вашем тарифе, стоит включить: все обязательные workflow уже слушают `merge_group` (no-op job с тем же именем check), так что очередь не зависнет. Два режима:

- **с очередью** — очередь сама тестирует PR на смёрженном состоянии; флаг строгой базы можно выключить (лишнее обновление ветки перед каждым merge — только лишние прогоны);
- **без очереди** (шаблон по умолчанию) — строгая база обязательна: без неё PR проверяется на своей базе, и красный `main` увидит только CI после слияния.

Цена строгой базы без очереди: перед merge ветку нужно обновить до `main` (`gh pr update-branch` или merge `main` в ветку), и `gate` прогонится заново. Условие пересмотра — [ADR 0009](adr/0009-operator-delegation.md)/задача A9: обновления отнимают у приёмки заметно больше получаса в день три дня подряд — тогда merge queue (смена тарифа) или тревога по красному `main` как временная мера.

Там же в настройках репозитория (Settings → General → Pull Requests) включите **Automatically delete head branches** (A9): head-ветки смерженных PR удаляются из origin автоматически. Без этого ветки закрытых задач остаются в origin (на 2026-11-15 их шесть) и засоряют вычисление статусов доски и поиск по веткам.

## 2. Labelы для гейтов

Создайте labelы: `gate-change-approved` (одобрение изменения гейтов мейнтейнером, действует только после последнего push — `gate-integrity` снимает label на новом push) и `nightly-failure`.

```bash
gh label create gate-change-approved --color B60205 --description "Maintainer approved a change to quality gates"
gh label create nightly-failure --color D93F0B --description "Nightly checks failed"
```

Изменение deny-файлов (см. `tools/protected-paths.json`) проверяет `gate-integrity` из доверенной базы: без label — красный, с label от глобального владельца CODEOWNERS после последнего push — зелёный.

## 3. Политика исполнения workflow (pull_request_target)

GitHub с 2026-12-02 блокирует `pull_request_target` в публичных репозиториях без явной политики. Создайте (Settings → Actions → Policies):

- таргет: только `.github/workflows/gate-integrity.yml`;
- Restrict events → allowed: `pull_request_target`, `merge_group`.

Любое расширение триггеров этого workflow — через правку политики тем же процессом, что и правка гейтов ([ADR 0002](adr/0002-gate-integrity.md)).

## 4. Секреты и переменные

| Имя                                               | Тип      | Зачем                                                            |
| ------------------------------------------------- | -------- | ---------------------------------------------------------------- |
| `ANTHROPIC_API_KEY` или `CLAUDE_CODE_OAUTH_TOKEN` | secret   | Агентное ревью (`agent-review.yml`). Без него ревью пропускается |
| `TURBO_TOKEN`                                     | secret   | Remote cache Turborepo (опционально)                             |
| `TURBO_TEAM`, `TURBO_API`                         | variable | Команда и адрес remote cache (для self-hosted — свой URL)        |

Для агентного ревью установите Claude GitHub App: `claude` → `/install-github-app`.

## 5. Renovate

Установите Renovate GitHub App. Конфиг лежит в [`.github/renovate.json`](../.github/renovate.json): обновления раз в неделю, `minimumReleaseAge` 3 дня, Playwright отдельной группой (после обновления — `tools/playwright-agents.sh` и `pnpm visual`).

## 6. CODEOWNERS

В копии проекта `.github/CODEOWNERS` уже создан `copier copy` с вашим владельцем из ответа `repo_owner` ([ADR 0008](adr/0008-template-distribution.md)). Замените владельцев на команды вашей организации (например, `@org/platform` для гейтов, `@org/api` для контрактов): `gate-integrity` доверяет label `gate-change-approved`, только если его поставил владелец из строки `*`. В самом шаблоне рабочий CODEOWNERS лежит в `docs/CODEOWNERS` — GitHub читает его, когда файла нет в `.github/`.

## 7. Ruleset для тегов `v*`

Создайте в UI (Settings → Rules → Rulesets) по снимку [`.github/rulesets/tags-v.json`](../.github/rulesets/tags-v.json):

- таргет — Tags, паттерн `v*`;
- запрет обновления и удаления существующих тегов; создание тегов не ограничено.

Тег — доверенная база: по нему Copier находит версию шаблона и обновляет проект ([ADR 0008](adr/0008-template-distribution.md), «Версии»). Переставленный или удалённый тег подменяет базу проекта — поэтому существующие теги `v*` неприкосновенны, а новые версии добавляются следующими по номеру.

## 8. Создание проекта из шаблона

Проект создаётся `copier copy` из **тега** `v*` шаблона, не из ветки или worktree: тег — доверенная база для будущих обновлений ([ADR 0008](adr/0008-template-distribution.md)). Версию Copier берите из [`tools/copier-version.txt`](../tools/copier-version.txt) — единственного источника закреплённой версии (З10; её же читает CI).

```bash
uvx --from "copier==$(cat tools/copier-version.txt)" \
  copier copy --vcs-ref=v0.1.0 \
  https://github.com/<владелец-шаблона>/agentic-monorepo-template.git \
  путь/до/проекта
```

Copier спросит имя проекта и владельца репозитория (`@организация` или `@пользователь`). Оба ответа обязательны; владелец попадёт в `CODEOWNERS` копии — без него ревью по CODEOWNERS не заработает и `gate-integrity` не станет зелёным. Ответы сохраняются в `.copier-answers.yml` проекта: по нему позже работает `copier update` — его запускает человек, результат идёт обычным PR с label `gate-change-approved` ([ADR 0008](adr/0008-template-distribution.md)).

Затем в копии выполните `pnpm install && pnpm verify` — должно быть зелёным. После этого пройдите разделы 1–6 выше.
