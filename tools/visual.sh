#!/usr/bin/env bash
# Запуск визуальных тестов в том же Docker-образе и на той же архитектуре, что и CI.
#   pnpm visual          сравнить с базлайнами
#   pnpm visual:update   перезаписать базлайны (только человек; агентам запрещено хуком)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLAYWRIGHT_VERSION="$(node -p "require('$ROOT/e2e/node_modules/@playwright/test/package.json').version")"
IMAGE="mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble"
PNPM_VERSION="$(node -p "require('$ROOT/package.json').packageManager.split('@')[1]")"
OUT="$ROOT/reports/visual"
rm -rf "$OUT" && mkdir -p "$OUT"

docker run --rm --platform linux/amd64 --ipc=host \
  -v "$ROOT":/src:ro \
  -v agentic-template-pnpm-store:/pnpm-store \
  -v "$OUT":/out \
  -e CI=1 -e TURBO_TELEMETRY_DISABLED=1 -e VISUAL_UPDATE="${VISUAL_UPDATE:-}" \
  "$IMAGE" bash -euo pipefail -c "
    mkdir -p /work
    tar -C /src --exclude=node_modules --exclude=.git --exclude=.turbo --exclude=dist --exclude=reports \
      --exclude=test-results --exclude=playwright-report --exclude=.vitest -cf - . | tar -C /work -xf -
    cd /work
    npm install -g pnpm@${PNPM_VERSION} --silent >/dev/null 2>&1
    pnpm config set store-dir /pnpm-store >/dev/null
    pnpm install --frozen-lockfile --reporter=silent
    status=0
    bash tools/visual-inner.sh || status=\$?
    # Наружу: базлайны (после --update) и отчёты о диффах.
    find . -path ./node_modules -prune -o -type d -name __screenshots__ -print | while read -r dir; do
      mkdir -p \"/out/screenshots/\$dir\" && cp -r \"\$dir/.\" \"/out/screenshots/\$dir/\"
    done
    for dir in e2e/playwright-report e2e/test-results packages/ui/.vitest; do
      [ -d \"\$dir\" ] && mkdir -p \"/out/\$dir\" && cp -r \"\$dir/.\" \"/out/\$dir/\"
    done
    exit \$status
  " && status=0 || status=$?

if [[ "${VISUAL_UPDATE:-}" == "1" && -d "$OUT/screenshots" ]]; then
  (cd "$OUT/screenshots" && find . -type f -print0 | while IFS= read -r -d '' file; do
    mkdir -p "$ROOT/$(dirname "$file")" && cp "$file" "$ROOT/$file"
  done)
  echo "Baselines updated. Review the image diffs before committing."
fi

[[ $status -ne 0 ]] && echo "Visual diffs: $OUT (e2e/playwright-report, packages/ui/.vitest/attachments)"
exit $status
