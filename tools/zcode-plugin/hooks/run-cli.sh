#!/usr/bin/env bash
# C10.3: единая точка входа хуков ZCode-плагина. Резолвит CLI из tools/hooks/
# относительно корня плагина (плагин живёт внутри репозитория, tools/zcode-plugin).
#
# Fail-closed (З4):
# - нет репозитория или CLI (кэш-копия плагина в отрыве от репо) — exit 2 (блок)
#   с объяснением, а не «хук тихо исчез»;
# - CLI защищённых гейтов сигналит deny по протоколу Claude Code (JSON
#   permissionDecision:deny с exit 0), ZCode же по документации блокирует на
#   exit 2 — обёртка транслирует JSON-deny в exit 2 с причиной в stderr,
#   поэтому блокировка работает по обоим механизмам, а не «как повезёт».
set -u

plugin_root="${CLAUDE_PLUGIN_ROOT:-}"
cli="$1"

if [ -z "$plugin_root" ] || [ -z "$cli" ]; then
  echo "zcode-plugin: CLAUDE_PLUGIN_ROOT or CLI name is not set" >&2
  exit 2
fi

target="$plugin_root/../../tools/hooks/$cli"
if [ ! -f "$target" ]; then
  echo "zcode-plugin: $target not found — plugin is detached from the repository " >&2
  echo "(expected local mode: the plugin lives at tools/zcode-plugin inside the repo). " >&2
  echo "Blocking fail-closed (З4): install the plugin from the repository checkout." >&2
  exit 2
fi

out=$(node "$target")
code=$?
if [ "$code" -ne 0 ]; then
  exit "$code"
fi

case "$out" in
  *'"permissionDecision": "deny"'*|*'"permissionDecision":"deny"'*)
    printf '%s' "$out" | node -e "
      let s = '';
      process.stdin.on('data', (d) => (s += d));
      process.stdin.on('end', () => {
        try {
          const parsed = JSON.parse(s);
          console.error(parsed?.hookSpecificOutput?.permissionDecisionReason || 'denied by repository gate');
        } catch {
          console.error('denied by repository gate');
        }
      });
    " >&2
    exit 2
    ;;
  *)
    printf '%s' "$out"
    ;;
esac
