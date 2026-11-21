import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  checkCompatibility,
  diffSchema,
  parseSpec,
  type Direction,
  type Finding,
  type SchemaNode,
  type SpecDocument,
} from './openapi-compat.ts';

// --- Фикстуры ---------------------------------------------------------------------

const taskSchema = (): SchemaNode => ({
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    title: { type: 'string', minLength: 1, maxLength: 200 },
    completed: { type: 'boolean' },
  },
  required: ['id', 'title', 'completed'],
});

const listTasksSpec = (task: SchemaNode): SpecDocument => ({
  paths: {
    '/tasks': {
      get: {
        responses: {
          '200': {
            content: { 'application/json': { schema: { type: 'array', items: task } } },
          },
        },
      },
    },
  },
});

const createTaskSpec = (input: SchemaNode, output: SchemaNode): SpecDocument => ({
  paths: {
    '/tasks': {
      post: {
        requestBody: {
          required: true,
          content: { 'application/json': { schema: input } },
        },
        responses: {
          '200': { content: { 'application/json': { schema: output } } },
        },
      },
    },
  },
});

const kinds = (findings: Finding[]): string[] => findings.map((finding) => finding.kind);

/** Вариант union-ответа ошибки из генератора: const-метка кода. */
const errorSchema = (code: string): SchemaNode => ({
  type: 'object',
  properties: { code: { const: code } },
  required: ['code'],
});

/** Фикстура union-ответа ошибки из генератора: const-метка кода. */
const specWithErrors = (codes: string[]): SpecDocument => ({
  paths: {
    '/tasks': {
      get: {
        responses: {
          '403': {
            content: {
              'application/json': { schema: { oneOf: codes.map((code) => errorSchema(code)) } },
            },
          },
        },
      },
    },
  },
});

/** Схема задачи в фикстуре /tasks: у get это items массива, у post — тело ответа. */
const taskSchemaRef = (spec: SpecDocument): SchemaNode => {
  const operation = spec.paths?.['/tasks']?.['get'] ?? spec.paths?.['/tasks']?.['post'];
  const container = operation?.responses?.['200']?.content?.['application/json']?.schema;
  if (container === undefined) {
    throw new Error('fixture: в /tasks нет схемы ответа 200');
  }
  const task = container.type === 'array' ? container.items : container;
  if (task === undefined) {
    throw new Error('fixture: у массива ответа нет items');
  }
  return task;
};

/** Клон с правкой схемы задачи: у get это items массива, у post — тело ответа. */
const withTaskSchema = (spec: SpecDocument, mutate: (schema: SchemaNode) => void): SpecDocument => {
  const copy = structuredClone(spec);
  mutate(taskSchemaRef(copy));
  return copy;
};

// --- Канарейки критериев приёмки ----------------------------------------------------

describe('checkCompatibility: критерии приёмки C6', () => {
  it('removing a response field from the contract is flagged as breaking', () => {
    const base = listTasksSpec(taskSchema());
    const current = withTaskSchema(listTasksSpec(taskSchema()), (schema) => {
      if (schema.properties === undefined) {
        throw new Error('fixture: нет properties');
      }
      delete schema.properties['completed'];
      schema.required = schema.required?.filter((name) => name !== 'completed') ?? [];
    });

    const findings = checkCompatibility(base, current);

    expect(kinds(findings)).toEqual(['response-field-removed']);
    expect(findings[0]?.where).toBe(
      'GET /tasks.responses.200.application/json.items.properties.completed',
    );
  });

  it('adding an optional response field passes', () => {
    const base = listTasksSpec(taskSchema());
    const current = withTaskSchema(listTasksSpec(taskSchema()), (schema) => {
      if (schema.properties === undefined) {
        throw new Error('fixture: нет properties');
      }
      schema.properties['dueDate'] = { type: 'string', format: 'date-time' };
    });

    const findings = checkCompatibility(base, current);

    expect(findings).toEqual([]);
  });
});

// --- Правила несовместимости --------------------------------------------------------

describe('checkCompatibility: процедуры и ответы', () => {
  it('removing a procedure is flagged', () => {
    const base: SpecDocument = {
      paths: {
        '/tasks': { get: { responses: { '200': {} } } },
        '/tasks/{id}': { delete: { responses: { '200': {} } } },
      },
    };

    const findings = checkCompatibility(base, listTasksSpec(taskSchema()));

    expect(kinds(findings)).toEqual(['procedure-removed']);
    expect(findings[0]?.where).toBe('DELETE /tasks/{id}');
  });

  it('adding a procedure and an error response are additions and pass', () => {
    const base = listTasksSpec(taskSchema());
    const current: SpecDocument = {
      paths: {
        '/tasks': {
          get: {
            responses: {
              '200': {
                content: { 'application/json': { schema: { type: 'array', items: taskSchema() } } },
              },
              '403': { content: { 'application/json': { schema: {} } } },
            },
          },
        },
        '/tasks/archive': { get: { responses: { '200': {} } } },
      },
    };

    const findings = checkCompatibility(base, current);

    expect(findings).toEqual([]);
  });

  it('removing a response status code is flagged', () => {
    const base: SpecDocument = {
      paths: { '/tasks': { get: { responses: { '200': {}, '403': {} } } } },
    };
    const current = listTasksSpec(taskSchema());

    const findings = checkCompatibility(base, current);

    expect(kinds(findings)).toEqual(['response-status-removed']);
  });

  it('renaming an output field is flagged as removal', () => {
    const base = listTasksSpec(taskSchema());
    const current = withTaskSchema(listTasksSpec(taskSchema()), (schema) => {
      if (schema.properties === undefined) {
        throw new Error('fixture: нет properties');
      }
      delete schema.properties['completed'];
      schema.properties['isDone'] = { type: 'boolean' };
      schema.required = [
        ...(schema.required?.filter((name) => name !== 'completed') ?? []),
        'isDone',
      ];
    });

    const findings = checkCompatibility(base, current);

    // Замена required-поля на другое required-поле — это и удаление, и новое
    // обязательное свойство ответа.
    expect(kinds(findings)).toEqual(['response-field-removed', 'required-response-field-added']);
    expect(findings[0]?.where).toBe(
      'GET /tasks.responses.200.application/json.items.properties.completed',
    );
  });

  it('removing a request field is flagged (rename detection, skill contract)', () => {
    const base = createTaskSpec(
      {
        type: 'object',
        properties: { title: { type: 'string' }, tag: { type: 'string' } },
        required: ['title'],
      },
      taskSchema(),
    );
    const current = createTaskSpec(
      { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
      taskSchema(),
    );

    const findings = checkCompatibility(base, current);

    expect(kinds(findings)).toEqual(['request-field-removed']);
  });
});

describe('checkCompatibility: обязательные поля', () => {
  it('a new required input field is flagged', () => {
    const base = createTaskSpec(
      { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
      taskSchema(),
    );
    const current = createTaskSpec(
      {
        type: 'object',
        properties: { title: { type: 'string' }, priority: { type: 'string' } },
        required: ['title', 'priority'],
      },
      taskSchema(),
    );

    const findings = checkCompatibility(base, current);

    expect(kinds(findings)).toEqual(['required-field-added']);
  });

  it('an existing input field becoming required is flagged', () => {
    const base = createTaskSpec(
      {
        type: 'object',
        properties: { title: { type: 'string' }, tag: { type: 'string' } },
        required: ['title'],
      },
      taskSchema(),
    );
    const current = createTaskSpec(
      {
        type: 'object',
        properties: { title: { type: 'string' }, tag: { type: 'string' } },
        required: ['title', 'tag'],
      },
      taskSchema(),
    );

    const findings = checkCompatibility(base, current);

    expect(kinds(findings)).toEqual(['required-field-added']);
  });

  it('a new response property that is immediately required is flagged', () => {
    const base = listTasksSpec(taskSchema());
    const current = withTaskSchema(listTasksSpec(taskSchema()), (schema) => {
      if (schema.properties === undefined) {
        throw new Error('fixture: нет properties');
      }
      schema.properties['ownerId'] = { type: 'string' };
      schema.required = [...(schema.required ?? []), 'ownerId'];
    });

    const findings = checkCompatibility(base, current);

    expect(kinds(findings)).toEqual(['required-response-field-added']);
  });

  it('a required response field becoming optional is flagged', () => {
    const base = listTasksSpec(taskSchema());
    const current = withTaskSchema(listTasksSpec(taskSchema()), (schema) => {
      schema.required = schema.required?.filter((name) => name !== 'completed') ?? [];
    });

    const findings = checkCompatibility(base, current);

    expect(kinds(findings)).toEqual(['required-response-field-weakened']);
  });

  it('an optional input field passes', () => {
    const base = createTaskSpec(
      { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
      taskSchema(),
    );
    const current = createTaskSpec(
      {
        type: 'object',
        properties: { title: { type: 'string' }, tag: { type: 'string' } },
        required: ['title'],
      },
      taskSchema(),
    );

    const findings = checkCompatibility(base, current);

    expect(findings).toEqual([]);
  });
});

describe('checkCompatibility: сужение входа и расширение выхода', () => {
  it('tightening maxLength on input is flagged', () => {
    const base = createTaskSpec(
      {
        type: 'object',
        properties: { title: { type: 'string', maxLength: 200 } },
        required: ['title'],
      },
      taskSchema(),
    );
    const current = createTaskSpec(
      {
        type: 'object',
        properties: { title: { type: 'string', maxLength: 100 } },
        required: ['title'],
      },
      taskSchema(),
    );

    const findings = checkCompatibility(base, current);

    expect(kinds(findings)).toEqual(['bound-changed']);
  });

  it('loosening maxLength on input passes', () => {
    const base = createTaskSpec(
      {
        type: 'object',
        properties: { title: { type: 'string', maxLength: 100 } },
        required: ['title'],
      },
      taskSchema(),
    );
    const current = createTaskSpec(
      {
        type: 'object',
        properties: { title: { type: 'string', maxLength: 200 } },
        required: ['title'],
      },
      taskSchema(),
    );

    const findings = checkCompatibility(base, current);

    expect(findings).toEqual([]);
  });

  it('changing the type on input is flagged, string → [string, number] passes', () => {
    const base = createTaskSpec(
      { type: 'object', properties: { value: { type: 'string' } } },
      taskSchema(),
    );
    const narrowed = createTaskSpec(
      { type: 'object', properties: { value: { type: 'number' } } },
      taskSchema(),
    );
    const widened = createTaskSpec(
      { type: 'object', properties: { value: { type: ['string', 'number'] } } },
      taskSchema(),
    );

    expect(kinds(checkCompatibility(base, narrowed))).toEqual(['type-changed']);
    expect(checkCompatibility(base, widened)).toEqual([]);
  });

  it('number → integer narrows input but is a safe output narrowing', () => {
    const base = createTaskSpec(
      { type: 'object', properties: { value: { type: 'number' } } },
      taskSchema(),
    );
    const integer = createTaskSpec(
      { type: 'object', properties: { value: { type: 'integer' } } },
      taskSchema(),
    );

    expect(kinds(checkCompatibility(base, integer))).toEqual(['type-changed']);
    expect(
      checkCompatibility(listTasksSpec({ type: 'number' }), listTasksSpec({ type: 'integer' })),
    ).toEqual([]);
  });

  it('widening the output type is flagged: old clients cannot parse new values', () => {
    const base = listTasksSpec({ type: 'string' });

    const findings = checkCompatibility(base, listTasksSpec({ type: ['string', 'number'] }));

    expect(kinds(findings)).toEqual(['type-changed']);
  });

  it('enum narrowing on input and widening on output are flagged', () => {
    const inputBase = createTaskSpec(
      { type: 'object', properties: { tag: { type: 'string', enum: ['a', 'b'] } } },
      taskSchema(),
    );
    const inputNarrow = createTaskSpec(
      { type: 'object', properties: { tag: { type: 'string', enum: ['a'] } } },
      taskSchema(),
    );

    expect(kinds(checkCompatibility(inputBase, inputNarrow))).toEqual(['enum-changed']);

    const outputBase = listTasksSpec({ type: 'string', enum: ['a'] });
    const outputWide = listTasksSpec({ type: 'string', enum: ['a', 'b'] });

    expect(kinds(checkCompatibility(outputBase, outputWide))).toEqual(['enum-changed']);
  });

  it('adding format on input and removing format on output are flagged', () => {
    const plainInput = createTaskSpec(
      { type: 'object', properties: { id: { type: 'string' } } },
      taskSchema(),
    );
    const uuidInput = createTaskSpec(
      { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      taskSchema(),
    );

    expect(kinds(checkCompatibility(plainInput, uuidInput))).toEqual(['format-narrowed']);
    expect(
      kinds(
        checkCompatibility(
          listTasksSpec({ type: 'string', format: 'uuid' }),
          listTasksSpec({ type: 'string' }),
        ),
      ),
    ).toEqual(['format-removed']);
  });
});

describe('checkCompatibility: тело запроса, параметры, union', () => {
  it('removing the request body and adding a required one are flagged', () => {
    const withBody: SpecDocument = {
      paths: {
        '/tasks': {
          post: { requestBody: { required: true, content: {} }, responses: { '200': {} } },
        },
      },
    };
    const withoutBody: SpecDocument = {
      paths: { '/tasks': { post: { responses: { '200': {} } } } },
    };

    expect(kinds(checkCompatibility(withBody, withoutBody))).toEqual(['request-body-removed']);
    expect(kinds(checkCompatibility(withoutBody, withBody))).toEqual(['required-field-added']);
  });

  it('removing a parameter and adding a required one are flagged; optional passes', () => {
    const withParameter: SpecDocument = {
      paths: {
        '/tasks': {
          get: {
            parameters: [
              { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
            ],
            responses: { '200': {} },
          },
        },
      },
    };
    const withRequiredParameter: SpecDocument = {
      paths: {
        '/tasks': {
          get: {
            parameters: [
              { name: 'limit', in: 'query', required: true, schema: { type: 'integer' } },
            ],
            responses: { '200': {} },
          },
        },
      },
    };
    const withoutParameter: SpecDocument = {
      paths: { '/tasks': { get: { responses: { '200': {} } } } },
    };

    expect(kinds(checkCompatibility(withParameter, withoutParameter))).toEqual([
      'parameter-removed',
    ]);
    expect(kinds(checkCompatibility(withoutParameter, withRequiredParameter))).toEqual([
      'required-field-added',
    ]);
    expect(checkCompatibility(withoutParameter, withParameter)).toEqual([]);
  });

  it('removing a union option is flagged; adding one passes', () => {
    expect(kinds(checkCompatibility(specWithErrors(['A', 'B']), specWithErrors(['A'])))).toEqual([
      'union-option-removed',
    ]);
    expect(checkCompatibility(specWithErrors(['A']), specWithErrors(['A', 'B']))).toEqual([]);
  });
});

describe('checkCompatibility: база и реальные данные', () => {
  it('identical specs produce no findings', () => {
    const spec = listTasksSpec(taskSchema());

    expect(checkCompatibility(spec, spec)).toEqual([]);
  });

  it('an empty base treats the whole current spec as additions', () => {
    const findings = checkCompatibility({}, listTasksSpec(taskSchema()));

    expect(findings).toEqual([]);
  });

  it('the committed openapi.json against itself is compatible, and the canary bites on it', () => {
    const specPath = fileURLToPath(new URL('../openapi.json', import.meta.url));
    const spec = parseSpec(readFileSync(specPath, 'utf8'));
    if (spec === null) {
      throw new Error('fixture: packages/contracts/openapi.json не распознан');
    }

    expect(checkCompatibility(spec, spec)).toEqual([]);

    // Канарейка критерия приёмки на настоящей спецификации: удаление поля
    // ответа completed из tasks.list красит чекер.
    const broken = structuredClone(spec);
    const items =
      broken.paths?.['/tasks']?.['get']?.responses?.['200']?.content?.['application/json']?.schema;
    if (items?.type !== 'array' || items.items?.properties === undefined) {
      throw new Error('fixture: в openapi.json не найдена схема списка задач');
    }
    delete items.items.properties['completed'];
    items.items.required = items.items.required?.filter((name) => name !== 'completed') ?? [];

    const findings = checkCompatibility(spec, broken);

    expect(kinds(findings)).toEqual(['response-field-removed']);
  });

  it('parseSpec rejects non-JSON and non-object text', () => {
    expect(parseSpec('not json {')).toBeNull();
    expect(parseSpec('[1, 2]')).toBeNull();
    expect(parseSpec('{"paths": {}}')).toEqual({ paths: {} });
  });
});

describe('diffSchema: направление сравнения', () => {
  it('an added type narrows the request but safely narrows the output', () => {
    const where = 'test';
    const base: SchemaNode = {};
    const typed: SchemaNode = { type: 'string' };

    const requestFindings = (dir: Direction): Finding[] => diffSchema(base, typed, dir, where);

    expect(kinds(requestFindings('request'))).toEqual(['type-narrowed']);
    expect(requestFindings('output')).toEqual([]);
  });
});
