# Настройка GitHub

Пайплайны лежат в репозитории, но часть настроек живёт в самом GitHub. Их делает мейнтейнер один раз.

## 1. Ruleset для `main` (merge queue + единый gate)

```bash
gh api repos/CyberWalrus/agentic-monorepo-template/rulesets --method POST --input .github/rulesets/main.json
```

Что включает [`.github/rulesets/main.json`](../.github/rulesets/main.json):

- merge только через PR и **merge queue** (squash, группировка ALLGREEN);
- единственный обязательный check — **`gate`**: он агрегирует все джобы CI, поэтому пропущенные affected-джобы не блокируют очередь;
- 1 апрув, обязательное ревью **CODEOWNERS**, сброс апрува при новом push, апрув последнего push, разрешённые треды;
- запрет force-push и удаления ветки, линейная история.

Все обязательные workflow слушают `merge_group`, иначе очередь будет ждать вечно.

## 2. Label для изменения гейтов

```bash
gh label create gate-change-approved --color B60205 --description "Maintainer approved a change to quality gates"
gh label create nightly-failure --color D93F0B --description "Nightly checks failed"
```

Job `protected-paths` падает, если PR меняет файлы из `tools/protected-paths.json` (`deny`) без этого label. Ставить label может только мейнтейнер: ограничьте роль triage для ботов и агентов.

## 3. Секреты и переменные

| Имя                                               | Тип      | Зачем                                                            |
| ------------------------------------------------- | -------- | ---------------------------------------------------------------- |
| `ANTHROPIC_API_KEY` или `CLAUDE_CODE_OAUTH_TOKEN` | secret   | Агентное ревью (`agent-review.yml`). Без него ревью пропускается |
| `TURBO_TOKEN`                                     | secret   | Remote cache Turborepo (опционально)                             |
| `TURBO_TEAM`, `TURBO_API`                         | variable | Команда и адрес remote cache (для self-hosted — свой URL)        |

Для агентного ревью установите Claude GitHub App: `claude` → `/install-github-app`.

## 4. Renovate

Установите Renovate GitHub App. Конфиг лежит в [`.github/renovate.json`](../.github/renovate.json): обновления раз в неделю, `minimumReleaseAge` 3 дня, Playwright отдельной группой (после обновления — `tools/playwright-agents.sh` и `pnpm visual`).

## 5. CODEOWNERS

Замените `@CyberWalrus` в [`.github/CODEOWNERS`](../.github/CODEOWNERS) на команды организации (например, `@org/platform` для гейтов, `@org/api` для контрактов).
