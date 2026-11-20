#!/usr/bin/env bash
# Запуск визуальных тестов в том же Docker-образе и на той же архитектуре, что и CI.
# Зависимости предустановлены в локальном образе (b3.3, tools/visual.Dockerfile):
# слой установки привязан к pnpm-lock.yaml, тег несёт отпечаток всех вводов
# установки (локфайл, манифесты, версии pnpm/Playwright) — совпадение значит
# переиспользование образа без установки, смена любого ввода — пересборку,
# где frozen-lockfile поймает расхождение манифестов с локфайлом, как раньше.
# Источник базлайнов — CI (b3.1, ADR 0015): локальный прогон — предпросмотр.
#   pnpm visual          сравнить с базлайнами
#   pnpm visual:update   перезаписать базлайны (только человек; агентам запрещено хуком)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLAYWRIGHT_VERSION="$(node -p "require('$ROOT/e2e/node_modules/@playwright/test/package.json').version")"
PNPM_VERSION="$(node -p "require('$ROOT/package.json').packageManager.split('@')[1]")"
MANIFESTS=(pnpm-lock.yaml pnpm-workspace.yaml package.json e2e/package.json \
  packages/contracts/package.json packages/ui/package.json \
  apps/api/package.json apps/web/package.json)
IMAGE="agentic-template-visual:pw${PLAYWRIGHT_VERSION}-pnpm${PNPM_VERSION}-$(cat "$ROOT/${MANIFESTS[@]}" | shasum -a 256 | cut -c1-12)"
OUT="$ROOT/reports/visual"
rm -rf "$OUT" && mkdir -p "$OUT"

if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "visual: образ ${IMAGE} уже собран — зависимости не ставятся."
else
  echo "visual: собираю образ ${IMAGE} (установка зависимостей; повторится только при смене локфайла или манифестов)."
  # Контекст — временный каталог одних манифестов: кэш слоёв образа зависит
  # только от них, исходники в образ не попадают.
  CTX="$(mktemp -d)"
  trap 'rm -rf "$CTX"' EXIT
  for file in "${MANIFESTS[@]}"; do
    mkdir -p "$CTX/$(dirname "$file")"
    cp "$ROOT/$file" "$CTX/$file"
  done
  docker build --platform linux/amd64 \
    --build-arg PLAYWRIGHT_VERSION="$PLAYWRIGHT_VERSION" \
    --build-arg PNPM_VERSION="$PNPM_VERSION" \
    -f "$ROOT/tools/visual.Dockerfile" -t "$IMAGE" "$CTX"
fi

docker run --rm --platform linux/amd64 --ipc=host \
  -v "$ROOT":/src:ro \
  -v "$OUT":/out \
  -e CI=1 -e TURBO_TELEMETRY_DISABLED=1 -e VISUAL_UPDATE="${VISUAL_UPDATE:-}" \
  "$IMAGE" bash -euo pipefail -c "
    mkdir -p /work
    tar -C /src --exclude=node_modules --exclude=.git --exclude=.turbo --exclude=dist --exclude=reports \
      --exclude=test-results --exclude=playwright-report --exclude=.vitest -cf - . | tar -C /work -xf -
    cd /work
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
