/**
 * Сборка OpenAPI-спеки из контракта (c12): генератор + корректирующие шаги,
 * без которых спека расходится с рантаймом. Всё детерминировано: одинаковый
 * контракт — одинаковый openapi.json, что и проверяет openapi:check.
 *
 * e56: спека не держит ручных списков и ручных форм. Фикстуры провода,
 * признак валидируемого входа, ответы ошибок и конвертер void-вывода — чистый
 * модуль `../src/openapi-spec.ts` (экспорт `@repo/contracts`): его же
 * импортируют тесты API для сверки спеки с проводом. Скрипты пакета публичным
 * импортом недоступны, а `@orpc/openapi` и `@orpc/zod` в корневой entry
 * контрактов тянуть нельзя (его импортирует web), поэтому здесь остаётся
 * только сама сборка: генератор с конвертерами и версия API.
 *
 * Тесты API собирают спеку операций той же парой конвертеров
 * (`new OpenAPIGenerator({ schemaConverters: [voidSchemaConverter,
 * new ZodToJsonSchemaConverter()] })`) и тем же documentErrorResponses:
 * генератор без конвертеров не читает Zod-схемы — процедуры с параметром
 * пути не генерируются.
 */
import type { AnyContractRouter, OpenAPI } from '@orpc/contract';
import { OpenAPIGenerator } from '@orpc/openapi';
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4';

import {
  documentErrorResponses,
  operationsWithInputValidation,
  voidSchemaConverter,
} from '../src/openapi-spec.ts';
// e58: заголовок рабочего пространства генератору не виден — его читает
// контекст запроса, а не схема входа. Описание и список операций, которые
// его читают, — из workspace.ts.
import { documentWorkspaceHeader, workspaceScopedOperations } from '../src/workspace.ts';

/**
 * Версия API осознанно не ведётся (e56): у спеки нет потребителя, которому
 * нужен семвер API, а источника версии в шаблоне нет — в copier.yml нет
 * вопроса о версии, и сам шаблон ответов copier не рендерит. Условие
 * возврата: у потребителей появляется потребность в независимой версии API —
 * семвер контракта через ADR. Изменение значения — правка этой константы.
 */
export const API_VERSION = '0.0.0';

/**
 * Спека из контракта: генерация с корректором void-вывода, ответы ошибок из
 * фикстур провода и заголовок рабочего пространства у операций, которые его
 * читают (e58).
 */
export async function generateSpec(contract: AnyContractRouter): Promise<OpenAPI.Document> {
  const generator = new OpenAPIGenerator({
    schemaConverters: [voidSchemaConverter, new ZodToJsonSchemaConverter()],
  });
  const spec = await generator.generate(contract, {
    info: { title: 'Agentic Template API', version: API_VERSION },
    servers: [{ url: '/api' }],
  });
  const withErrors = documentErrorResponses(spec, operationsWithInputValidation(contract));
  return documentWorkspaceHeader(withErrors, workspaceScopedOperations(contract));
}
