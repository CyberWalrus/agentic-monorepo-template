/**
 * Сборка OpenAPI-спеки из контракта (c12): генератор + два корректирующих
 * шага, без которых спека расходится с рантаймом. Всё детерминировано:
 * одинаковый контракт — одинаковый openapi.json, что и проверяет openapi:check.
 */
import type { AnyContractRouter, OpenAPI } from '@orpc/contract';
import { OpenAPIGenerator, type ConditionalSchemaConverter } from '@orpc/openapi';
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4';
import { ZodUndefined, ZodVoid } from 'zod';

/**
 * Конвертер void-вывода. Штатный ZodToJsonSchemaConverter отдаёт z.void() и
 * z.undefined() как [required=false, { not: {} }], а applySchemaOptionality
 * оборачивает это в всегда-ложную anyOf [{ not: {} }, { not: {} }] — схему,
 * которой не удовлетворяет ничто. Возвращаем ту же never-схему, но
 * обязательной: toOpenAPIContent опускает content у never-схем, и 200
 * остаётся без тела — как и отдаёт рантайм (OpenAPI-транспорт возвращает
 * void-процедуры как 200 с пустым телом, см. app.test.ts).
 */
export const voidSchemaConverter: ConditionalSchemaConverter = {
  condition: (schema) => schema instanceof ZodVoid || schema instanceof ZodUndefined,
  convert: () => [true, { not: {} }],
};

/**
 * Операции, у которых провал валидации входа достижим в рантайме и потому
 * документируется как 400. Список явный, а не структурный («есть input»):
 * у remove тот же TaskIdInputSchema, но owner-проверка отвечает FORBIDDEN до
 * валидации (fail-closed, C2.3), и 400 для DELETE недостижим — проверено на
 * рантайме (DELETE /tasks/<не-uuid> → 403). Новая процедура с достижимым 400
 * добавляется сюда явно вместе с тестом в openapi-spec.test.ts.
 */
const OPERATIONS_WITH_INPUT_VALIDATION = new Set(['POST /tasks', 'POST /tasks/{id}/toggle']);

/**
 * Тело 400 в форме рантайма: oRPC отвечает на провал валидации входа
 * неопределённой ошибкой BAD_REQUEST с каталогом zod-issues в data
 * («Input validation failed»). Описываем полезный минимум — путь и текст
 * каждого issue; неописанные поля не запрещаем. Стиль — как у генератора:
 * description-статус и default у message.
 */
const badRequestResponse = {
  description: '400',
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: {
          defined: { const: false },
          code: { const: 'BAD_REQUEST' },
          status: { const: 400 },
          message: { type: 'string', default: 'Input validation failed' },
          data: {
            type: 'object',
            properties: {
              issues: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    path: { type: 'array', items: { type: ['string', 'number'] } },
                    message: { type: 'string' },
                  },
                  required: ['path', 'message'],
                },
              },
            },
            required: ['issues'],
          },
        },
        required: ['defined', 'code', 'status', 'message', 'data'],
      },
    },
  },
};

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

/**
 * Дополняет спеку ответами 400 для операций из OPERATIONS_WITH_INPUT_VALIDATION
 * и убирает пустые content-мапы (генератор ставит content: {} у void-вывода,
 * хотя рантайм тела не отдаёт: пустая мапа утверждает тело и вводит кодогенерацию
 * в заблуждение). Уже объявленный контрактом 400 не перезаписывает (источник
 * правды — контракт, обогащение вступает, только если код не задокументирован).
 * Порядок кодов в сериализации и так возрастающий: числовые ключи объекты JS
 * всегда отдают первыми и по возрастанию, поэтому пересортировка не нужна.
 * Меняет spec на месте и возвращает его же.
 */
export function documentValidationErrors(spec: OpenAPI.Document): OpenAPI.Document {
  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    if (!pathItem) {
      continue;
    }
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation) {
        continue;
      }
      dropEmptyContent(operation.responses);
      if (!OPERATIONS_WITH_INPUT_VALIDATION.has(`${method.toUpperCase()} ${path}`)) {
        continue;
      }
      const responses = operation.responses;
      if (!responses || responses['400']) {
        continue;
      }
      // Значение — валидный ответ OpenAPI 3.1 (const и type-массивы легальны,
      // сам генератор пишет const в схемы ошибок этой же спеки), но тип responses
      // в openapi-types — пересечение с легаси-V3, где этих конструкций нет.
      // @ts-expect-error -- valid OpenAPI 3.1 response body; the V3 side of the openapi-types ResponsesObject intersection lacks `const` and `type` arrays
      responses['400'] = badRequestResponse;
    }
  }
  return spec;
}

/**
 * Генератор ставит response.content даже когда схем в нём не осталось
 * (void-вывод после корректора voidSchemaConverter). Пустой content —
 * утверждение о теле, которого нет: убираем.
 */
function dropEmptyContent(responses: OpenAPI.OperationObject['responses']): void {
  if (!responses) {
    return;
  }
  for (const response of Object.values(responses)) {
    if (
      response &&
      typeof response === 'object' &&
      'content' in response &&
      !hasKeys(response.content)
    ) {
      delete response.content;
    }
  }
}

function hasKeys(value: unknown): boolean {
  return typeof value === 'object' && value !== null && Object.keys(value).length > 0;
}

/** Спека из контракта: генерация с корректором void-вывода и обогащение 400. */
export async function generateSpec(contract: AnyContractRouter): Promise<OpenAPI.Document> {
  const generator = new OpenAPIGenerator({
    schemaConverters: [voidSchemaConverter, new ZodToJsonSchemaConverter()],
  });
  const spec = await generator.generate(contract, {
    info: { title: 'Agentic Template API', version: '0.0.0' },
    servers: [{ url: '/api' }],
  });
  return documentValidationErrors(spec);
}
