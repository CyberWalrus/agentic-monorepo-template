import { ORPCError } from '@orpc/client';
import { createProcedureClient, implement } from '@orpc/server';
import { ocAccess } from '@repo/contracts';
import * as z from 'zod';
import { describe, expect, it } from 'vitest';

import { authorizationMiddleware, type AppContext } from './authorization.ts';
import { InMemoryTaskRepository } from './tasks/repository.ts';

const OWNER_ACTOR = { id: 'owner-1' };
const FOREIGN_ACTOR = { id: 'other-2' };

/**
 * Фикстурный контракт для поведенческого теста мидлвари: каждая политика
 * из ADR 0011 плюс процедура без `.meta()`. Собирается той же цепочкой
 * `implement().use(authorizationMiddleware)`, что и реальный роутер.
 */
function setup(context: Pick<AppContext, 'actor' | 'ownerOf'>) {
  let domainCalls = 0;

  const fixtureContract = {
    publicEcho: ocAccess
      .route({ method: 'GET', path: '/fixture/public', summary: 'Public echo' })
      .meta({ access: { type: 'public' } })
      .output(z.string()),
    ownerEcho: ocAccess
      .route({ method: 'GET', path: '/fixture/owner', summary: 'Owner echo' })
      .meta({ access: { type: 'owner' } })
      .output(z.string()),
    adminEcho: ocAccess
      .route({ method: 'GET', path: '/fixture/admin', summary: 'Admin echo' })
      .meta({ access: { type: 'admin' } })
      .output(z.string()),
    noPolicyEcho: ocAccess
      .route({ method: 'GET', path: '/fixture/no-policy', summary: 'Echo without a policy' })
      .output(z.string()),
  };

  const os = implement(fixtureContract).$context<AppContext>().use(authorizationMiddleware);

  const domain = () => {
    domainCalls += 1;
    return 'domain-ok';
  };

  const router = os.router({
    publicEcho: os.publicEcho.handler(domain),
    ownerEcho: os.ownerEcho.handler(domain),
    adminEcho: os.adminEcho.handler(domain),
    noPolicyEcho: os.noPolicyEcho.handler(domain),
  });

  const fullContext: AppContext = { tasks: new InMemoryTaskRepository(), ...context };
  const clientOf = (proc: keyof typeof router) =>
    createProcedureClient(router[proc], { context: fullContext });

  const denyErrorOf = async (proc: keyof typeof router) => {
    const error = await clientOf(proc)(undefined).catch((caught: unknown) => caught);
    // Отказ до входа в доменную логику: обработчик процедуры не вызван.
    expect(domainCalls).toBe(0);
    return error;
  };

  return { clientOf, denyErrorOf, domainCalls: () => domainCalls };
}

describe('authorization middleware', () => {
  it('lets a public procedure run without an actor', async () => {
    const { clientOf, domainCalls } = setup({ actor: null, ownerOf: async () => null });

    await expect(clientOf('publicEcho')(undefined)).resolves.toBe('domain-ok');
    expect(domainCalls()).toBe(1);
  });

  it('denies an owner procedure without an actor before the domain logic', async () => {
    const { denyErrorOf } = setup({ actor: null, ownerOf: async () => OWNER_ACTOR.id });

    await expect(denyErrorOf('ownerEcho')).resolves.toBeInstanceOf(ORPCError);
    await expect(denyErrorOf('ownerEcho')).resolves.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Access denied',
    });
  });

  it('denies an owner procedure for a foreign actor before the domain logic', async () => {
    const { denyErrorOf } = setup({ actor: FOREIGN_ACTOR, ownerOf: async () => OWNER_ACTOR.id });

    await expect(denyErrorOf('ownerEcho')).resolves.toBeInstanceOf(ORPCError);
    await expect(denyErrorOf('ownerEcho')).resolves.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Access denied',
    });
  });

  it('denies an owner procedure when the resource has no owner', async () => {
    const { denyErrorOf } = setup({ actor: OWNER_ACTOR, ownerOf: async () => null });

    await expect(denyErrorOf('ownerEcho')).resolves.toBeInstanceOf(ORPCError);
    await expect(denyErrorOf('ownerEcho')).resolves.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Access denied',
    });
  });

  it('lets an owner procedure run for the resource owner', async () => {
    const { clientOf, domainCalls } = setup({
      actor: OWNER_ACTOR,
      ownerOf: async () => OWNER_ACTOR.id,
    });

    await expect(clientOf('ownerEcho')(undefined)).resolves.toBe('domain-ok');
    expect(domainCalls()).toBe(1);
  });

  it('denies an admin procedure even for an actor: roles do not exist yet', async () => {
    const { denyErrorOf } = setup({ actor: OWNER_ACTOR, ownerOf: async () => OWNER_ACTOR.id });

    await expect(denyErrorOf('adminEcho')).resolves.toBeInstanceOf(ORPCError);
    await expect(denyErrorOf('adminEcho')).resolves.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Access denied',
    });
  });

  it('denies a procedure without an access policy: contract and router must not diverge', async () => {
    const { denyErrorOf } = setup({ actor: OWNER_ACTOR, ownerOf: async () => OWNER_ACTOR.id });

    await expect(denyErrorOf('noPolicyEcho')).resolves.toBeInstanceOf(ORPCError);
    await expect(denyErrorOf('noPolicyEcho')).resolves.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Access denied',
    });
  });
});
