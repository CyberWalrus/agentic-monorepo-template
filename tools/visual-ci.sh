#!/usr/bin/env bash
# CI-фаза визуальных тестов (b3.1, ADR 0015): обычный прогон (дифф = красный
# job с отчётом), затем — если есть расхождение — тихий прогон с перезаписью
# только изменившихся базлайнов (PLAYWRIGHT_UPDATE_MODE=changed; vitest -u
# переписывает только разошедшиеся). Изменённые канонические пути собираются
# в артефакт visual-actuals: manifest.json (headSha + список) + png по путям
# репозитория. Артефакт коммитит в ветку PR только доверенный workflow
# visual-approve (одобрение мейнтейнера командой /approve-visual — источник
# истины снимков один, CI).
#
# headSha приходит из event-контекста (CI_HEAD_SHA = pull_request.head.sha,
# ставит ci.yml): checkout в PR — merge-ref, git rev-parse HEAD дал бы SHA
# мердж-коммита, не совпадающий с head PR (architecture/security-ревью b3.1).
# Локальный запуск (нет env) — fallback на rev-parse.
set -euo pipefail

status=0
bash tools/visual-inner.sh || status=$?

if [ "$status" -eq 0 ]; then
  exit 0
fi

echo "Visual diff detected — regenerating baselines from CI (changed only)..."

# Дифф-отчёт фазы 1 уезжает в сторону ДО фазы 2: Playwright чистит
# test-results и перезаписывает playwright-report — человеку перед одобрением
# нужен именно дифф (sanity-ревью b3.1, M1).
mkdir -p visual-diff
for dir in e2e/playwright-report e2e/test-results packages/ui/.vitest; do
  [ -e "$dir" ] && mv "$dir" "visual-diff/$(echo "$dir" | tr '/' '_')" || true
done

VISUAL_UPDATE=1 PLAYWRIGHT_UPDATE_MODE=changed bash tools/visual-inner.sh

# git status --porcelain --no-renames: изменённые, НОВЫЕ (untracked — PR
# добавляет визуальный тест) и удалённые базлайны (переименование = D+??
# пара); e2e пишет .webp (toHaveScreenshot type: webp), packages/ui — .png
# (sanity-ревью b3.1, B1/B3).
status="$(git status --porcelain --no-renames)"
changed="$(printf '%s\n' "$status" | awk '$1 !~ /D/ && $1 != "!!" { $1 = ""; sub(/^ +/, ""); print }' | grep -E '^((e2e|packages/ui)/.*__screenshots__/.*\.(png|webp))$' || true)"
removed="$(printf '%s\n' "$status" | awk '$1 ~ /D/ { $1 = ""; sub(/^ +/, ""); print }' | grep -E '^((e2e|packages/ui)/.*__screenshots__/.*\.(png|webp))$' || true)"
if [ -z "$changed" ] && [ -z "$removed" ]; then
  echo "No screenshot baselines changed by the update run — the diff is flaky, failing loudly." >&2
  exit 1
fi

head_sha="${CI_HEAD_SHA:-$(git rev-parse HEAD)}"
mkdir -p visual-actuals
node -e '
  const { mkdirSync, copyFileSync, writeFileSync } = require("node:fs");
  const { dirname, join } = require("node:path");
  const [headSha, filesRaw, deletedRaw] = process.argv.slice(1);
  const files = filesRaw.split("\n").filter(Boolean);
  const deleted = deletedRaw.split("\n").filter(Boolean);
  for (const file of files) {
    mkdirSync(join("visual-actuals", dirname(file)), { recursive: true });
    copyFileSync(file, join("visual-actuals", file));
  }
  writeFileSync(
    join("visual-actuals", "manifest.json"),
    JSON.stringify({ headSha, files, deleted }, null, 2) + "\n",
  );
  writeFileSync(
    "visual-actuals/FILES.txt",
    [...files, ...deleted.map((f) => f + " (deleted)")].join("\n") + "\n",
  );
' "$head_sha" "$changed" "$removed"

echo "Candidate baselines:"
printf '%s\n' "$changed" | sed 's/^/  /'
printf '%s\n' "$removed" | sed 's/^/  (deleted) /' || true
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "## Changed visual baselines (CI-generated, awaiting /approve-visual)"
    echo '```'
    printf '%s\n' "$changed"
    echo '```'
  } >> "$GITHUB_STEP_SUMMARY"
fi
# Job остаётся красным: дифф реален, человек смотрит отчёт; артефакт ждёт одобрения.
exit 1
