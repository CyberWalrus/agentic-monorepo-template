import { readFileSync } from 'node:fs';

import type { OpenAPI } from '@orpc/contract';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import { contract, ocAccess, ocPublic } from '../src/index.ts';
// e56: фикстуры провода, правила ответов и конвертер void-вывода — чистый
// модуль контрактов (экспорт `@repo/contracts`)
import {
  documentErrorResponses,
  errorResponses,
  hasValidatedInput,
  operationsWithInputValidation,
  voidSchemaConverter,
} from '../src/openapi-spec.ts';
// e58: заголовок рабочего пространства — имя, параметр и список операций,
// которые его читают, из единственного источника
import {
  WORKSPACE_HEADER,
  WORKSPACE_HEADER_PARAMETER,
  workspaceScopedOperations,
} from '../src/workspace.ts';
import { API_VERSION, generateSpec } from './openapi-spec.ts';

describe('errorResponses', () => {
  // Фикстуры провода — дословно: из них строится спека, ими тесты API сверяют
  // провод (apps/api/src/app.test.ts, «error responses on the wire»). Эталон
  // записан руками, чтобы правка фикстуры была видна и здесь
  it('records the wire bodies verbatim', () => {
    expect(errorResponses).toEqual({
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
      payloadTooLarge: { status: 413, body: { error: 'Payload too large' } },
      requestTimedOut: { status: 504, body: { error: 'Request timed out' } },
      unreadableBody: { status: 400, body: { error: 'Request body is not readable' } },
    });
  });
});

describe('voidSchemaConverter', () => {
  it('recognises void and undefined schemas', () => {
    expect(voidSchemaConverter.condition(z.void(), { strategy: 'output' })).toBe(true);
    expect(voidSchemaConverter.condition(z.undefined(), { strategy: 'output' })).toBe(true);
    expect(voidSchemaConverter.condition(z.string(), { strategy: 'output' })).toBe(false);
    expect(voidSchemaConverter.condition(z.object({ a: z.string() }), { strategy: 'output' })).toBe(
      false,
    );
    expect(voidSchemaConverter.condition(undefined, { strategy: 'output' })).toBe(false);
  });

  it('maps void output to a required never schema instead of an optional one', () => {
    // required=true — иначе applySchemaOptionality оборачивает never в
    // всегда-ложную anyOf [{ not: {} }, { not: {} }]
    expect(voidSchemaConverter.convert(z.void(), { strategy: 'output' })).toEqual([
      true,
      { not: {} },
    ]);
  });
});

/** Объект JSON (не массив и не null). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Свёртка значения со схемой — ровно подмножество JSON Schema, которое
 * выпускает спека (type, const, required, properties, items, oneOf, not,
 * additionalProperties: false). Пустой список — значение соответствует схеме.
 */
function mismatches(schema: unknown, value: unknown, at = '$'): string[] {
  const fail = (why: string): string[] => [`${at}: ${why}`];
  if (!isRecord(schema)) {
    return fail('is not a schema object');
  }
  const {
    const: constant,
    not,
    oneOf,
    type,
    properties,
    required,
    additionalProperties,
    items,
  } = schema;
  if (constant !== undefined && !Object.is(constant, value)) {
    return fail(`expected ${JSON.stringify(constant)}, got ${JSON.stringify(value)}`);
  }
  if (not !== undefined && mismatches(not, value, at).length === 0) {
    return fail('matches the excluded shape');
  }
  if (oneOf !== undefined) {
    const variants: unknown[] = Array.isArray(oneOf) ? oneOf : [];
    const matched = variants.filter((variant) => mismatches(variant, value, at).length === 0);
    return matched.length === 1
      ? []
      : fail(`oneOf: ${matched.length} of ${variants.length} variants match, exactly one must`);
  }
  if (type !== undefined) {
    const types: unknown[] = Array.isArray(type) ? type : [type];
    const actual =
      value === null
        ? 'null'
        : Array.isArray(value)
          ? 'array'
          : typeof value === 'number' && Number.isInteger(value)
            ? 'integer'
            : typeof value;
    if (!types.includes(actual)) {
      return fail(`type ${actual}, expected ${types.join(' or ')}`);
    }
  }
  if (isRecord(value)) {
    const shape = isRecord(properties) ? properties : {};
    const requiredKeys: unknown[] = Array.isArray(required) ? required : [];
    for (const key of requiredKeys) {
      if (typeof key !== 'string' || !(key in value)) {
        return fail(`required «${String(key)}» is missing`);
      }
    }
    if (additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in shape)) {
          return fail(`«${key}» is not allowed`);
        }
      }
    }
    for (const [key, property] of Object.entries(shape)) {
      const found = mismatches(property, value[key], `${at}.${key}`);
      if (found.length > 0) {
        return found;
      }
    }
  }
  if (Array.isArray(value) && items !== undefined) {
    for (const [index, item] of value.entries()) {
      const found = mismatches(items, item, `${at}[${index}]`);
      if (found.length > 0) {
        return found;
      }
    }
  }
  return [];
}

/** JSON-схема тела ответа операции; undefined — ответа или тела нет. Форму проверяет свёртка. */
function bodySchemaOf(operation: OpenAPI.OperationObject | undefined, code: string): unknown {
  const response = operation?.responses?.[code];
  if (response === undefined || response === null || !('content' in response)) {
    return undefined;
  }
  return response.content?.['application/json']?.schema;
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

/** Все операции спеки с ключом «METHOD /path» — в том же виде, что ключи validated. */
function operationsOf(
  spec: OpenAPI.Document,
): { key: string; operation: OpenAPI.OperationObject }[] {
  return Object.entries(spec.paths ?? {}).flatMap(([path, pathItem]) =>
    HTTP_METHODS.flatMap((method) => {
      const operation = pathItem?.[method];
      return operation === undefined ? [] : [{ key: `${method.toUpperCase()} ${path}`, operation }];
    }),
  );
}

/** Ключи операций, у которых есть ответ с кодом code. */
function keysWithResponse(spec: OpenAPI.Document, code: string): string[] {
  return operationsOf(spec)
    .filter(({ operation }) => operation.responses?.[code] !== undefined)
    .map(({ key }) => key)
    .toSorted();
}

/** Три формы 400 с провода; свёртка решает, какие пропускает схема ответа. */
const BAD_REQUEST_FIXTURES = {
  malformedBody: errorResponses.malformedBody.body,
  unreadableBody: errorResponses.unreadableBody.body,
  validationFailed: errorResponses.validationFailed.body,
} as const;

/** Формы 400, которые пропускает схема ответа операции, — по ключу «METHOD /path». */
function accepted400(spec: OpenAPI.Document, key: string): string[] {
  const schema = bodySchemaOf(
    operationsOf(spec).find(({ key: found }) => found === key)?.operation,
    '400',
  );
  return Object.entries(BAD_REQUEST_FIXTURES)
    .filter(([, body]) => mismatches(schema, body).length === 0)
    .map(([name]) => name);
}

/** По каждой операции — формы 400, которые она обещает. */
function answers400(spec: OpenAPI.Document): Record<string, string[]> {
  return Object.fromEntries(
    operationsOf(spec).map(({ key }) => [key, accepted400(spec, key)] as const),
  );
}

const specFixture = (): OpenAPI.Document => ({
  openapi: '3.1.1',
  info: { title: 'Fixture', version: '0.0.0' },
  paths: {
    '/tasks': {
      post: {
        requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '200': { description: 'OK' } },
      },
      get: { responses: { '200': { description: 'OK' } } },
    },
    '/tasks/{id}': {
      delete: { responses: { '200': { description: 'OK', content: {} } } },
    },
  },
});

const VALIDATED = new Set(['POST /tasks']);

describe('documentErrorResponses', () => {
  // Ограждения стоят на всём `/api/*`, а JSON разбирает транспорт до
  // процедуры: их ответы не зависят от того, что объявляет операция.
  it('documents 400 on every operation with the shapes that operation answers', () => {
    const spec = documentErrorResponses(specFixture(), VALIDATED);

    // Описание начинается с кода — как у ответов самого генератора
    for (const { operation } of operationsOf(spec)) {
      expect(operation.responses?.['400']).toMatchObject({
        description: expect.stringMatching(/^400\b/),
      });
    }
    // Валидация — только у validated (у остальных вход не проверяется).
    // Ответ на тело — по методу: метод с телом разбирает JSON (битое тело),
    // метод без потока тела получает отказ ограждения формы
    expect(answers400(spec)).toEqual({
      'DELETE /tasks/{id}': ['malformedBody'],
      'GET /tasks': ['unreadableBody'],
      'POST /tasks': ['malformedBody', 'validationFailed'],
    });
  });

  it('adds the validation shape to a bodyless method when its input is validated', () => {
    const spec = documentErrorResponses(specFixture(), new Set(['POST /tasks', 'GET /tasks']));

    expect(answers400(spec)['GET /tasks']).toEqual(['unreadableBody', 'validationFailed']);
  });

  // HEAD — как GET: адаптер не передаёт ему поток тела, поэтому потолок тела
  // недостижим, а на объявленное тело отвечает ограждение формы
  it('treats HEAD like GET: no 413, and the form-guard 400', () => {
    const spec = specFixture();
    if (spec.paths?.['/tasks']) {
      spec.paths['/tasks'].head = { responses: { '200': { description: 'OK' } } };
    }

    const documented = documentErrorResponses(spec, VALIDATED);

    expect(Object.keys(documented.paths?.['/tasks']?.head?.responses ?? {})).toEqual([
      '200',
      '400',
      '504',
    ]);
    expect(answers400(documented)['HEAD /tasks']).toEqual(['unreadableBody']);
  });

  it('documents 413 on every method that carries a body, declared or not, and 504 on every operation', () => {
    const spec = documentErrorResponses(specFixture(), VALIDATED);

    expect(spec.paths?.['/tasks']?.post?.responses?.['413']).toMatchObject({
      description: expect.stringMatching(/^413\b/),
    });
    // У DELETE requestBody нет — а тело запроса лимит покрывает
    expect(keysWithResponse(spec, '413')).toEqual(['DELETE /tasks/{id}', 'POST /tasks']);
    expect(keysWithResponse(spec, '504')).toEqual([
      'DELETE /tasks/{id}',
      'GET /tasks',
      'POST /tasks',
    ]);
  });

  it('keeps a response declared by the contract', () => {
    const spec = specFixture();
    const create = spec.paths?.['/tasks']?.post;
    if (create) {
      create.responses = {
        ...create.responses,
        '400': { description: 'declared by contract' },
        '413': { description: 'declared by contract' },
        '504': { description: 'declared by contract' },
      };
    }

    documentErrorResponses(spec, VALIDATED);

    expect(spec.paths?.['/tasks']?.post?.responses?.['400']).toEqual({
      description: 'declared by contract',
    });
    expect(spec.paths?.['/tasks']?.post?.responses?.['413']).toEqual({
      description: 'declared by contract',
    });
    expect(spec.paths?.['/tasks']?.post?.responses?.['504']).toEqual({
      description: 'declared by contract',
    });
  });

  it('drops empty content that claims a body where runtime sends none', () => {
    const spec = specFixture();
    const createResponses = spec.paths?.['/tasks']?.post?.responses;
    const deleteResponses = spec.paths?.['/tasks/{id}']?.delete?.responses;
    if (createResponses) {
      createResponses['200'] = { description: 'OK', content: {} };
    }
    if (deleteResponses) {
      deleteResponses['200'] = {
        description: 'OK',
        content: { 'application/json': { schema: { type: 'string' } } },
      };
    }

    documentErrorResponses(spec, VALIDATED);

    expect(spec.paths?.['/tasks']?.post?.responses?.['200']).toEqual({ description: 'OK' });
    expect(spec.paths?.['/tasks/{id}']?.delete?.responses?.['200']).toHaveProperty('content');
  });

  it('is idempotent', () => {
    const once = documentErrorResponses(specFixture(), VALIDATED);
    const twice = documentErrorResponses(once, VALIDATED);

    expect(twice).toEqual(once);
  });

  // Ответы HTTP-слоя — публикуемая часть openapi.json, и меняются они только
  // вместе с этим эталоном. Он записан руками, без ссылок на errorResponses:
  // иначе правка фикстуры или схемы не была бы видна.
  it('documents the HTTP-layer responses verbatim', () => {
    const paths = documentErrorResponses(specFixture(), VALIDATED).paths;

    expect(paths?.['/tasks']?.post?.responses).toEqual({
      '200': { description: 'OK' },
      '400': {
        description: '400: input validation failed or the request body is malformed',
        content: {
          'application/json': {
            schema: {
              oneOf: [
                {
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
                {
                  type: 'object',
                  properties: {
                    defined: { const: false },
                    code: { const: 'BAD_REQUEST' },
                    status: { const: 400 },
                    message: {
                      const:
                        "Malformed request. Ensure the request body is properly formatted and the 'Content-Type' header is set correctly.",
                    },
                  },
                  required: ['defined', 'code', 'status', 'message'],
                  not: { required: ['data'] },
                },
              ],
            },
          },
        },
      },
      '413': {
        description:
          '413: request body over the limit; answered by the HTTP layer, not the procedure',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { error: { const: 'Payload too large' } },
              required: ['error'],
              additionalProperties: false,
            },
          },
        },
      },
      '504': {
        description:
          '504: request exceeded the time limit; answered by the HTTP layer, not the procedure',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { error: { const: 'Request timed out' } },
              required: ['error'],
              additionalProperties: false,
            },
          },
        },
      },
    });
    // Метод без потока тела: один вариант 400 — отказ ограждения формы
    expect(paths?.['/tasks']?.get?.responses).toEqual({
      '200': { description: 'OK' },
      '400': {
        description:
          '400: a body was sent with a method that carries none; answered before the procedure, which is not called',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { error: { const: 'Request body is not readable' } },
              required: ['error'],
              additionalProperties: false,
            },
          },
        },
      },
      '504': {
        description:
          '504: request exceeded the time limit; answered by the HTTP layer, not the procedure',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { error: { const: 'Request timed out' } },
              required: ['error'],
              additionalProperties: false,
            },
          },
        },
      },
    });
    // Вход не валидируется: без варианта с данными zod-issues
    expect(paths?.['/tasks/{id}']?.delete?.responses).toEqual({
      '200': { description: 'OK' },
      '400': {
        description:
          '400: the request body is malformed; answered before the procedure, which is not called',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                defined: { const: false },
                code: { const: 'BAD_REQUEST' },
                status: { const: 400 },
                message: {
                  const:
                    "Malformed request. Ensure the request body is properly formatted and the 'Content-Type' header is set correctly.",
                },
              },
              required: ['defined', 'code', 'status', 'message'],
              not: { required: ['data'] },
            },
          },
        },
      },
      '413': {
        description:
          '413: request body over the limit; answered by the HTTP layer, not the procedure',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { error: { const: 'Payload too large' } },
              required: ['error'],
              additionalProperties: false,
            },
          },
        },
      },
      '504': {
        description:
          '504: request exceeded the time limit; answered by the HTTP layer, not the procedure',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { error: { const: 'Request timed out' } },
              required: ['error'],
              additionalProperties: false,
            },
          },
        },
      },
    });
  });

  it('leaves a spec without paths, or a path without operations, untouched', () => {
    const withoutPaths = specFixture();
    delete withoutPaths.paths;
    const withEmptyPath = specFixture();
    if (withEmptyPath.paths) {
      withEmptyPath.paths['/tasks'] = undefined;
    }

    expect(documentErrorResponses(withoutPaths, VALIDATED)).not.toHaveProperty('paths');
    expect(documentErrorResponses(withEmptyPath, VALIDATED).paths).toEqual({
      '/tasks': undefined,
      '/tasks/{id}': expect.any(Object),
    });
  });
});

/** Public-процедура фикстурного домена: маршрут до `.input(...)`. */
const note = (path: `/${string}`) =>
  ocPublic.route({ method: 'POST', path, summary: 'Fixture' }).meta({ access: { type: 'public' } });

/** Значения, которые валидация обязана уметь отвергать; эталон набора проб. */
const PROBES: unknown[] = [undefined, {}, [], null, '', 0, false];

const isEmptyObject = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).length === 0;

/** Определение процедуры с заданной схемой входа — в форме, какой её держит контракт. */
const procedureWith = (inputSchema: unknown): unknown => ({
  '~orpc': { route: {}, meta: {}, inputSchema },
});

describe('operationsWithInputValidation', () => {
  // Домен, каким его собирает `pnpm gen feature` (tools/gen.ts, contractTemplate),
  // и процедуры, на которых правило достижимости даёт разные ответы.
  const title = z.strictObject({ title: z.string().min(1) });
  const filters = z.object({ q: z.string().min(2) });
  const domain = {
    list: ocPublic
      .route({ method: 'GET', path: '/notes', summary: 'Fixture' })
      .meta({ access: { type: 'public' } })
      .output(z.array(z.string())),
    create: ocPublic
      .route({ method: 'POST', path: '/notes', summary: 'Fixture' })
      .meta({ access: { type: 'public' } })
      .input(title)
      .output(z.string()),
    archive: ocAccess
      .route({ method: 'POST', path: '/notes/{id}/archive', summary: 'Fixture' })
      .meta({ access: { type: 'owner' } })
      .input(z.object({ id: z.uuid() }))
      .output(z.void()),
    purge: ocAccess
      .route({ method: 'POST', path: '/notes/purge', summary: 'Fixture' })
      .meta({ access: { type: 'admin' } })
      .input(z.object({ confirm: z.literal('yes') }))
      .output(z.void()),
    untagged: ocPublic
      .route({ method: 'POST', path: '/notes/untagged', summary: 'Fixture' })
      .input(title)
      .output(z.string()),
    // Вход принимает undefined — и всё же отвергает значения (ревью e56)
    search: note('/notes/search').input(filters.optional()).output(z.string()),
    defaults: note('/notes/defaults')
      .input(filters.default({ q: 'ab' }))
      .output(z.string()),
    loose: note('/notes/loose')
      .input(z.object({ q: z.string().min(2).optional() }).optional())
      .output(z.string()),
    nothing: note('/notes/nothing').input(z.void()).output(z.string()),
    anything: note('/notes/anything').input(z.any()).output(z.string()),
  };
  // Ожидание записано руками: create, search, defaults, loose (отвергают
  // невалидные значения) и nothing (void отвергает любое тело) — public и с
  // валидируемым входом; anything принимает всё, list входа не имеет, у archive
  // и purge проверка доступа отвечает раньше, untagged без политики.
  const VALIDATED_OPERATIONS = [
    'POST /notes',
    'POST /notes/defaults',
    'POST /notes/loose',
    'POST /notes/nothing',
    'POST /notes/search',
  ];

  it('derives the operations from the contract router: validated input and no access check before it', () => {
    expect([...operationsWithInputValidation(domain)].toSorted()).toEqual(VALIDATED_OPERATIONS);
  });

  it('counts an input as validated when its schema rejects at least one probe', () => {
    // undefined schema принимает, {q: 'a'} — нет
    expect(hasValidatedInput(domain.search)).toBe(true);
    expect(hasValidatedInput(domain.defaults)).toBe(true);
    // {} и undefined проходит, {q: 'a'} и [] — нет
    expect(hasValidatedInput(domain.loose)).toBe(true);
    expect(hasValidatedInput(domain.nothing)).toBe(true);
    expect(hasValidatedInput(domain.anything)).toBe(false);
    expect(hasValidatedInput(domain.list)).toBe(false);
    expect(hasValidatedInput('not a procedure')).toBe(false);
  });

  // Что угодно, кроме определения процедуры: null — объект по typeof,
  // а «~orpc» бывает null, undefined и не объектом
  it('treats anything without a procedure definition as not validated', () => {
    const nonProcedures: unknown[] = [
      42,
      null,
      undefined,
      {},
      { '~orpc': null },
      { '~orpc': undefined },
      { '~orpc': 'definition' },
    ];

    for (const value of nonProcedures) {
      expect(hasValidatedInput(value)).toBe(false);
    }
  });

  // Пробы входа — по одной на каждый вид значения. Для каждой есть схема,
  // отвергающая только её: убери пробу — такая схема перестанет считаться
  // валидирующей, и её операция лишится 400 в спеке
  it.each([
    ['undefined', undefined, z.unknown().refine((value) => value !== undefined)],
    ['an empty object', {}, z.any().refine((value) => !isEmptyObject(value))],
    [
      'an empty array',
      [],
      z.any().refine((value) => !(Array.isArray(value) && value.length === 0)),
    ],
    ['null', null, z.any().refine((value) => value !== null)],
    ['an empty string', '', z.any().refine((value) => value !== '')],
    ['zero', 0, z.any().refine((value) => value !== 0)],
    ['false', false, z.any().refine((value) => value !== false)],
  ])('counts an input as validated when its schema rejects only %s', (_, probe, schema) => {
    const rejected = PROBES.filter((other) => !schema.safeParse(other).success);

    expect(rejected).toEqual([probe]);
    expect(hasValidatedInput(procedureWith(schema))).toBe(true);
  });

  // Процедура без маршрута — не операция: у неё нет «METHOD /path», под
  // которым спека обещает 400, каким бы ни был её вход
  it('leaves out a procedure without a route, even with a validated public input', () => {
    const rpcOnly = ocPublic
      .meta({ access: { type: 'public' } })
      .input(title)
      .output(z.string());

    expect(hasValidatedInput(rpcOnly)).toBe(true);
    expect(operationsWithInputValidation({ ...domain, rpcOnly })).toEqual(
      new Set(VALIDATED_OPERATIONS),
    );
  });

  // Маршрут — пара из метода и пути: метод без пути или путь без метода —
  // не операция, под которой спека обещает 400
  it('leaves out a route with no method or no path', () => {
    const methodOnly = ocPublic
      .route({ method: 'POST', summary: 'Fixture' })
      .meta({ access: { type: 'public' } })
      .input(title)
      .output(z.string());
    const pathOnly = ocPublic
      .route({ path: '/notes/path-only', summary: 'Fixture' })
      .meta({ access: { type: 'public' } })
      .input(title)
      .output(z.string());

    expect(operationsWithInputValidation({ ...domain, methodOnly, pathOnly })).toEqual(
      new Set(VALIDATED_OPERATIONS),
    );
  });

  // Домен `pnpm gen feature` вкладывается в роутер контракта: процедура
  // находится на любой глубине вложенных роутеров
  it('finds procedures at any depth of nested routers', () => {
    const nested = {
      notes: { create: note('/notes/nested').input(title).output(z.string()) },
    };

    expect(operationsWithInputValidation({ ...domain, nested })).toEqual(
      new Set([...VALIDATED_OPERATIONS, 'POST /notes/nested']),
    );
  });

  it('gets the validation 400 on a generated domain without touching any list', async () => {
    const spec = await generateSpec(domain);

    // Независимый оракул: какие тела 400 пропускает схема ответа
    expect(
      operationsOf(spec)
        .filter(({ key }) => accepted400(spec, key).includes('validationFailed'))
        .map(({ key }) => key)
        .toSorted(),
    ).toEqual(VALIDATED_OPERATIONS);
  });
});

describe('generateSpec on the real contract', () => {
  it('renders DELETE 200 as a bodyless response instead of an always-false schema', async () => {
    const spec = await generateSpec(contract);

    expect(spec.paths?.['/tasks/{id}']?.delete?.responses?.['200']).toEqual({ description: 'OK' });
  });

  it('computes the operations with reachable validation 400 from the contract router', () => {
    // list входа не имеет; remove валидирует тот же TaskIdInputSchema, но
    // owner-проверка отвечает FORBIDDEN до валидации (fail-closed, C2.3):
    // 400 валидации для DELETE недостижим
    expect([...operationsWithInputValidation(contract)]).toEqual([
      'POST /tasks',
      'POST /tasks/{id}/toggle',
    ]);
  });

  // Ожидание записано руками, а не выведено тем же правилом, что строит
  // спеку (ревью e56); формы проверяет свёртка по фикстурам провода.
  it('documents 400 on every operation with exactly the shapes it answers', async () => {
    const spec = await generateSpec(contract);

    expect(answers400(spec)).toEqual({
      'DELETE /tasks/{id}': ['malformedBody'],
      'GET /tasks': ['unreadableBody'],
      'POST /tasks': ['malformedBody', 'validationFailed'],
      'POST /tasks/{id}/toggle': ['malformedBody', 'validationFailed'],
    });
  });

  it('builds 400, 413 and 504 from the wire fixtures', async () => {
    const spec = await generateSpec(contract);
    const create = spec.paths?.['/tasks']?.post;

    // Те же фикстуры, что сверяет с рантаймом apps/api/src/app.test.ts
    expect(mismatches(bodySchemaOf(create, '400'), errorResponses.validationFailed.body)).toEqual(
      [],
    );
    expect(mismatches(bodySchemaOf(create, '400'), errorResponses.malformedBody.body)).toEqual([]);
    expect(mismatches(bodySchemaOf(create, '413'), errorResponses.payloadTooLarge.body)).toEqual(
      [],
    );
    expect(mismatches(bodySchemaOf(create, '504'), errorResponses.requestTimedOut.body)).toEqual(
      [],
    );
    expect(
      mismatches(
        bodySchemaOf(spec.paths?.['/tasks']?.get, '400'),
        errorResponses.unreadableBody.body,
      ),
    ).toEqual([]);
  });

  it('describes the 400 without data as a separate schema: the two shapes do not overlap', async () => {
    const spec = await generateSpec(contract);
    const schema = bodySchemaOf(spec.paths?.['/tasks']?.post, '400');
    const variants: unknown[] =
      isRecord(schema) && Array.isArray(schema['oneOf']) ? schema['oneOf'] : [];

    // Дефект e56: тело без data не проходило схему с обязательным data. Для
    // каждого варианта — [отвергает ли битое тело, отвергает ли провал валидации]
    const rejected = variants.map((variant) => [
      mismatches(variant, errorResponses.malformedBody.body).length > 0,
      mismatches(variant, errorResponses.validationFailed.body).length > 0,
    ]);
    expect(rejected).toEqual([
      [true, false],
      [false, true],
    ]);
  });

  it('documents 413 on every method that carries a body and 504 on every operation', async () => {
    const spec = await generateSpec(contract);

    expect(keysWithResponse(spec, '413')).toEqual([
      'DELETE /tasks/{id}',
      'POST /tasks',
      'POST /tasks/{id}/toggle',
    ]);
    const withoutTimeout = operationsOf(spec).filter(
      ({ operation }) => operation.responses?.['504'] === undefined,
    );
    expect(withoutTimeout.map(({ key }) => key)).toEqual([]);
  });

  // e57: контракт описывает только достижимое. 403 отвечает проверка доступа,
  // поэтому он описан у remove (owner) и отсутствует у public-процедур.
  it('documents 403 only for the procedure that checks access', async () => {
    const spec = await generateSpec(contract);

    expect(spec.paths?.['/tasks/{id}']?.delete?.responses?.['403']).toMatchObject({
      description: '403',
    });
    const promised = operationsOf(spec)
      .filter(({ operation }) => operation.responses?.['403'] !== undefined)
      .map(({ key }) => key);
    expect(promised).toEqual(['DELETE /tasks/{id}']);
  });

  it('keeps the API version unwielded on purpose', async () => {
    const spec = await generateSpec(contract);

    // Осознанное решение e56 (см. комментарий у API_VERSION): смена значения — правка константы и этого теста
    expect(spec.info.version).toBe(API_VERSION);
  });

  it('keeps generation deterministic across runs', async () => {
    const first = await generateSpec(contract);
    const second = await generateSpec(contract);

    expect(second).toEqual(first);
  });
});

// e58: заголовок x-workspace-id описан у всех процедур, которые его читают,
// и только у них. Список процедур — из workspace.ts, не руками: ручной не
// знал бы доменов, которые добавляет `pnpm gen feature`.

/** Объявлен ли параметр заголовком рабочего пространства. */
function isWorkspaceHeaderParameter(parameter: unknown): boolean {
  return (
    typeof parameter === 'object' &&
    parameter !== null &&
    'name' in parameter &&
    parameter.name === WORKSPACE_HEADER &&
    'in' in parameter &&
    parameter.in === 'header'
  );
}

/** Объявлен ли заголовок рабочего пространства среди параметров операции. */
function declaresWorkspaceHeader(operation: OpenAPI.OperationObject): boolean {
  return operation.parameters?.some(isWorkspaceHeaderParameter) === true;
}

/** Ключи операций, у которых объявлен заголовок рабочего пространства. */
function keysWithWorkspaceHeader(spec: OpenAPI.Document): string[] {
  return operationsOf(spec)
    .filter(({ operation }) => declaresWorkspaceHeader(operation))
    .map(({ key }) => key)
    .toSorted();
}

/** Операции («METHOD /path»), которые workspace.ts называет читателями заголовка. */
function readerOperations(): string[] {
  return [...workspaceScopedOperations(contract)].toSorted();
}

/** Часть схемы ответа списка, которая нужна здесь: createdAt и его описание. */
const CREATED_AT_OF_LIST = z.object({
  items: z.object({
    properties: z.object({
      createdAt: z.object({ type: z.string(), format: z.string(), description: z.string() }),
    }),
  }),
});

describe('workspace header in the spec', () => {
  it('documents the header exactly on the operations workspace.ts names as readers', async () => {
    const spec = await generateSpec(contract);
    const readers = readerOperations();

    expect(readers).not.toEqual([]);
    expect(keysWithWorkspaceHeader(spec)).toEqual(readers);
    for (const { key, operation } of operationsOf(spec)) {
      const header = operation.parameters?.find(isWorkspaceHeaderParameter);
      expect(header).toEqual(readers.includes(key) ? WORKSPACE_HEADER_PARAMETER : undefined);
    }
  });

  // Критерий приёмки назван про файл: закоммиченный openapi.json, а не только
  // сгенерированная спека, описывает заголовок у тех же операций.
  it('carries the header in the committed openapi.json, on the same operations', () => {
    const committed: OpenAPI.Document = JSON.parse(
      readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'),
    );

    expect(keysWithWorkspaceHeader(committed)).toEqual(readerOperations());
    for (const { operation } of operationsOf(committed)) {
      expect(operation.parameters?.find(isWorkspaceHeaderParameter)).toEqual(
        declaresWorkspaceHeader(operation) ? WORKSPACE_HEADER_PARAMETER : undefined,
      );
    }
  });

  it('describes createdAt as the canonical UTC form the answers carry', async () => {
    const spec = await generateSpec(contract);
    const { createdAt } = CREATED_AT_OF_LIST.parse(bodySchemaOf(spec.paths?.['/tasks']?.get, '200'))
      .items.properties;

    expect(createdAt).toMatchObject({ type: 'string', format: 'date-time' });
    expect(createdAt.description).toMatch(/with the `Z` suffix, a UTC offset is rejected/);
    expect(createdAt.description).toMatch(/Date#toISOString\(\), milliseconds included/);
  });
});
