---
name: api-contract-change
description: Contract-first procedure for adding or changing an API procedure — edit the oRPC contract and Zod schemas, regenerate OpenAPI, implement in Hono/oRPC, test both transports, update the web client, and handle breaking changes. Use whenever the API or a shared schema changes.
---

# API contract change

Источник правды: `packages/contracts`. Сервер реализует контракт через `implement(contract)`, клиент типизирован тем же контрактом. Расхождение ловит TypeScript и CI-проверка `openapi:check`.

## Шаги

1. **Схемы и процедура** в `packages/contracts/src/<domain>.ts`:
   - Zod-схемы входа и выхода, экспорт типов через `z.infer`.
   - `oc.route({ method, path, summary })` под REST/OpenAPI, `.errors({ CODE: { message } })` для ожидаемых ошибок.
   - Unit-тесты схем в `<domain>.test.ts` (границы, trim, форматы).
2. `pnpm --filter @repo/contracts openapi`. Изменённый `openapi.json` коммитится: это видимый в ревью дифф API.
3. **Сервер**: доменная логика в `apps/api/src/<module>/` (без импорта HTTP-слоя), процедура в `router.ts`.
4. **Тесты сервера** в `apps/api/src/app.test.ts`: RPC-клиент (`createORPCClient` + `fetch: app.fetch`) и REST (`app.request('/api/...')`), успешный путь, ошибка валидации (`BAD_REQUEST`), доменные ошибки (`NOT_FOUND`).
5. **Клиент**: `orpc.<domain>.<proc>.queryOptions()` / `mutationOptions()` в `apps/web/src/features/<feature>/`.
6. `pnpm verify` и `pnpm mutation`.

## Breaking changes

Удаление поля, сужение типа, переименование, новое обязательное поле во входе — всё это breaking. Делай аддитивно: новое опциональное поле или новая процедура, затем миграция клиентов, удаление старого отдельным PR. Breaking change требует ADR в `docs/adr/` и явного согласия человека.
