import { ORPCError } from '@orpc/client';
import { ERROR_MESSAGES, TaskIdInputSchema } from '@repo/contracts';
import { createProcedureClient } from '@orpc/server';
import { describe, expect, it } from 'vitest';

import {
  accessPolicyFromMeta,
  collectProcedures,
  proceduresWithoutAuthorization,
  type AppContext,
} from './authorization.ts';
import { router } from './router.ts';
import { InMemoryTaskRepository } from './tasks/repository.ts';

const OWNER_ID = 'owner-1';
const UNKNOWN_ID = '00000000-0000-4000-8000-999999999999';

/** Ответ процедуры клиенту: ошибка — её код, статус и текст; успех — значение. */
async function answerOf(call: Promise<unknown>): Promise<unknown> {
  const result = await call.catch((caught: unknown) => caught);
  if (result instanceof ORPCError) {
    return { code: result.code, status: result.status, message: result.message };
  }
  return { resolved: result };
}

/**
 * Задача владельца в `ws-a`, remove вызывается из рабочего пространства
 * `workspaceId`. Контекст собран как в app.ts: владелец читается по id из input
 * (порт ownerOfThroughRepository), актор — владелец задачи.
 */
async function setupOwnedTask(workspaceId: string) {
  const tasks = new InMemoryTaskRepository();
  const owned = await tasks.create('Delete me', OWNER_ID, 'ws-a');
  const ownerOf: AppContext['ownerOf'] = async (input) => {
    const parsed = TaskIdInputSchema.safeParse(input);
    return parsed.success ? tasks.ownerOf(parsed.data.id) : null;
  };
  const remove = createProcedureClient(router.tasks.remove, {
    context: { tasks, actor: { id: OWNER_ID }, ownerOf, workspaceId } satisfies AppContext,
  });

  return { tasks, owned, remove: (id: string) => remove({ id }) };
}

describe('router divergence from contract', () => {
  it('every procedure declares a valid access policy', () => {
    const diverged: string[] = [];

    for (const { path, procedure } of collectProcedures(router)) {
      if (!accessPolicyFromMeta(procedure['~orpc'].meta)) {
        diverged.push(`${path.join('.')}: ${JSON.stringify(procedure['~orpc'].meta)}`);
      }
    }

    expect(diverged, `procedures without a valid policy:\n${diverged.join('\n')}`).toEqual([]);
  });

  it('every procedure runs the authorization middleware — no bypass', () => {
    expect(proceduresWithoutAuthorization(router)).toEqual([]);
  });

  // e52: проверка владельца сквозная между рабочими пространствами (ADR 0020),
  // поэтому до домена доходит и запрос владельца из чужого scope. Домен такую
  // задачу не удаляет (undefined) — роутер отвечает отказом, а не успехом:
  // NOT_FOUND для remove контрактом не заявлен, отказ тот же FORBIDDEN.
  describe('tasks.remove outside the workspace scope', () => {
    // Контроль: та же задача из своего рабочего пространства удаляется —
    // отказ ниже происходит из-за scope запроса, а не из-за самой задачи.
    it('deletes the task when the owner acts from its own workspace', async () => {
      const { tasks, owned, remove } = await setupOwnedTask('ws-a');

      await expect(remove(owned.id)).resolves.toBeUndefined();

      expect(await tasks.list('ws-a')).toEqual([]);
    });

    it('denies the owner acting from another workspace and keeps the task', async () => {
      const { tasks, owned, remove } = await setupOwnedTask('ws-b');

      const result = await remove(owned.id).catch((caught: unknown) => caught);

      expect(result).toMatchObject({ code: 'FORBIDDEN', message: ERROR_MESSAGES.FORBIDDEN });
      expect(await tasks.list('ws-a')).toEqual([owned]);
    });

    it('answers exactly as for an unknown id: no existence oracle', async () => {
      const { owned, remove } = await setupOwnedTask('ws-b');

      const anotherWorkspace = await answerOf(remove(owned.id));
      const unknownId = await answerOf(remove(UNKNOWN_ID));

      expect(unknownId).toEqual({
        code: 'FORBIDDEN',
        status: 403,
        message: ERROR_MESSAGES.FORBIDDEN,
      });
      expect(anotherWorkspace).toEqual(unknownId);
    });
  });

  // e57: у public-процедур 403 не возникает — проверять владельца некому,
  // мидлварь их пропускает. FORBIDDEN в роутере объявлен ровно у remove.
  describe('public procedures never answer FORBIDDEN', () => {
    it('declares FORBIDDEN exactly on the procedures that check access', () => {
      const mismatched: string[] = [];

      for (const { path, procedure } of collectProcedures(router)) {
        const checksAccess = accessPolicyFromMeta(procedure['~orpc'].meta)?.type !== 'public';
        const declaresForbidden = procedure['~orpc'].errorMap?.['FORBIDDEN'] !== undefined;
        if (checksAccess !== declaresForbidden) {
          mismatched.push(
            `${path.join('.')}: ${checksAccess ? 'checks access, FORBIDDEN not declared' : 'public procedure declares FORBIDDEN'}`,
          );
        }
      }

      expect(
        mismatched,
        'FORBIDDEN must be declared exactly by procedures that check access',
      ).toEqual([]);
    });

    it('serves an anonymous actor on list, create and toggle', async () => {
      const context: AppContext = {
        tasks: new InMemoryTaskRepository(),
        actor: null,
        ownerOf: async () => null,
        workspaceId: null,
      };
      const list = createProcedureClient(router.tasks.list, { context });
      const create = createProcedureClient(router.tasks.create, { context });
      const toggle = createProcedureClient(router.tasks.toggle, { context });

      await expect(list(undefined)).resolves.toEqual([]);
      const created = await create({ title: 'Anonymous task' });
      await expect(toggle({ id: created.id })).resolves.toMatchObject({
        id: created.id,
        completed: true,
      });
    });
  });
});
