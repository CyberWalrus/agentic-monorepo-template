/**
 * Сборка OpenAPI-спеки из контракта (c12): генератор + корректирующие шаги,
 * без которых спека расходится с рантаймом. Всё детерминировано: одинаковый
 * контракт — одинаковый openapi.json, что и проверяет openapi:check.
 *
 * e56: спека не держит ручных списков и ручных форм. Операции, у которых
 * достижим 400 валидации, вычисляются из роутера контракта; тела 400, 413 и
 * 504 — дословно с провода (errorResponses), их же сверяет с рантаймом
 * apps/api/src/app.test.ts.
 */
import type { AnyContractRouter, OpenAPI } from '@orpc/contract';
import { OpenAPIGenerator, type ConditionalSchemaConverter } from '@orpc/openapi';
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4';
import { ZodType, ZodUndefined, ZodVoid } from 'zod';

import { AccessPolicySchema } from '../src/access-policy.ts';

/**
 * Конвертер void-вывода. Штатный ZodToJsonSchemaConverter отдаёт z.void() и
 * z.undefined() как [required=false, { not: {} }], а applySchemaOptionality
 * оборачивает это в всегда-ложную anyOf [{ not: {} }, { not: {} }] — схему,
 * которой не удовлетворяет ничто. Возвращаем ту же never-схему, но
 * обязательную: toOpenAPIContent опускает content у never-схем, и 200
 * остаётся без тела — как и отдаёт рантайм (OpenAPI-транспорт возвращает
 * void-процедуры как 200 с пустым телом, см. app.test.ts).
 */
export const voidSchemaConverter: ConditionalSchemaConverter = {
  condition: (schema) => schema instanceof ZodVoid || schema instanceof ZodUndefined,
  convert: () => [true, { not: {} }],
};

/**
 * Версия API осознанно не ведётся (e56): у спеки нет потребителя, которому
 * нужен семвер API, а источника версии в шаблоне нет — в copier.yml нет
 * вопроса о версии, и сам шаблон ответов copier не рендерит. Условие
 * возврата: у потребителей появляется потребность в независимой версии API —
 * семвер контракта через ADR. Изменение значения — правка этой константы.
 */
export const API_VERSION = '0.0.0';

/** Ответ на проводе: статус и дословное тело (JSON). */
export interface WireResponse {
  readonly status: number;
  readonly body: unknown;
}

/** Ответ HTTP-ограждения: один ключ error со статичным текстом. */
interface GuardResponse {
  readonly status: number;
  readonly body: { readonly error: string };
}

/**
 * Тела ошибок дословно с провода. Зафиксированы тестом рантайма
 * (apps/api/src/app.test.ts, «error responses on the wire»): спека строится
 * из этих фикстур, а не из описания по памяти — расходится рантайм, красный
 * тест API; расходится спека, красный openapi-spec.test.ts.
 */
export const errorResponses = {
  /** Провал валидации входа: в issue на проводе есть и другие поля (code, expected…), они не запрещены. */
  validationFailed: {
    status: 400,
    body: {
      defined: false,
      code: 'BAD_REQUEST',
      status: 400,
      message: 'Input validation failed',
      data: { issues: [{ path: ['title'], message: 'Title is required' }] },
    },
  },
  /** Тело не разобралось как JSON: транспорт отвечает до валидации и без data. */
  malformedBody: {
    status: 400,
    body: {
      defined: false,
      code: 'BAD_REQUEST',
      status: 400,
      message:
        "Malformed request. Ensure the request body is properly formatted and the 'Content-Type' header is set correctly.",
    },
  },
  /** HTTP-слой до транспорта (apps/api/src/app.ts): статичный текст, без данных запроса (C4.1). */
  payloadTooLarge: { status: 413, body: { error: 'Payload too large' } },
  requestTimedOut: { status: 504, body: { error: 'Request timed out' } },
} as const;

type JsonObject = Record<string, unknown>;

const envelope = (): JsonObject => {
  const { defined, code, status } = errorResponses.validationFailed.body;
  return { defined: { const: defined }, code: { const: code }, status: { const: status } };
};

/** Провал валидации: неопределённая ошибка BAD_REQUEST с каталогом zod-issues в data. */
const validationFailureSchema: JsonObject = {
  type: 'object',
  properties: {
    ...envelope(),
    message: { type: 'string', default: errorResponses.validationFailed.body.message },
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
};

/** Битое тело: та же обёртка, без data. Варианты oneOf исключают друг друга. */
const malformedBodySchema: JsonObject = {
  type: 'object',
  properties: {
    ...envelope(),
    message: { const: errorResponses.malformedBody.body.message },
  },
  required: ['defined', 'code', 'status', 'message'],
  not: { required: ['data'] },
};

const badRequestResponse: JsonObject = {
  description: '400: input validation failed or the request body is malformed',
  content: {
    'application/json': { schema: { oneOf: [validationFailureSchema, malformedBodySchema] } },
  },
};

/** Схема ответа ограждения: ровно ключ error с текстом фикстуры. */
function guardResponse(fixture: GuardResponse, description: string): JsonObject {
  return {
    description,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: { error: { const: fixture.body.error } },
          required: ['error'],
          additionalProperties: false,
        },
      },
    },
  };
}

const payloadTooLargeResponse = guardResponse(
  errorResponses.payloadTooLarge,
  '413: request body over the limit; answered by the HTTP layer, not the procedure',
);

const requestTimedOutResponse = guardResponse(
  errorResponses.requestTimedOut,
  '504: request exceeded the time limit; answered by the HTTP layer, not the procedure',
);

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

/** Часть контрактной процедуры, читаемая здесь; остальное спеку не нужно. */
interface ContractProcedure {
  readonly '~orpc': {
    readonly route?: { readonly method?: string; readonly path?: string };
    readonly inputSchema?: unknown;
    readonly meta?: unknown;
  };
}

function isProcedure(value: unknown): value is ContractProcedure {
  return (
    typeof value === 'object' &&
    value !== null &&
    '~orpc' in value &&
    typeof value['~orpc'] === 'object' &&
    value['~orpc'] !== null
  );
}

/** Все процедуры роутера контракта, рекурсивно по вложенным роутерам. */
function* procedures(node: unknown): Generator<ContractProcedure> {
  if (isProcedure(node)) {
    yield node;
    return;
  }
  if (typeof node !== 'object' || node === null) {
    return;
  }
  for (const value of Object.values(node)) {
    yield* procedures(value);
  }
}

/**
 * Вход процедуры валидируется: схема есть и пустой вход (undefined) она
 * отклоняет — тело или параметры обязаны прийти. Схема, принимающая undefined
 * (z.void(), z.any()), ничего не проверяет, и 400 через неё не получить.
 */
export function hasValidatedInput(procedure: unknown): boolean {
  if (!isProcedure(procedure)) {
    return false;
  }
  const schema = procedure['~orpc'].inputSchema;
  return schema instanceof ZodType && !schema.safeParse(undefined).success;
}

/**
 * Операции («METHOD /path»), у которых провал валидации входа достижим, —
 * вычисляются из роутера контракта, а не ведутся руками (e56): ручной список
 * расходился с `pnpm gen feature` по построению. 400 достижим, когда вход
 * валидируется и проверка доступа его не опережает: у public-процедур
 * мидлварь авторизации ничего не проверяет. Процедура с политикой owner или
 * admin (или без политики) отказывает FORBIDDEN до валидации (fail-closed,
 * C2.3): владелец читается по форме входа, и вход, не прошедший валидацию,
 * формы не даёт. Рантайм-доказательство правила для каждой процедуры
 * настоящего роутера — router-divergence.test.ts.
 */
export function operationsWithInputValidation(router: AnyContractRouter): ReadonlySet<string> {
  const operations = new Set<string>();
  for (const procedure of procedures(router)) {
    const route = procedure['~orpc'].route;
    if (route?.method === undefined || route.path === undefined) {
      continue;
    }
    const meta = procedure['~orpc'].meta;
    const access =
      typeof meta === 'object' && meta !== null && 'access' in meta ? meta.access : undefined;
    const policy = AccessPolicySchema.safeParse(access);
    if (hasValidatedInput(procedure) && policy.success && policy.data.type === 'public') {
      operations.add(`${route.method.toUpperCase()} ${route.path}`);
    }
  }
  return operations;
}

/**
 * Дополняет спеку ответами, которых генератор не видит, и убирает пустые
 * content-мапы (генератор ставит content: {} у void-вывода, хотя рантайм
 * тела не отдаёт: пустая мапа утверждает тело и вводит кодогенерацию в
 * заблуждение):
 *   - 400 (валидация или битое тело) — операциям из validated;
 *   - 413 — операциям с телом запроса: превысить потолок может только тело;
 *   - 504 — всем: любая процедура может не уложиться в срок.
 * Уже объявленный контрактом код не перезаписывает (источник правды —
 * контракт, обогащение вступает, только если код не задокументирован).
 * Порядок кодов в сериализации и так возрастающий: числовые ключи объекты JS
 * всегда отдают первыми и по возрастанию, поэтому пересортировка не нужна.
 * Меняет spec на месте и возвращает его же.
 */
export function documentErrorResponses(
  spec: OpenAPI.Document,
  validated: ReadonlySet<string>,
): OpenAPI.Document {
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
      if (validated.has(`${method.toUpperCase()} ${path}`)) {
        setResponse(operation, '400', badRequestResponse);
      }
      if (operation.requestBody) {
        setResponse(operation, '413', payloadTooLargeResponse);
      }
      setResponse(operation, '504', requestTimedOutResponse);
    }
  }
  return spec;
}

/** Ставит ответ, если контракт его ещё не задокументировал. */
function setResponse(operation: OpenAPI.OperationObject, code: string, response: JsonObject): void {
  const responses = operation.responses;
  if (!responses || responses[code]) {
    return;
  }
  // Значение — валидный ответ OpenAPI 3.1 (const, type-массивы, not и oneOf
  // легальны, сам генератор пишет const в схемы ошибок этой же спеки), но тип
  // responses в openapi-types — пересечение с легаси-V3, где этих конструкций нет.
  // @ts-expect-error -- valid OpenAPI 3.1 response body; the V3 side of the openapi-types ResponsesObject intersection lacks `const`, `not` and `type` arrays
  responses[code] = response;
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

/** Спека из контракта: генерация с корректором void-вывода и ответы ошибок из фикстур провода. */
export async function generateSpec(contract: AnyContractRouter): Promise<OpenAPI.Document> {
  const generator = new OpenAPIGenerator({
    schemaConverters: [voidSchemaConverter, new ZodToJsonSchemaConverter()],
  });
  const spec = await generator.generate(contract, {
    info: { title: 'Agentic Template API', version: API_VERSION },
    servers: [{ url: '/api' }],
  });
  return documentErrorResponses(spec, operationsWithInputValidation(contract));
}
