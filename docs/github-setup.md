# Настройка GitHub

Пайплайны лежат в репозитории, но часть настроек живёт в самом GitHub. Их делает мейнтейнер один раз. Состояние на 2026-11-12: пункты 1–3 выполнены, отмечены ✅.

## 1. ✅ Ruleset для `main` (единый gate)

Создан в UI (Settings → Rules → Rulesets, id `27137353`) по снимку [`.github/rulesets/main.json`](../.github/rulesets/main.json):

- merge только через PR;
- обязательные check-и — **`gate`** (агрегирует job-ы CI) и **`gate-integrity`** ([ADR 0002](adr/0002-gate-integrity.md): доверенный workflow на `pull_request_target` из базовой ветки, код PR не читается и не исполняется);
- 1 апрув, обязательное ревью **CODEOWNERS**, сброс апрува при новом push, апрув последнего push, разрешённые треды;
- запрет force-push и удаления ветки, линейная история; merge-метод — только squash.

Merge queue в интерфейсе для репозитория не доступна (пункт тарифа) — включается, когда появится. Все обязательные workflow уже слушают `merge_group` (no-op job с тем же именем check), так что очередь не зависнет.

## 2. ✅ Labelы для гейтов

Созданы: `gate-change-approved` (одобрение изменения гейтов мейнтейнером, действует только после последнего push — `gate-integrity` снимает label на новом push) и `nightly-failure`.

```bash
gh label create gate-change-approved --color B60205 --description "Maintainer approved a change to quality gates"
gh label create nightly-failure --color D93F0B --description "Nightly checks failed"
```

Изменение deny-файлов (см. `tools/protected-paths.json`) проверяет `gate-integrity` из доверенной базы: без label — красный, с label от глобального владельца CODEOWNERS после последнего push — зелёный.

## 3. ✅ Политика исполнения workflow (pull_request_target)

GitHub с 2026-12-02 блокирует `pull_request_target` в публичных репозиториях без явной политики. Создана (Settings → Actions → Policies, id `13436`, Active):

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

Замените `@CyberWalrus` в [`.github/CODEOWNERS`](../.github/CODEOWNERS) на команды организации (например, `@org/platform` для гейтов, `@org/api` для контрактов).
