#!/usr/bin/env bash
# CI-фаза визуальных тестов (b3.1, ADR 0015): обычный прогон (дифф = красный
# job с отчётом), затем — если есть расхождение — тихий прогон с перезаписью
# только изменившихся базлайнов (PLAYWRIGHT_UPDATE_MODE=changed; vitest -u
# переписывает только разошедшиеся). Изменённые канонические пути собираются
# из `git status --porcelain` в артефакт visual-actuals: manifest.json
# (headSha + список файлов) + сами png по путям репозитория. Артефакт коммитит
# в ветку PR только доверенный workflow visual-approve (одобрение мейнтейнера
# командой /approve-visual — источник истины снимков один, CI).
#
# Локальный человек делает то же самое руками: pnpm visual, просмотр, pnpm
# visual:update (A8). Здесь — автоматическая фаза перезаписи, потому что job
# уже изолирован и одноразов.
set -euo pipefail

root="$(pwd)"
status=0
bash tools/visual-inner.sh || status=$?

if [ "$status" -eq 0 ]; then
  exit 0
fi

echo "Visual diff detected — regenerating baselines from CI (changed only)..."
VISUAL_UPDATE=1 PLAYWRIGHT_UPDATE_MODE=changed bash tools/visual-inner.sh

changed="$(git status --porcelain | awk '{print $2}' | grep -E '^((e2e|packages/ui)/.*__screenshots__/.*\.png)$' || true)"
if [ -z "$changed" ]; then
  echo "No baseline files changed by the update run — the diff is flaky, failing loudly." >&2
  exit 1
fi

mkdir -p visual-actuals
files_json="["
first=true
for file in $changed; do
  mkdir -p "visual-actuals/$(dirname "$file")"
  cp "$file" "visual-actuals/$file"
  if [ "$first" = true ]; then first=false; else files_json+=","; fi
  files_json+="\"$file\""
  echo "$file" >> visual-actuals/FILES.txt
done
files_json+="]"
head_sha="$(git rev-parse HEAD)"
printf '{"headSha": "%s", "files": %s}\n' "$head_sha" "$files_json" > visual-actuals/manifest.json

echo "Committed-candidate baselines:"
cat visual-actuals/FILES.txt
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "## Changed visual baselines (CI-generated, awaiting /approve-visual)"
    echo '```'
    cat visual-actuals/FILES.txt
    echo '```'
  } >> "$GITHUB_STEP_SUMMARY"
fi
# Job остаётся красным: дифф реален, человек смотрит отчёт; артефакт ждёт одобрения.
exit 1
