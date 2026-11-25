import { oc } from '@orpc/contract';
import type { HTTPMethod, HTTPPath, OpenAPI } from '@orpc/contract';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import {
  documentWorkspaceHeader,
  isWorkspaceReader,
  parseWorkspaceId,
  readsWorkspace,
  WORKSPACE_HEADER,
  WORKSPACE_HEADER_PARAMETER,
  workspaceScopedOperations,
} from './workspace.ts';

describe('parseWorkspaceId', () => {
  it('accepts word characters, hyphens and underscores up to 64 chars', () => {
    expect(parseWorkspaceId('e2e-workspace_1')).toBe('e2e-workspace_1');
    expect(parseWorkspaceId('a'.repeat(64))).toBe('a'.repeat(64));
  });

  it('rejects malformed header values as null (fallback to the ownerless scope)', () => {
    expect(parseWorkspaceId('')).toBeNull();
    expect(parseWorkspaceId('a'.repeat(65))).toBeNull();
    expect(parseWorkspaceId('has spaces')).toBeNull();
    expect(parseWorkspaceId('../../etc/passwd')).toBeNull();
    expect(parseWorkspaceId('semicolon;drop')).toBeNull();
  });

  it('maps an absent header to null: the ownerless scope', () => {
    expect(parseWorkspaceId(null)).toBeNull();
    expect(parseWorkspaceId(undefined)).toBeNull();
  });

  it('exposes the header name used by api and web readers', () => {
    expect(WORKSPACE_HEADER).toBe('x-workspace-id');
  });
});

// e58: заголовок в спеке. Схема параметра и парсер — из одной строки-источника;
// расхождение сделало бы спеку обещанием, которого рантайм не держит.
describe('WORKSPACE_HEADER_PARAMETER', () => {
  it('is the optional header a client generated from the spec will send', () => {
    expect(WORKSPACE_HEADER_PARAMETER.name).toBe(WORKSPACE_HEADER);
    expect(WORKSPACE_HEADER_PARAMETER.in).toBe('header');
    expect(WORKSPACE_HEADER_PARAMETER.required).toBe(false);
  });

  it('admits exactly the values the parser accepts', () => {
    const pattern = new RegExp(WORKSPACE_HEADER_PARAMETER.schema.pattern);
    const values = [
      'e2e-workspace_1',
      'a'.repeat(64),
      '',
      'a'.repeat(65),
      'has spaces',
      '../../etc/passwd',
      'semicolon;drop',
      'кириллица',
      'line\nbreak',
      '0',
    ];

    for (const value of values) {
      expect(pattern.test(value)).toBe(parseWorkspaceId(value) !== null);
    }
  });

  // «Решение» задачи: заголовка нет — задокументированный режим, а не отказ.
  it('documents the semantics of the absent header instead of promising a 400', () => {
    expect(WORKSPACE_HEADER_PARAMETER.description).toMatch(/without the header/);
    expect(WORKSPACE_HEADER_PARAMETER.description).toMatch(/no error is answered/);
    expect(WORKSPACE_HEADER_PARAMETER.description).toMatch(/silently selects another scope/);
  });
});

const at = (method: HTTPMethod, path: HTTPPath) => oc.route({ method, path }).output(z.void());
const scopedKey = (method: string, path: string) => `${method} ${path}`;

describe('readsWorkspace', () => {
  it('marks a procedure as a reader and returns the same procedure, not a copy', () => {
    const procedure = at('GET', '/tasks');

    const marked = readsWorkspace(procedure);

    expect(marked).toBe(procedure);
    expect(isWorkspaceReader(procedure)).toBe(true);
    expect(isWorkspaceReader(at('GET', '/other'))).toBe(false);
  });

  // e81: строитель каталога заменяет каждую процедуру новым экземпляром из её
  // `~orpc`; метка — ключ в этих опциях и переезжает вместе с ними. Реестр по
  // экземпляру её терял: читатель выходил в спеку без заголовка и без ошибки.
  it('keeps the mark on the procedure the oc.router builder rebuilds', () => {
    const rebuilt = oc.router({
      tasks: { list: readsWorkspace(at('GET', '/tasks')) },
      health: { ping: at('GET', '/ping') },
    });

    expect(isWorkspaceReader(rebuilt.tasks.list)).toBe(true);
    expect(isWorkspaceReader(rebuilt.health.ping)).toBe(false);
    expect([...workspaceScopedOperations(rebuilt)]).toEqual(['GET /tasks']);
  });

  // Префикс строителя даёт процедуре новый route: метка держится не на route.
  it('keeps the mark when the builder moves the procedure under a prefix', () => {
    const rebuilt = oc.prefix('/v1').router({ list: readsWorkspace(at('GET', '/tasks')) });

    expect([...workspaceScopedOperations(rebuilt)]).toEqual(['GET /v1/tasks']);
  });

  // Строители процедуры развёртывают `~orpc` в новую процедуру: производная —
  // та же процедура с иными опциями, и метка при ней.
  it('carries the mark to a procedure a builder derives', () => {
    const derived = readsWorkspace(at('GET', '/tasks')).route({ method: 'GET', path: '/derived' });

    expect(isWorkspaceReader(derived)).toBe(true);
    expect([...workspaceScopedOperations({ derived })]).toEqual(['GET /derived']);
  });

  it('does not leak the mark to the procedure the derived one was built from', () => {
    const source = at('GET', '/tasks');

    readsWorkspace(source.route({ method: 'GET', path: '/derived' }));

    expect(isWorkspaceReader(source)).toBe(false);
  });

  // Fail-closed при определении: обёртка над тем, что процедурой не считается,
  // вернула бы «читателя», которого не найдёт ни один обход.
  it('refuses to mark a value the library does not count as a procedure', () => {
    expect(() => readsWorkspace({ list: at('GET', '/tasks') })).toThrow(
      /readsWorkspace must wrap a contract procedure/,
    );
    expect(() => readsWorkspace({ '~orpc': {} })).toThrow(
      /readsWorkspace must wrap a contract procedure/,
    );
  });
});

describe('workspaceScopedOperations', () => {
  it('lists the operations of the marked procedures only', () => {
    const router = {
      tasks: { list: readsWorkspace(at('GET', '/tasks')) },
      health: { ping: at('GET', '/ping') },
    };

    expect([...workspaceScopedOperations(router)]).toEqual(['GET /tasks']);
  });

  it('finds marked procedures at any depth of nested routers', () => {
    const router = {
      a: { b: { c: { d: readsWorkspace(at('POST', '/deep')) } } },
      plain: at('GET', '/plain'),
    };

    expect([...workspaceScopedOperations(router)]).toEqual(['POST /deep']);
  });

  // e81: узел с ключом `~orpc`, написанный руками, процедурой библиотека не
  // считает — обход идёт вглубь, а не останавливается на нём молча.
  it('looks inside a hand-written node that carries a ~orpc key', () => {
    const node = { '~orpc': {}, list: readsWorkspace(at('GET', '/tasks')) };

    expect([...workspaceScopedOperations(node)]).toEqual(['GET /tasks']);
  });

  it('refuses a reader without a complete route instead of leaving it undocumented', () => {
    const reader = readsWorkspace(oc.output(z.void()));

    expect(() => workspaceScopedOperations({ reader })).toThrow(
      /workspace-scoped procedure needs a route to document the x-workspace-id header/,
    );
  });

  // e81 (ревью качества e58): полумаршрут — метод без пути или путь без метода —
  // тоже читатель без описанного заголовка.
  it('refuses a reader whose route is half-complete as well', () => {
    const methodOnly = readsWorkspace(oc.route({ method: 'GET' }).output(z.void()));
    const pathOnly = readsWorkspace(oc.route({ path: '/half' }).output(z.void()));

    expect(() => workspaceScopedOperations({ procedure: methodOnly })).toThrow(
      /workspace-scoped procedure needs a route to document the x-workspace-id header/,
    );
    expect(() => workspaceScopedOperations({ procedure: pathOnly })).toThrow(
      /workspace-scoped procedure needs a route to document the x-workspace-id header/,
    );
  });
});

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

/** Операции спеки с ключом «METHOD /path». */
function operationsOf(
  spec: OpenAPI.Document,
): { key: string; operation: OpenAPI.OperationObject }[] {
  return Object.entries(spec.paths ?? {}).flatMap(([path, pathItem]) =>
    HTTP_METHODS.flatMap((method) => {
      const operation = pathItem?.[method];
      return operation === undefined
        ? []
        : [{ key: scopedKey(method.toUpperCase(), path), operation }];
    }),
  );
}

/** Объявлен ли заголовок рабочего пространства среди параметров операции. */
function declaresWorkspaceHeader(operation: OpenAPI.OperationObject): boolean {
  return (
    operation.parameters?.some(
      (parameter) =>
        typeof parameter === 'object' &&
        'name' in parameter &&
        parameter.name === WORKSPACE_HEADER &&
        'in' in parameter &&
        parameter.in === 'header',
    ) === true
  );
}

/** Ключи операций, у которых объявлен заголовок рабочего пространства. */
function keysWithWorkspaceHeader(spec: OpenAPI.Document): string[] {
  return operationsOf(spec)
    .filter(({ operation }) => declaresWorkspaceHeader(operation))
    .map(({ key }) => key)
    .toSorted();
}

const specFixture = (): OpenAPI.Document => ({
  openapi: '3.1.1',
  info: { title: 'Fixture', version: '0.0.0' },
  paths: {
    '/tasks': {
      get: { responses: { '200': { description: 'OK' } } },
      post: { responses: { '200': { description: 'OK' } } },
    },
    '/tasks/{id}': {
      delete: {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/ping': { get: { responses: { '200': { description: 'OK' } } } },
  },
});

describe('documentWorkspaceHeader', () => {
  it('documents the header on exactly the scoped operations, verbatim from the source', () => {
    const spec = documentWorkspaceHeader(
      specFixture(),
      new Set(['GET /tasks', 'DELETE /tasks/{id}']),
    );

    expect(keysWithWorkspaceHeader(spec)).toEqual(['DELETE /tasks/{id}', 'GET /tasks']);
    // У читателей заголовок дословно из источника (у DELETE — после параметра
    // контракта), у остальных операций параметров не появилось.
    const parameters = Object.fromEntries(
      operationsOf(spec).map(({ key, operation }) => [key, operation.parameters]),
    );

    expect(parameters).toEqual({
      'GET /tasks': [WORKSPACE_HEADER_PARAMETER],
      'POST /tasks': undefined,
      'DELETE /tasks/{id}': [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        WORKSPACE_HEADER_PARAMETER,
      ],
      'GET /ping': undefined,
    });
  });

  it('leaves a header the contract already declares alone', () => {
    const declared: OpenAPI.ParameterObject = {
      name: WORKSPACE_HEADER,
      in: 'header',
      required: true,
      description: 'declared by the contract input schema',
      schema: { type: 'string' },
    };

    const spec = documentWorkspaceHeader(
      { ...specFixture(), paths: { '/tasks': { get: { parameters: [declared], responses: {} } } } },
      new Set(['GET /tasks']),
    );

    expect(spec.paths?.['/tasks']?.get?.parameters).toEqual([declared]);
  });

  it('is idempotent: a second pass documents nothing twice', () => {
    const scoped = new Set(['GET /tasks', 'POST /tasks']);
    const once = documentWorkspaceHeader(specFixture(), scoped);
    const snapshot = structuredClone(once);

    documentWorkspaceHeader(once, scoped);

    expect(once).toEqual(snapshot);
  });

  it('refuses a scoped operation the spec does not have', () => {
    expect(() =>
      documentWorkspaceHeader(specFixture(), new Set(['GET /tasks', 'DELETE /gone'])),
    ).toThrow(/left undocumented: DELETE \/gone/);
  });

  it('leaves a spec without paths, or a path without operations, untouched', () => {
    // Без paths: webhooks делают документ валидным сам по себе.
    const empty: OpenAPI.Document = {
      openapi: '3.1.1',
      info: { title: 'F', version: '0' },
      webhooks: {},
    };

    expect(documentWorkspaceHeader(empty, new Set())).toEqual(empty);
    expect(documentWorkspaceHeader({ ...empty, paths: { '/tasks': {} } }, new Set()).paths).toEqual(
      { '/tasks': {} },
    );
  });
});
