# ZCode-плагин контура гейтов (C10.3)

ZCode не исполняет хуки уровня проекта из `.claude/settings.json` (проверено 2026-11-14).
Плагин подключает тот же контур L0 через механизм плагинов: ZCode исполняет
`hooks/hooks.json` плагина (формат совместим с Claude Code — `matcher`, `type: command`,
stdin-JSON на входе, код выхода **2** блокирует действие).

## Установка (локальный режим — единственный поддерживаемый)

Плагин — тонкая проводка: CLI живёт в репозитории (`tools/hooks/`, C10.1), плагин
вызывает **те же** скрипты, что и хуки Claude Code. Поэтому плагин ставится из чекаута
репозитория (локальный режим, без копирования в кэш плагинов):

1. Открой проект в ZCode.
2. Подключи плагин из каталога `tools/zcode-plugin` этого репозитория как локальный
   (Filesystem source). `${CLAUDE_PLUGIN_ROOT}` должен указывать на `tools/zcode-plugin`
   **внутри чекаута** — тогда `hooks/run-cli.sh` находит `tools/hooks/*` рядом.

Если плагин оказался скопирован в кэш плагинов в отрыве от репозитория, каждый хук
срабатывает fail-closed: `run-cli.sh` не находит `tools/hooks/` и завершается с кодом 2
(блок) с объяснением в stderr — контур не может «тихо исчезнуть» (З4).

## Гарантии и расхождения

- **Те же CLI**: `session-start`, `protect-paths` (PreToolUse Edit|Write|MultiEdit|NotebookEdit),
  `guard-bash` (PreToolUse Bash), `protect-result` (PostToolUse Bash + Stop),
  `lint-changed-file` (PostToolUse Edit|Write|MultiEdit), `stop-verify` (Stop) —
  тот же набор и matcher'ы, что в `.claude/settings.json` (согласованность держит
  тест `tools/test/zcode-plugin.test.ts`).
- **Формат входа совместим** с Claude Code по документации ZCode (snake_case-поля,
  `tool_input.file_path` и т.п.) — прогоном в живой сессии ZCode не проверено;
  детерминированная проверка CLI — smoke-тестом тем же прогоном (`run-cli.sh` +
  stdin), живая активация — за человеком при включении плагина в клиенте.
- Порог таймаутов повторяет `.claude/settings.json` (10/30/300 с).

## Журнал отказов

Связка с журналом отказов гейтов — задача C9.3 (счётчик попыток обхода); пока C9.3 не
заземлена, отказы видны в stderr хука и в ответе инструмента, но не агрегируются.
