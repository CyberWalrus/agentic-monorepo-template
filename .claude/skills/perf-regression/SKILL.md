---
name: perf-regression
description: How to investigate and fix a failing performance budget — page web vitals, scenario timings, bundle size, API p95 — using reports, Playwright traces and Chrome DevTools MCP. Budgets in perf-budgets.json are never raised by agents. Use when pnpm perf, pnpm bundle or the CI perf job fails.
---

# Perf regression

Бюджеты в `perf-budgets.json` защищены. Регрессию чинят в коде.

## 1. Что именно упало

- `e2e/reports/perf.json` — медианы TTFB/LCP/CLS и времени сценариев (CPU-троттлинг x4).
- `reports/bundle.json` — gzip-размеры чанков.
- k6 (CI): p95 и доля ошибок API.

Чтобы сравнить с `main`, прогони `pnpm perf` на `main` (через `git worktree`) и на своей ветке, затем сравни оба `perf.json`.

## 2. Диагностика

| Симптом            | Куда смотреть                                                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Вырос бандл        | `reports/bundle.json`: какой чанк вырос. Новая зависимость? Импорт всего пакета вместо модуля? Серверный код в клиенте?                   |
| Вырос LCP / TTFB   | SSR делает лишние запросы? Блокирующий loader? Chrome DevTools MCP: `performance_start_trace`, затем `performance_analyze_insight`        |
| CLS > 0            | Контент без зарезервированного места, шрифты, поздно появляющиеся элементы                                                                |
| Медленный сценарий | Трейс Playwright (`pnpm exec playwright trace open ...`, затем `requests`): лишние запросы, водопад, отсутствие оптимистичного обновления |
| p95 API            | Алгоритм в репозитории (O(n²)?), лишняя сериализация, синхронная работа на запросе                                                        |

## 3. Типовые исправления

Code-splitting маршрута, удаление или замена тяжёлой зависимости, перенос работы с клиента на сервер или наоборот, кэш TanStack Query (`staleTime`), оптимистичное обновление вместо ожидания refetch, резерв места под асинхронный контент.

## Если бюджет действительно надо менять

Только человек, отдельным PR с обоснованием (новая функциональность стоит N KB, цифры до и после). Ты можешь подготовить обоснование, но сам файл не трогаешь.
