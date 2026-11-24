import type { OpenAPI } from '@orpc/contract';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import { contract, ocAccess, ocPublic } from '../src/index.ts';
import {
  API_VERSION,
  documentErrorResponses,
  errorResponses,
  generateSpec,
  hasValidatedInput,
  operationsWithInputValidation,
  voidSchemaConverter,
} from './openapi-spec.ts';

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
});

/** Public-процедура фикстурного домена: маршрут до `.input(...)`. */
const note = (path: `/${string}`) =>
  ocPublic.route({ method: 'POST', path, summary: 'Fixture' }).meta({ access: { type: 'public' } });

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
