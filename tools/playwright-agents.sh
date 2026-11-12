#!/usr/bin/env bash
# Перегенерирует Playwright Test Agents (planner, generator, healer) и применяет политику репозитория.
# Запускать после каждого обновления Playwright: определения агентов привязаны к его версии.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENTS="$ROOT/.claude/agents"
POLICY="$ROOT/tools/playwright-agents"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

(cd "$TMP" && "$ROOT/e2e/node_modules/.bin/playwright" init-agents --loop=claude >/dev/null)

for name in planner generator healer; do
  node - "$TMP/.claude/agents/playwright-test-$name.md" "$AGENTS/playwright-test-$name.md" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const [src, dst] = process.argv.slice(2);
let text = readFileSync(src, 'utf8')
  // Пути seed и планов в структуре этого репозитория.
  .replaceAll('tests/seed.spec.ts', 'e2e/agents/seed.spec.ts')
  .replace(/(^|[^/\w])specs\/plan\.md/g, '$1e2e/specs/plan.md')
  // Штатный Healer помечает непочиненный тест test.fixme() — это «тихое залечивание», вырезаем.
  .replace(/^- If the error persists[\s\S]*?(?=^- )/m, '')
  .replace('do the most reasonable thing possible to pass the test.', 'do the most reasonable thing to make the test correct, not merely passing.');
writeFileSync(dst, text);
NODE
done

append() { printf '\n\n' >>"$2" && cat "$1" >>"$2"; }
append "$POLICY/healer-policy.md" "$AGENTS/playwright-test-healer.md"
append "$POLICY/common-policy.md" "$AGENTS/playwright-test-planner.md"
append "$POLICY/common-policy.md" "$AGENTS/playwright-test-generator.md"

# Если upstream поменял формулировку и вырезать не получилось — остановиться, нужен человек.
if sed '/^## Repository policy/,$d' "$AGENTS/playwright-test-healer.md" | grep -qi 'fixme'; then
  echo "playwright-test-healer still instructs to use fixme: update tools/playwright-agents.sh" >&2
  exit 1
fi

"$ROOT/node_modules/.bin/oxfmt" "$AGENTS"/playwright-test-*.md >/dev/null
echo "Playwright Test Agents regenerated with repository policy."
