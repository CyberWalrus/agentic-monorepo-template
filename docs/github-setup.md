# Настройка GitHub

Пайплайны лежат в репозитории, но часть настроек живёт в самом GitHub. Их делает мейнтейнер один раз, после создания проекта из шаблона.

## 1. Ruleset для `main` (единый gate)

Создайте в UI (Settings → Rules → Rulesets) по снимку [`.github/rulesets/main.json`](../.github/rulesets/main.json):

- merge только через PR;
- обязательные check-и — **`gate`** (агрегирует job-ы CI) и **`gate-integrity`** ([ADR 0002](adr/0002-gate-integrity.md): доверенный workflow на `pull_request_target` из базовой ветки, код PR не читается и не исполняется). Третий обязательный check — **`bundle-approval`** ([ADR 0013](adr/0013-bundle-delta-gate.md): доверенное одобрение роста бандла) — в снимке сознательно отсутствует и добавляется вручную шагом 3 чек-листа ниже, после создания label;
- 1 апрув, обязательное ревью **CODEOWNERS**, сброс апрува при новом push, апрув последнего push, разрешённые треды;
- запрет force-push и удаления ветки, линейная история; merge-метод — только squash;
- **строгая база** (`Require branches to be up to date before merging`, в снимке — `strict_required_status_checks_policy: true`): PR сливается только с веткой, обновлённой до текущего `main` — главный эффект L4: `gate` проходит на смёрженном состоянии, и два PR, зелёных по отдельности, не дают вместе красный `main` (A9). Полный эффект L4 («всё то же без affected-сокращений») даёт только merge queue: интерференции вне affected-наборов по-прежнему ловит CI на `push: main`.

Чек-лист обязательных check (согласованность снимка и этого списка держит канарейка `tools/test/setup-docs-consistency.test.ts`):

1. Создать ruleset из снимка: в нём два обязательных check — `gate` и `gate-integrity`.
2. Создать label `bundle-growth-approved` (раздел 2).
3. Добавить `bundle-approval` в required checks того же ruleset (Edit ruleset → Required status checks → `bundle-approval`). Без этого шага рост бандла сверх 5 КБ не блокирует merge вообще — окно ADR 0013 закрывается именно здесь.

Merge queue, если доступна на вашем тарифе, стоит включить: все обязательные workflow уже слушают `merge_group` (no-op job с тем же именем check), так что очередь не зависнет. Два режима:

- **с очередью** — очередь сама тестирует PR на смёрженном состоянии; флаг строгой базы можно выключить (лишнее обновление ветки перед каждым merge — только лишние прогоны);
- **без очереди** (шаблон по умолчанию) — строгая база обязательна: без неё PR проверяется на своей базе, и красный `main` увидит только CI после слияния.

Цена строгой базы без очереди: перед merge ветку нужно обновить до `main` (`gh pr update-branch`, для неё включён repo-setting «Allow updating pull request branches», или merge `main` в ветку), и `gate` прогонится заново. Обновление ветки — это push: по правилам ruleset сбрасываются апрув и, для изменений гейтов, label `gate-change-approved` — нужен повторный приём человеком. Условие пересмотра — задача A9 доски шаблона: обновления, повторные прогоны и переапрувы отнимают у приёмки больше 30 минут в день три дня подряд — тогда merge queue (смена тарифа) или тревога по красному `main` как временная мера.

Там же в настройках репозитория (Settings → General → Pull Requests) включите **Automatically delete head branches** (A9): head-ветки смерженных PR удаляются из origin автоматически — чистый origin и поиск по веткам; расчёт статусов доски это не задевает (он читает только локальные ветки). Настройка действует только на будущие merge: существующие лишние ветки удаляются разово вручную (`git branch -r | grep -v main` на момент применения — 2026-11-17 их 14).

И там же (Settings → Actions → General → **Workflow permissions**) выставьте **Read permissions**. Дефолт «Read and write» можно перевернуть на уровне организации — тогда анти-подделка check-run молча исчезает: доверенные `gate-integrity` и `bundle-approval` сверяют факты с GitHub API в расчёте на то, что чужой check-run создать может только токен с `checks: write` ([ADR 0002](adr/0002-gate-integrity.md), [ADR 0013](adr/0013-bundle-delta-gate.md)). Нужные для работы write-правья выдаются явным `permissions:` в самих workflow — дефолт остаётся read-only (d17).

## 2. Labelы для гейтов

Создайте labelы: `gate-change-approved` (одобрение изменения гейтов мейнтейнером, действует только после последнего push — `gate-integrity` снимает label на новом push), `bundle-growth-approved` (одобрение роста бандла сверх 5 КБ за PR, тот же механизм снятия и свежести — [ADR 0013](adr/0013-bundle-delta-gate.md)), `perf-regression` (открытое issue ночной регрессии времени; тренд-чекер дедуплицирует по заголовку и комментирует существующее issue, [ADR 0006](adr/0006-perf-strategy.md)) и `nightly-failure`.

```sh
gh label create gate-change-approved --color 0E8A16 --description "Gate change approved by maintainer"
gh label create bundle-growth-approved --color D93F0B --description "Bundle growth approved by maintainer"
gh label create perf-regression --color F9A625 --description "Nightly perf regression issue"
gh label create nightly-failure --color D93F0B --description "Nightly checks failed"
```

Изменение deny-файлов (см. `tools/protected-paths.json`) проверяет `gate-integrity` из доверенной базы: без label — красный, с label от глобального владельца CODEOWNERS после последнего push — зелёный.

## 3. Политика исполнения workflow (pull_request_target)

GitHub с 2026-12-02 блокирует `pull_request_target` в публичных репозиториях без явной политики. Создайте (Settings → Actions → Policies):

- таргет: `.github/workflows/gate-integrity.yml` и `.github/workflows/visual-approve.yml` ([ADR 0015](adr/0015-visual-baselines-approval.md), b3.1 — добавляет человек после мёржа);
- Restrict events → allowed: `pull_request_target`, `merge_group`, `issue_comment`.

Любое расширение триггеров этого workflow — через правку политики тем же процессом, что и правка гейтов ([ADR 0002](adr/0002-gate-integrity.md)).

## 4. Секреты и переменные

| Имя                                               | Где                                      | Тип      | Зачем                                                                                     |
| ------------------------------------------------- | ---------------------------------------- | -------- | ----------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY` или `CLAUDE_CODE_OAUTH_TOKEN` | репозиторий                              | secret   | Агентное ревью (`agent-review.yml`). Без него ревью пропускается                          |
| `TURBO_TOKEN` — read-only токен                   | environment `cache-read`                 | secret   | Чтение remote cache в PR-job'ах (опционально; [ADR 0017](adr/0017-remote-cache-trust.md)) |
| `TURBO_TOKEN` — токен на запись                   | environment `cache-write`                | secret   | Запись remote cache только на push в `main`                                               |
| `TURBO_TEAM`, `TURBO_API`                         | environment `cache-read` и `cache-write` | variable | Команда и адрес remote cache (для self-hosted — свой URL)                                 |

Turbo-секреты держать **только** в environment `cache-read`/`cache-write`, не на уровне репозитория: repo-секрет наследуют все job, включая не имеющие environment, и граница доверия remote cache замолкает без единого красного гейта ([ADR 0017](adr/0017-remote-cache-trust.md), `docs/architecture.md` §3.3). В workflow ссылка одна — `secrets.TURBO_TOKEN`; значение подставляется из environment конкретного job'а. Environment `cache-read` не включать required reviewers и wait timer — иначе зависнут PR-job'ы.

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
