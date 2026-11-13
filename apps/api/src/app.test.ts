import { createORPCClient, ORPCError } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import type { Contract } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.ts';
import { InMemoryTaskRepository } from './tasks/repository.ts';

const UNKNOWN_ID = '00000000-0000-4000-8000-999999999999';

function setup({
  enableTestApi = false,
  instanceId,
}: { enableTestApi?: boolean; instanceId?: string } = {}) {
  const app = createApp({
    tasks: new InMemoryTaskRepository(),
    enableTestApi,
    // exactOptionalPropertyTypes: undefined нельзя передавать явно.
    ...(instanceId === undefined ? {} : { instanceId }),
  });
  const client: ContractRouterClient<Contract> = createORPCClient(
    new RPCLink({ url: 'http://api.test/rpc', fetch: async (request) => app.fetch(request) }),
  );
  return { app, client };
}

describe('RPC transport', () => {
  it('creates, lists and toggles tasks through the typed client', async () => {
    const { client } = setup();

    const created = await client.tasks.create({ title: '  Ship it  ' });
    const toggled = await client.tasks.toggle({ id: created.id });
    const list = await client.tasks.list();

    expect(created.title).toBe('Ship it');
    expect(toggled.completed).toBe(true);
    expect(list).toEqual([toggled]);
  });

  it('rejects an empty title with a validation error', async () => {
    const { client } = setup();

    await expect(client.tasks.create({ title: '   ' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('returns a typed NOT_FOUND error for an unknown task', async () => {
    const { client } = setup();

    const error = await client.tasks.toggle({ id: UNKNOWN_ID }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code: 'NOT_FOUND', message: 'Task not found' });
  });
});

describe('OpenAPI transport', () => {
  it('serves the same procedures as REST', async () => {
    const { app } = setup();

    const createResponse = await app.request('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'From REST' }),
    });
    const listResponse = await app.request('/api/tasks');

    expect(createResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual([await createResponse.json()]);
  });

  it('responds 404 for toggling an unknown task', async () => {
    const { app } = setup();

    const response = await app.request(`/api/tasks/${UNKNOWN_ID}/toggle`, { method: 'POST' });

    expect(response.status).toBe(404);
  });
});

describe('HTTP concerns', () => {
  it('responds 404 for unknown RPC procedures and REST routes', async () => {
    const { app } = setup();

    const rpc = await app.request('/rpc/tasks/unknown', { method: 'POST', body: '{}' });
    const rest = await app.request('/api/unknown');

    expect(rpc.status).toBe(404);
    expect(rest.status).toBe(404);
  });

  it('reports health without an instance when started outside e2e', async () => {
    const { app } = setup();

    const response = await app.request('/health');

    expect(await response.json()).toEqual({ status: 'ok', instance: null });
  });

  it('reports the instance id of the e2e run that started it', async () => {
    const { app } = setup({ instanceId: 'run-token' });

    const response = await app.request('/health');

    expect(await response.json()).toEqual({ status: 'ok', instance: 'run-token' });
  });

  it('sends no CORS headers to any origin: browsers use the same-origin proxy (ADR 0005)', async () => {
    const { app } = setup();

    const web = await app.request('/health', { headers: { origin: 'http://localhost:3000' } });
    const foreign = await app.request('/health', { headers: { origin: 'https://evil.example' } });

    expect(web.headers.get('access-control-allow-origin')).toBeNull();
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('test API', () => {
  const seeded = {
    id: '00000000-0000-4000-8000-000000000001',
    title: 'Seeded',
    completed: false,
    createdAt: '2026-11-01T10:00:00.000Z',
  };

  it('is not exposed unless explicitly enabled', async () => {
    const app = createApp({ tasks: new InMemoryTaskRepository() });

    const response = await app.request('/__test__/reset', { method: 'POST', body: '{"tasks":[]}' });

    expect(response.status).toBe(404);
  });

  it('replaces data when enabled', async () => {
    const { app, client } = setup({ enableTestApi: true });
    await client.tasks.create({ title: 'Will be removed' });

    const response = await app.request('/__test__/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tasks: [seeded] }),
    });

    expect(response.status).toBe(204);
    expect(await client.tasks.list()).toEqual([seeded]);
  });

  it('rejects malformed seed data and keeps existing tasks', async () => {
    const { app, client } = setup({ enableTestApi: true });
    const existing = await client.tasks.create({ title: 'Keep me' });

    const response = await app.request('/__test__/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tasks: [{ id: 'nope' }] }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'Invalid seed data',
      issues: expect.arrayContaining([expect.objectContaining({ path: ['tasks', 0, 'id'] })]),
    });
    expect(await client.tasks.list()).toEqual([existing]);
  });

  it.each([
    ['invalid JSON', 'not json'],
    ['a body without tasks', '{}'],
  ])('rejects %s instead of wiping data', async (_case, body) => {
    const { app, client } = setup({ enableTestApi: true });
    await client.tasks.create({ title: 'Keep me' });

    const response = await app.request('/__test__/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });

    expect(response.status).toBe(400);
    expect(await client.tasks.list()).toHaveLength(1);
  });
});
