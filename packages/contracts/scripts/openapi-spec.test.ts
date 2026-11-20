import type { OpenAPI } from '@orpc/contract';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import { contract } from '../src/index.ts';
import { documentValidationErrors, generateSpec, voidSchemaConverter } from './openapi-spec.ts';

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

const fixture = (): OpenAPI.Document => ({
  openapi: '3.1.1',
  info: { title: 'Fixture', version: '0.0.0' },
  paths: {
    '/tasks': {
      post: { responses: { '200': { description: 'OK' }, '403': { description: '403' } } },
    },
    '/tasks/{id}/toggle': {
      post: { responses: { '200': { description: 'OK' }, '404': { description: '404' } } },
    },
    '/tasks/{id}': {
      delete: { responses: { '200': { description: 'OK' } } },
    },
  },
});

describe('documentValidationErrors', () => {
  it('documents 400 for operations with reachable input validation', () => {
    const spec = documentValidationErrors(fixture());

    const create = spec.paths?.['/tasks']?.post?.responses?.['400'];
    const toggle = spec.paths?.['/tasks/{id}/toggle']?.post?.responses?.['400'];

    // Форма рантайма: неопределённая ошибка BAD_REQUEST с zod-issues в data
    expect(create).toMatchObject({
      description: '400',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['defined', 'code', 'status', 'message', 'data'],
            properties: {
              defined: { const: false },
              code: { const: 'BAD_REQUEST' },
              status: { const: 400 },
            },
          },
        },
      },
    });
    expect(toggle).toEqual(create);
  });

  it('does not document 400 where validation is unreachable', () => {
    const spec = documentValidationErrors(fixture());

    // DELETE: owner-проверка отвечает FORBIDDEN до валидации (fail-closed)
    expect(spec.paths?.['/tasks/{id}']?.delete?.responses?.['400']).toBeUndefined();
    expect(Object.keys(spec.paths?.['/tasks/{id}']?.delete?.responses ?? {})).toEqual(['200']);
  });

  it('keeps an explicitly declared 400', () => {
    const spec = fixture();
    const create = spec.paths?.['/tasks']?.post;
    if (create) {
      create.responses = { ...create.responses, '400': { description: 'declared by contract' } };
    }

    documentValidationErrors(spec);

    expect(spec.paths?.['/tasks']?.post?.responses?.['400']).toEqual({
      description: 'declared by contract',
    });
  });

  it('drops empty content that claims a body where runtime sends none', () => {
    const spec = fixture();
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

    documentValidationErrors(spec);

    expect(spec.paths?.['/tasks']?.post?.responses?.['200']).toEqual({ description: 'OK' });
    expect(spec.paths?.['/tasks/{id}']?.delete?.responses?.['200']).toHaveProperty('content');
  });

  it('is idempotent', () => {
    const once = documentValidationErrors(fixture());
    const twice = documentValidationErrors(once);

    expect(twice).toEqual(once);
  });
});

describe('generateSpec on the real contract', () => {
  it('renders DELETE 200 as a bodyless response instead of an always-false schema', async () => {
    const spec = await generateSpec(contract);

    expect(spec.paths?.['/tasks/{id}']?.delete?.responses?.['200']).toEqual({ description: 'OK' });
  });

  it('documents the runtime 400 for task creation and toggling', async () => {
    const spec = await generateSpec(contract);

    expect(spec.paths?.['/tasks']?.post?.responses?.['400']).toBeDefined();
    expect(spec.paths?.['/tasks/{id}/toggle']?.post?.responses?.['400']).toBeDefined();
    // GET без входа и DELETE с owner-проверкой до валидации 400 не отдают
    expect(spec.paths?.['/tasks']?.get?.responses?.['400']).toBeUndefined();
    expect(spec.paths?.['/tasks/{id}']?.delete?.responses?.['400']).toBeUndefined();
  });

  it('keeps generation deterministic across runs', async () => {
    const first = await generateSpec(contract);
    const second = await generateSpec(contract);

    expect(second).toEqual(first);
  });
});
