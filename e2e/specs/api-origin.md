# Api origin

E2E-план топологии «один origin» (ADR 0005). Критерии приёмки; у каждого есть
хотя бы один тест в `e2e/features/api-origin/` — это проверяет гейт трассировки
(`e2e/features/traceability/traceability.spec.ts`).

## Критерии приёмки

- **AC-1**: Тестовый API недоступен через web-origin: запрос `/__test__/reset` не доходит до API (через web-origin проксируется только `/rpc`).
- **AC-2**: API `/health` недоступен через web-origin.
