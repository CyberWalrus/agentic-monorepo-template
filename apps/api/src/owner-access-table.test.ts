import { ORPCError, createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import type { Contract } from '@repo/contracts';
import { TaskIdInputSchema } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import type { Actor } from './authorization.ts';
import { accessPolicyFromMeta, collectProcedures } from './authorization.ts';
import { createApp } from './app.ts';
import { router } from './router.ts';
import { InMemoryTaskRepository, type TaskRepository } from './tasks/repository.ts';

const OWNER_ID = 'task-owner';
const FOREIGN_ID = 'foreign-user';

const actorFromHeader = (request: Request): Actor | null => {
  const id = request.headers.get('x-actor-id');
  return id === null ? null : { id };
};

const inputId = (input: unknown): string => {
  const parsed = TaskIdInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`scenario input is not a task id input: ${JSON.stringify(input)}`);
  }
  return parsed.data.id;
};

/**
 * Строка таблицы «процедура × случай» (C2.3): как создать ресурс от имени
 * владельца и чем отказ/успех отличаются кроме кода ошибки. Отказ проверяется
 * глубже кода FORBIDDEN — ресурс не тронут (домен не исполнялся); успех —
 * эффектом домена. Новая owner-процедура без строки красит набор.
 */
interface AccessScenario {
  arrange: (tasks: TaskRepository, ownerId: string) => Promise<unknown>;
  assertUntouched: (tasks: TaskRepository, input: unknown) => Promise<void>;
  assertSuccess: (tasks: TaskRepository, input: unknown) => Promise<void>;
}

const accessScenarios: Record<string, AccessScenario> = {
  'tasks.remove': {
    arrange: async (tasks, ownerId) => {
      const created = await tasks.create('Owned row for the access table', ownerId);
      return { id: created.id };
    },
    assertUntouched: async (tasks, input) => {
      const listed = await tasks.list();
      expect(listed.map((task) => task.id)).toContain(inputId(input));
    },
    assertSuccess: async (tasks, input) => {
      const listed = await tasks.list();
      expect(listed.map((task) => task.id)).not.toContain(inputId(input));
    },
  },
};

/** Owner-процедуры реального роутера: перебор, как в router-divergence.test. */
function ownerProcedurePaths(): string[] {
  const paths: string[] = [];
  for (const { path, procedure } of collectProcedures(router)) {
    const policy = accessPolicyFromMeta(procedure['~orpc'].meta);
    if (policy?.type === 'owner') {
      paths.push(path.join('.'));
    }
  }
  return paths;
}

const ownerProcedures = ownerProcedurePaths();

interface AccessTableCell {
  name: string;
  path: string;
  actorId: string;
}

function generateTableCells(outcome: 'denied' | 'allowed'): AccessTableCell[] {
  const cells: AccessTableCell[] = [];
  for (const path of ownerProcedures) {
    cells.push(
      outcome === 'denied'
        ? { name: `${path}: foreign resource is denied`, path, actorId: FOREIGN_ID }
        : { name: `${path}: own resource succeeds`, path, actorId: OWNER_ID },
    );
  }
  return cells;
}

const deniedCells = generateTableCells('denied');
const allowedCells = generateTableCells('allowed');

interface TableCase {
  tasks: InMemoryTaskRepository;
  clientFor: (actorId: string | undefined) => ContractRouterClient<Contract>;
}

function setupTableCase(): TableCase {
  const tasks = new InMemoryTaskRepository();
  const app = createApp({ tasks, resolveActor: actorFromHeader });
  const clientFor = (actorId: string | undefined): ContractRouterClient<Contract> =>
    createORPCClient(
      new RPCLink({
        url: 'http://api.test/rpc',
        headers: actorId === undefined ? {} : { 'x-actor-id': actorId },
        fetch: async (request) => app.fetch(request),
      }),
    );
  return { tasks, clientFor };
}

type ProcedureClient = (input: unknown) => Promise<unknown>;

const isProcedureClient = (value: unknown): value is ProcedureClient => typeof value === 'function';

const isReflectable = (value: unknown): value is object =>
  value !== null && (typeof value === 'object' || typeof value === 'function');

function resolveProcedure(client: ContractRouterClient<Contract>, path: string): ProcedureClient {
  let node: unknown = client;
  for (const key of path.split('.')) {
    // Reflect.get, а не in/Object.entries: клиент oRPC — Proxy, свойства
    // выдаются get-ловушкой и неперечислимы; вложенный клиент — гибрид
    // «функция + proxy», поэтому отражаемость, а не только object
    if (!isReflectable(node)) {
      throw new Error(`procedure ${path} not found on the typed client`);
    }
    const next: unknown = Reflect.get(node, key);
    if (next === undefined) {
      throw new Error(`procedure ${path} not found on the typed client`);
    }
    node = next;
  }
  if (!isProcedureClient(node)) {
    throw new Error(`procedure ${path} is not callable on the typed client`);
  }
  return node;
}

function scenarioOf(path: string): AccessScenario {
  const scenario = accessScenarios[path];
  if (scenario === undefined) {
    throw new Error(`access scenario row for ${path} is missing`);
  }
  return scenario;
}

describe('owner access table (generated from the router)', () => {
  it('the router exposes at least one owner procedure: the table is not vacuous', () => {
    expect(ownerProcedures.length).toBeGreaterThan(0);
  });

  it('every owner procedure has a scenario row — no empty rows', () => {
    const empty = ownerProcedures.filter((path) => accessScenarios[path] === undefined);
    expect(empty, `add an access scenario for:\n${empty.join('\n')}`).toEqual([]);
  });

  it('every scenario row targets an owner procedure — no stale rows', () => {
    const stale = Object.keys(accessScenarios).filter((path) => !ownerProcedures.includes(path));
    expect(stale, `stale scenario rows for non-owner procedures:\n${stale.join('\n')}`).toEqual([]);
  });

  it('every owner procedure yields both cases: foreign denied, own allowed', () => {
    const expected = ownerProcedures
      .flatMap((path) => [`${path}: foreign resource is denied`, `${path}: own resource succeeds`])
      .toSorted();
    const actual = [...deniedCells, ...allowedCells].map((cell) => cell.name).toSorted();

    expect(actual).toEqual(expected);
  });

  it.each(deniedCells)('$name', async ({ path, actorId }) => {
    const { tasks, clientFor } = setupTableCase();
    const scenario = scenarioOf(path);

    // Arrange: ресурс принадлежит владельцу; зовёт его чужой актёр.
    const input = await scenario.arrange(tasks, OWNER_ID);
    const procedure = resolveProcedure(clientFor(actorId), path);

    const result = await procedure(input).catch((caught: unknown) => caught);

    expect(result).toBeInstanceOf(ORPCError);
    expect(result).toMatchObject({ code: 'FORBIDDEN', message: 'Access denied' });
    await scenario.assertUntouched(tasks, input);
  });

  it.each(allowedCells)('$name', async ({ path, actorId }) => {
    const { tasks, clientFor } = setupTableCase();
    const scenario = scenarioOf(path);

    // Arrange: тот же ресурс, зовёт владелец.
    const input = await scenario.arrange(tasks, OWNER_ID);
    const procedure = resolveProcedure(clientFor(actorId), path);

    const result = await procedure(input).catch((caught: unknown) => caught);

    expect(result).not.toBeInstanceOf(ORPCError);
    await scenario.assertSuccess(tasks, input);
  });
});
