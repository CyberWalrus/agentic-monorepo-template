#!/usr/bin/env bash
# Визуальные тесты внутри образа mcr.microsoft.com/playwright (локально через tools/visual.sh, в CI напрямую).
# VISUAL_UPDATE=1 — перезаписать базлайны (делает только человек; в CI —
# фаза перезаписи tools/visual-ci.sh, ADR 0015). PLAYWRIGHT_UPDATE_MODE —
# режим Playwright: по умолчанию all (локальный поток человека), CI перезаписи
# передаёт changed (только разошедшиеся снимки, без churn неизменных).
set -euo pipefail

if [[ "${VISUAL_UPDATE:-}" == "1" ]]; then
  vitest_flags=(--update)
  playwright_flags=(--update-snapshots="${PLAYWRIGHT_UPDATE_MODE:-all}")
else
  vitest_flags=()
  playwright_flags=(--update-snapshots=none)
fi

status=0
pnpm --filter @repo/ui exec vitest run --project visual "${vitest_flags[@]}" || status=$?
pnpm turbo run build --filter=@repo/web --output-logs=errors-only
pnpm --filter @repo/e2e exec playwright test --project=visual "${playwright_flags[@]}" || status=$?
exit "$status"
