import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

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

/** Тело запроса из одного поля value — фикстура сужений входа. */
const inputWithField = (field: SchemaNode): SpecDocument =>
  createTaskSpec({ type: 'object', properties: { value: field } }, taskSchema());

/** Ответ из одного поля value — фикстура расширений выхода. */
const outputWithField = (field: SchemaNode): SpecDocument =>
  listTasksSpec({ type: 'object', properties: { value: field }, required: ['value'] });

/** Клон фикстуры /tasks с operationId у get; undefined — operationId снят. */
const withOperationId = (spec: SpecDocument, operationId: string | undefined): SpecDocument => {
  const copy = structuredClone(spec);
  const operation = copy.paths?.['/tasks']?.['get'];
  if (operation === undefined) {
    throw new Error('fixture: в /tasks нет get');
  }
  if (operationId === undefined) {
    delete operation.operationId;
    return copy;
  }
  operation.operationId = operationId;
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

describe('checkCompatibility: появление и снятие ограничения (e46)', () => {
  /** Все границы чекера: «нет границы» — это «без ограничения», а не «не сравнивать». */
  const BOUNDS = [
    'minLength',
    'maxLength',
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'minItems',
    'maxItems',
  ] as const;
  type Bound = (typeof BOUNDS)[number];

  /** Поле value подходящего типа (строка, число, массив строк) с границей или без неё. */
  const bounded = (keyword: Bound, value?: number): SchemaNode => {
    const field: SchemaNode =
      keyword === 'minLength' || keyword === 'maxLength'
        ? { type: 'string' }
        : keyword === 'minItems' || keyword === 'maxItems'
          ? { type: 'array', items: { type: 'string' } }
          : { type: 'number' };
    if (value !== undefined) {
      field[keyword] = value;
    }
    return field;
  };
  const inputWhere = 'POST /tasks.requestBody.application/json.properties.value';
  const outputWhere = 'GET /tasks.responses.200.application/json.items.properties.value';

  it.each(BOUNDS)('%s: a bound appearing on input is flagged', (keyword) => {
    const findings = checkCompatibility(
      inputWithField(bounded(keyword)),
      inputWithField(bounded(keyword, 10)),
    );

    expect(findings).toEqual([
      { kind: 'bound-narrowed', where: inputWhere, message: expect.stringContaining(keyword) },
    ]);
  });

  it.each(BOUNDS)('%s: a bound removed from output is flagged', (keyword) => {
    const findings = checkCompatibility(
      outputWithField(bounded(keyword, 10)),
      outputWithField(bounded(keyword)),
    );

    expect(findings).toEqual([
      { kind: 'bound-widened', where: outputWhere, message: expect.stringContaining(keyword) },
    ]);
  });

  it.each(BOUNDS)('%s: a bound appearing on output passes', (keyword) => {
    expect(
      checkCompatibility(outputWithField(bounded(keyword)), outputWithField(bounded(keyword, 10))),
    ).toEqual([]);
  });

  it.each(BOUNDS)('%s: a bound removed from input passes', (keyword) => {
    expect(
      checkCompatibility(inputWithField(bounded(keyword, 10)), inputWithField(bounded(keyword))),
    ).toEqual([]);
  });

  it('additionalProperties: false appearing on an input object is flagged (object → strictObject)', () => {
    const looseInput = createTaskSpec(
      { type: 'object', properties: { title: { type: 'string' } } },
      taskSchema(),
    );
    const strictInput = createTaskSpec(
      { type: 'object', properties: { title: { type: 'string' } }, additionalProperties: false },
      taskSchema(),
    );

    const findings = checkCompatibility(looseInput, strictInput);

    expect(findings).toEqual([
      {
        kind: 'additional-properties-narrowed',
        where: 'POST /tasks.requestBody.application/json',
        message: expect.stringContaining('additionalProperties'),
      },
    ]);
  });

  it('additionalProperties: false removed from an output object is flagged', () => {
    const loose: SchemaNode = { type: 'object', properties: { title: { type: 'string' } } };
    const strict: SchemaNode = { ...loose, additionalProperties: false };

    const findings = checkCompatibility(outputWithField(strict), outputWithField(loose));

    expect(findings).toEqual([
      {
        kind: 'additional-properties-widened',
        where: outputWhere,
        message: expect.stringContaining('additionalProperties'),
      },
    ]);
    // Обратные направления безопасны: вход смягчён, выход стал строже.
    expect(checkCompatibility(inputWithField(strict), inputWithField(loose))).toEqual([]);
    expect(checkCompatibility(outputWithField(loose), outputWithField(strict))).toEqual([]);
  });

  it('renaming an operationId is flagged: the old name is gone from the spec', () => {
    const findings = checkCompatibility(
      withOperationId(listTasksSpec(taskSchema()), 'tasks.list'),
      withOperationId(listTasksSpec(taskSchema()), 'tasks.getAll'),
    );

    expect(findings).toEqual([
      {
        kind: 'operation-id-changed',
        where: 'GET /tasks',
        message: 'operationId «tasks.list» → «tasks.getAll»',
      },
    ]);
  });

  it('removing an operationId is flagged', () => {
    const findings = checkCompatibility(
      withOperationId(listTasksSpec(taskSchema()), 'tasks.list'),
      withOperationId(listTasksSpec(taskSchema()), undefined),
    );

    expect(findings).toEqual([
      {
        kind: 'operation-id-changed',
        where: 'GET /tasks',
        message: 'operationId «tasks.list» снят',
      },
    ]);
  });

  it('an operationId appearing where there was none is an addition and passes', () => {
    expect(
      checkCompatibility(
        listTasksSpec(taskSchema()),
        withOperationId(listTasksSpec(taskSchema()), 'tasks.list'),
      ),
    ).toEqual([]);
  });

  it('the committed openapi.json: a bound removed from a response field is flagged', () => {
    const specPath = fileURLToPath(new URL('../openapi.json', import.meta.url));
    const spec = parseSpec(readFileSync(specPath, 'utf8'));
    if (spec === null) {
      throw new Error('fixture: packages/contracts/openapi.json не распознан');
    }

    // Канарейка e46 на настоящей спецификации: снятие maxLength с title в
    // ответе tasks.list — воспроизведение дефекта из аудита (ноль находок).
    const loosened = withTaskSchema(spec, (task) => {
      delete task.properties?.['title']?.maxLength;
    });

    expect(checkCompatibility(spec, loosened)).toEqual([
      {
        kind: 'bound-widened',
        where: 'GET /tasks.responses.200.application/json.items.properties.title',
        message: expect.stringContaining('maxLength'),
      },
    ]);
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

// --- CLI: база сравнения (e48) --------------------------------------------------------

/** Результат запуска CLI в дочернем процессе. */
interface CliRun {
  status: number;
  stdout: string;
  stderr: string;
}

/** Временный репозиторий без remote с копией настоящего CLI. */
interface CliRepo {
  commitSpec: (next: SpecDocument) => void;
  head: () => string;
  run: (env: Record<string, string>, ...args: string[]) => CliRun;
}

const cliDirs: string[] = [];

afterEach(() => {
  for (const dir of cliDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Ответ /tasks без completed — breaking change относительно taskSchema (response-field-removed). */
const responseWithoutCompleted = (): SpecDocument =>
  listTasksSpec({
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      title: { type: 'string', minLength: 1, maxLength: 200 },
    },
    required: ['id', 'title'],
  });

/**
 * Репозиторий без remote, где CLI лежит на своём пути (скрипт считает корень
 * от расположения: scripts/ → contracts → packages → корень). Окружение
 * запуска строится с нуля: наследованный TURBO_SCM_BASE или разрешение базы
 * HEAD делали бы исход зависимым от того, что стоит в окружении тестов.
 */
function makeRepo(spec: SpecDocument): CliRepo {
  // tmpdir на macOS — под симлинком (/var → /private/var): без realpath путь
  // argv[1] разошёлся бы с import.meta.url, и скрипт не счёл бы запуск прямым.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'e48-openapi-compat-')));
  cliDirs.push(dir);
  const cli = join(dir, 'packages/contracts/scripts/openapi-compat.ts');
  mkdirSync(join(dir, 'packages/contracts/scripts'), { recursive: true });
  copyFileSync(fileURLToPath(new URL('./openapi-compat.ts', import.meta.url)), cli);
  // Глобальный git-конфиг машины (gpgsign, hooksPath) не должен ломать fixture.
  const neutral = ['-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${join(dir, '.nohooks')}`];
  const git = (...args: string[]): string => {
    const done = spawnSync('git', ['-C', dir, ...neutral, ...args], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (done.error !== undefined || done.status !== 0) {
      throw new Error(
        `fixture: git ${args.join(' ')} failed: ${String(done.error ?? done.stderr)}`,
      );
    }
    return done.stdout;
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e48@example.invalid');
  git('config', 'user.name', 'e48 fixture');

  const commitSpec = (next: SpecDocument): void => {
    writeFileSync(
      join(dir, 'packages/contracts/openapi.json'),
      `${JSON.stringify(next, null, 2)}\n`,
    );
    git('add', '.');
    git('commit', '-qm', 'spec');
  };
  commitSpec(spec);

  return {
    commitSpec,
    head: () => git('rev-parse', 'HEAD').trim(),
    run: (env, ...args) => {
      const done = spawnSync(process.execPath, [cli, ...args], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 60_000,
        env: { PATH: process.env['PATH'] ?? '', ...env },
      });
      if (done.error !== undefined) {
        throw new Error(`fixture: CLI failed: ${String(done.error)}`);
      }
      return { status: done.status ?? -1, stdout: done.stdout, stderr: done.stderr };
    },
  };
}

describe('CLI: база сравнения (e48)', () => {
  it('a repository without origin/main and without an explicit base fails instead of comparing HEAD with itself', () => {
    const repo = makeRepo(listTasksSpec(taskSchema()));
    repo.commitSpec(responseWithoutCompleted());

    const run = repo.run({});

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('openapi-compat: база не определена');
    // Инструкция называет оба канала: локальный и CI.
    expect(run.stderr).toContain('git fetch origin main');
    expect(run.stderr).toContain('--base <ref>');
    expect(run.stderr).toContain('TURBO_SCM_BASE');
    expect(run.stdout).not.toContain('несовместимых изменений');
  });

  it.each([
    {
      channel: 'TURBO_SCM_BASE',
      env: (base: string): Record<string, string> => ({ TURBO_SCM_BASE: base }),
      args: (): string[] => [],
    },
    {
      channel: '--base <ref>',
      env: (): Record<string, string> => ({}),
      args: (base: string): string[] => ['--base', base],
    },
  ])('$channel reaches the breaking change where there is no origin/main', ({ env, args }) => {
    const repo = makeRepo(listTasksSpec(taskSchema()));
    const base = repo.head();
    repo.commitSpec(responseWithoutCompleted());

    const run = repo.run(env(base), ...args(base));

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('[response-field-removed]');
  });

  it('the explicit opt-in compares HEAD with itself (the template copy canary)', () => {
    const repo = makeRepo(listTasksSpec(taskSchema()));
    repo.commitSpec(responseWithoutCompleted());

    const run = repo.run({ OPENAPI_COMPAT_ALLOW_HEAD_BASE: '1' });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`относительно ${repo.head()} нет`);
    // Разрешение не тихое: в выводе сказано, что проверено сравнение с самим собой.
    expect(run.stdout).toContain('OPENAPI_COMPAT_ALLOW_HEAD_BASE=1');
  });

  it.each(['0', 'false', '', 'yes'])('only the exact value opts in, not «%s»', (value) => {
    const repo = makeRepo(listTasksSpec(taskSchema()));

    const run = repo.run({ OPENAPI_COMPAT_ALLOW_HEAD_BASE: value });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('openapi-compat: база не определена');
  });

  it('the opt-in does not rescue an explicit base that does not resolve', () => {
    const repo = makeRepo(listTasksSpec(taskSchema()));

    const run = repo.run({ OPENAPI_COMPAT_ALLOW_HEAD_BASE: '1', TURBO_SCM_BASE: 'origin/main' });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('openapi-compat: база origin/main не резолвится в коммит.');
  });
});
