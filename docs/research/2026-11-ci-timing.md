# Замер CI по первым 54 PR против бюджетов vision

Задача e2. Дата замера: 2026-11-17. Окно: 2026-11-12 15:48 UTC (первый прогон) — 2026-11-17 04:35 UTC, пять дней. Задача писалась при 45 PR; на дату замера PR 54 (все смержены), замер по всем.

Метод: снимок через GitHub API (`gh api`), не телеметрия. Длительность прогона = `updated_at − run_started_at`; длительность job и шага = `completed_at − started_at`. Процентиль — ближайший ранг (nearest-rank). Из распределений исключены отменённые прогоны (`conclusion: cancelled`, 21 шт в скоупе — у всех трёх workflow включён `cancel-in-progress`, отменённый прогон вытеснен новым пушем или повтором по approval-лейблу, это не ошибка) и не выполнявшиеся job (`skipped`).

## Объём

| Workflow       | Прогонов | Из них красных | Отменённых | attempt > 1 |
| -------------- | -------: | -------------: | ---------: | ----------: |
| CI (`ci.yml`)  |      129 |             12 |          7 |           2 |
| gate-integrity |      102 |             26 |         14 |           3 |
| Nightly        |        4 |              0 |          0 |           0 |
| Всего          |      235 |             38 |         21 |           5 |

Отменённые: 5 — вытесненные пушы main, 14 — gate-integrity, вытесненный перезапуском по approval-лейблу, 2 — вытесненные пуши в PR.

CI = 75 прогонов на 54 PR (событие `pull_request`) + 54 прогона `push` на main (по одному на merge). Merge queue: **0 прогонов `merge_group` за всю историю — контур L4 не включён**.

## Сравнение с бюджетами

| Контур          | Бюджет (vision.md) | Замер                                                                                                                     | Вывод                                        |
| --------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| L3, PR CI       | p50 < 10 мин       | p50 1.5 мин, p95 2.6 мин, max 3.2 мин (54 PR)                                                                             | **в бюджете**, запас ×6.7 по p50             |
| L4, merge queue | p50 < 15 мин       | не измеряемо: merge queue не включена. Прокси — `push` main (полная проверка, без `--affected`): p50 1.6 мин, p95 2.1 мин | бюджет не нарушен, но сам контур не работает |
| L5, nightly     | без бюджета        | p50 3.4 мин, p95 4.9 мин (n=4)                                                                                            | справочно                                    |
| gate-integrity  | —                  | p50 80 с, p95 1.5 мин                                                                                                     | справочно: двуфазный гейт approval-лейблом   |

## Длительность по job

### CI на PR (`--affected`), n=73–75

n меняется от 73 до 75: из двух отменённых прогонов PR завершились не все job.

| Job      | p50  | p95      | max      | Что внутри долгой job                                                            |
| -------- | ---- | -------- | -------- | -------------------------------------------------------------------------------- |
| perf     | 82 с | 1.8 мин  | 1.87 мин | шаги на p50: setup 32 с (pnpm install), k6 API smoke 26 с, `turbo run perf` 13 с |
| visual   | 62 с | 73 с     | 78 с     |                                                                                  |
| unit     | 44 с | 72 с     | 87 с     |                                                                                  |
| e2e      | 40 с | 65 с     | 86 с     |                                                                                  |
| static   | 38 с | 45 с     | 56 с     |                                                                                  |
| mutation | 24 с | 2.43 мин | 3.2 мин  | хвост растёт от объёма затронутого доменного кода                                |
| gate     | 3 с  | 5 с      | 6 с      | агрегатор                                                                        |

Прогон длится столько, сколько самая долгая job: p50 1.5 мин ≈ perf (82 с) плюс гейт. **Узкое место — perf: setup (pnpm install) занимает 32 с из 82 с на p50 (39%), ещё 26 с — k6 smoke; в самом долгом прогоне setup 58 с из 112 с (52%). Сами проверки — `turbo run perf` — 13 с.**

### CI на push main (без `--affected`), n=53

| Job    | p50  | p95      |
| ------ | ---- | -------- |
| perf   | 84 с | 1.65 мин |
| visual | 63 с | 76 с     |
| unit   | 61 с | 80 с     |
| e2e    | 46 с | 68 с     |
| static | 40 с | 57 с     |
| gate   | 3 с  | 5 с      |

mutation на push не выполняется (`if: github.event_name != 'push'` в `ci.yml`) — полные мутации живут в PR и nightly.

Полная проверка main лишь на ~15 с дольше PR-версии (unit 61 с против 44 с): affected-режим экономит немного, потому что домен пока маленький.

### Холодный и тёплый кэш

Холодный кэш = PR менял `pnpm-lock.yaml` (ключи кэшей pnpm store и Playwright-браузеров пересоздаются): 7 PR из 54 (№ 1, 3, 24, 37, 38, 53, 54), n=13 прогонов против n=60 тёплых.

| Job                    | p50 холодный         | p50 тёплый | Разница                                                             |
| ---------------------- | -------------------- | ---------- | ------------------------------------------------------------------- |
| unit                   | 53 с                 | 41 с       | +12 с (установка зависимостей)                                      |
| e2e                    | 46 с                 | 39 с       | +7 с                                                                |
| mutation               | 32 с                 | 23 с       | +9 с, но выборка смещена: все lockfile-PR меняли зависимости домена |
| static / perf / visual | без значимой разницы |            |                                                                     |

Кэш даёт секунды, не минуты: бюджет L3 не под угрозой при смене зависимостей. Выборка мала (n=13), цифры — ориентир.

## Перезапуски и флаки

Перезапусков (`run_attempt > 1`) — 5 из 235 прогонов (2.1%): 2 у CI (PR № 40, 48), 3 у gate-integrity (штатный флоу approval-лейбла). Попытка 1 перезапущенного прогона API не отдаёт (хранит только последнюю), поэтому часть красных попыток невидима; сам факт перезапуска — маркер красной попытки, зелёное не перезапускают.

Классификация 12 красных прогонов CI:

- **Реальные ловли гейтов (6):** PR № 54 — unit (регистрозависимая фикстура); PR № 24 — три итерации e2e/visual при разработке фичи (19f6928, 505a829, 8022dc7); PR № 40 — `docs:check` поймал дубль id `d14` в `backlog/` и `backlog/done/` (рассинхрон доски при масс-мёрже, починен гигиеной 1b9b6d9); PR № 1 2db95ce — эпоха становления (job `protected-paths` и падение setup в visual).
- **По дизайну (2):** PR № 33 — visual diff на новые сценарии (базлайны обновляет только человек); PR № 1 69a21bf — protected-paths до approval-лейбла, зазеленел на том же SHA через 5 минут.
- **Флаки (3, все один тест):** `tools/test/ports.test.ts` — три независимых случая без изменения кода:
  1. push f0a1f45 (main, 2026-11-15 07:48) — `EADDRINUSE`, порт 3501 занят;
  2. push b5c3304 (main, 2026-11-15 08:21) — `API_PORT must be an integer between 3300 and 3899, got "3905"` — заворот за потолок диапазона;
  3. PR № 23 (probe/d2, 2026-11-14 04:05) — тот же тест «prefers API_PORT env».
     Оба красных прогона main зазеленели на следующем пуше без правок кода портов.
- **Разовый подозрительный (1):** `tools/test/backlog-cli.test.ts` на PR замыкания доски (2026-11-14); на следующем коммите зелёный — не отличить фикс от флака по одним прогонам.

Вне этих 12: прогон PR № 45 завершился `cancelled` (поэтому в счёт красных не попадает), но его агрегатор `gate` успел покраснеть от отменённых зависимостей при двух прогонах на один SHA — следующий прогон того же SHA зелёный.

Ещё один кандидат: `gate-integrity` краснеет 26 раз — это штатная двухфазная схема (до approval-лейбла), не флак; но среди неё встречался ENOENT отставшей ветки на labeled-ране (см. журнал задач d8.2/d8.4).

**Нижняя оценка flaky rate: 3 из 129 прогонов CI = 2.3%; на main — 2 из 54 = 3.7%.** Все три случая — один тест, `ports.test.ts`. Отдельная линия: 21 отменённый прогон — это вытеснение (concurrency), не ошибки; но во время всплеска активности (масс-мёрж 2026-11-15, 6 PR за час) пять прогонов ждали свободный раннер от 3 до 45 минут (максимум 2699 с) — бюджет обратной связи там нарушала очередь, а не сами проверки.

## Выводы

1. **L3 в бюджете с запасом ×6.7** (p50 1.5 мин при пороге 10 мин). Цель G3 подтверждена и в CI, а не только локально.
2. **L4 не измеряется, потому что merge queue не включена**: 0 прогонов `merge_group`. Либо включить merge queue, либо честно пометить контур как неактивный в `docs/vision.md` — это развилка человека.
3. **Самая долгая job — perf (p50 82 с), и 39% её времени на p50 — setup (pnpm install, 32 с), ещё 32% — k6 smoke (26 с); сами проверки (`turbo run perf`) — 13 с.** Remote cache turbo (`TURBO_TOKEN` уже заведён как secret) или свой кэш setup — самое эффективное ускорение, пока оно не нужно.
4. **Один хронический флак: `ports.test.ts`** (3 случая из 129 прогонов CI): тест ломается на завороте порта за потолок диапазона 3300–3899 и на занятом порте. Нижняя оценка flaky rate 2.3% **выше цели G4 (< 1%)** — уже по нижней оценке цель G4 не достигнута. Кандидат в отдельную задачу с доказательством из этого документа.
5. `docs:check` и `test:hooks` уже ловили реальные проблемы после merge — гейты после пуша в main не бесполезны.

## Как повторить замер

Скрипты сбора — одноразовые, состояние на 2026-11-17:

```bash
mkdir -p /tmp/e2-snapshot && cd /tmp/e2-snapshot
REPO=CyberWalrus/agentic-monorepo-template

# 1. Все прогоны всех workflow (страницы склеиваются, jq собирает в один массив)
gh api --paginate "repos/$REPO/actions/runs?per_page=100" > runs-all.json
jq -s '[.[].workflow_runs[]]' runs-all.json > runs.json

# 2. Прогоны в скоупе (CI, gate-integrity, Nightly) и их job
jq -r '[.[] | select(.name=="CI" or .name=="gate-integrity" or .name=="Nightly")]
  | sort_by(.id) | .[] | "\(.id) \(.name)"' runs.json > scoped.txt
mkdir -p jobs
while read -r id name; do
  [ -s "jobs/$id.json" ] || gh api "repos/$REPO/actions/runs/$id/jobs?per_page=100" > "jobs/$id.json"
  sleep 0.3   # secondary rate limits
done < scoped.txt

# 3. PR: список, коммиты (маппинг прогонов по SHA — поле pull_requests у runs пустое),
#    файлы (PR с pnpm-lock.yaml = холодный кэш; у PR с >100 файлов дозагрузить с --paginate)
gh api "repos/$REPO/pulls?state=all&per_page=100" > pulls.json
for n in $(jq -r '.[].number' pulls.json); do
  mkdir -p pr-commits pr-files
  [ -s "pr-commits/$n.json" ] || gh api "repos/$REPO/pulls/$n/commits?per_page=100" > "pr-commits/$n.json"
  [ -s "pr-files/$n.json" ]   || gh api "repos/$REPO/pulls/$n/files?per_page=100" > "pr-files/$n.json"
done

# 4. Логи упавших job (диагноз флака)
gh api "repos/$REPO/actions/jobs/<JOB_ID>/logs"
```

Длительности и процентили (ближайший ранг, без `cancelled`/`skipped`) по собранному:

```bash
node -e '
const fs = require("fs");
const runs = JSON.parse(fs.readFileSync("runs.json", "utf8"))
  .filter((r) => ["CI", "gate-integrity", "Nightly"].includes(r.name));
const dur = (r) => (Date.parse(r.updated_at) - Date.parse(r.run_started_at)) / 1000;
const st = (a) => { const s = [...a].sort((x, y) => x - y);
  return { n: s.length, p50: s[Math.ceil(s.length * 0.5) - 1], p95: s[Math.ceil(s.length * 0.95) - 1] }; };
for (const wf of ["CI", "gate-integrity", "Nightly"]) {
  const done = runs.filter((r) => r.name === wf && r.conclusion && r.conclusion !== "cancelled").map(dur);
  console.log(wf, JSON.stringify(st(done)));
}
// по job — из jobs/<id>.json: (j.completed_at - j.started_at), пропуская skipped/cancelled
const jobDur = (j) => (Date.parse(j.completed_at) - Date.parse(j.started_at)) / 1000;
const byJob = new Map();
for (const r of runs) {
  const data = JSON.parse(fs.readFileSync(`jobs/${r.id}.json`, "utf8"));
  for (const j of data.jobs ?? []) {
    if (j.conclusion === "skipped" || j.conclusion === "cancelled") continue;
    const key = `${r.name} / ${j.name}`;
    if (!byJob.has(key)) byJob.set(key, []);
    byJob.get(key).push(jobDur(j));
  }
}
for (const [name, durs] of byJob) console.log(name, JSON.stringify(st(durs)));
'
```

Классификация красных (флак против реальной ловли) — по логам `actions/jobs/<JOB_ID>/logs` вручную: у флака следующий прогон без изменения кода зелёный. Телеметрии нет, это разовый снимок; постоянный сбор — задача C9.4.
