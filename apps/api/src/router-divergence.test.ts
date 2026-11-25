import { ORPCError } from '@orpc/client';
import type { OpenAPI } from '@orpc/contract';
import { OpenAPIGenerator } from '@orpc/openapi';
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4';
import { createProcedureClient } from '@orpc/server';
import {
  contract,
  documentErrorResponses,
  ERROR_MESSAGES,
  errorResponses,
  hasValidatedInput,
  operationsWithInputValidation,
  TaskIdInputSchema,
  voidSchemaConverter,
} from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import {
  accessPolicyFromMeta,
  collectProcedures,
  proceduresWithoutAuthorization,
  type AppContext,
} from './authorization.ts';
// e56: признак «вход валидируется» — тот же, по которому спека решает, каким
// операциям обещать 400 валидации; конвертер void-вывода и ответы HTTP-слоя
// спеки — для сверки с проводом. Всё это — публичный экспорт `@repo/contracts`
// (packages/contracts/src/openapi-spec.ts): скрипты пакета публичным импортом
// недоступны, а относительный путь к соседнему пакету не существует в
// песочнице мутаций API (копируется только apps/api).
import { createApp } from './app.ts';
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

  // e56: спека обещает 400 валидации ровно public-процедурам с валидируемым
  // входом (operationsWithInputValidation в openapi-spec.ts). Здесь его
  // рантайм-доказательство на настоящем роутере: актор — владелец, поэтому
  // отказ может дать только форма входа. Public → валидация отвечает первой;
  // политика с проверкой доступа → FORBIDDEN до неё (fail-closed, C2.3).
  // Доказывается только порядок «проверка доступа → валидация»: клиент
  // процедур минует HTTP-слой и его ответов не видит — они проверены на
  // проводе ниже («spec on the wire»).
  it('answers an invalid input with BAD_REQUEST only on public procedures', async () => {
    const tasks = new InMemoryTaskRepository();
    await tasks.create('Owned', OWNER_ID, 'ws-a');
    const context: AppContext = {
      tasks,
      actor: { id: OWNER_ID },
      ownerOf: async (input) => {
        const parsed = TaskIdInputSchema.safeParse(input);
        return parsed.success ? tasks.ownerOf(parsed.data.id) : null;
      },
      workspaceId: 'ws-a',
    };

    // list без валидируемого входа не проверяется; ответ остальных предсказан
    const checked = await Promise.all(
      [...collectProcedures(router)]
        .filter(({ procedure }) => hasValidatedInput(procedure))
        .map(async ({ path, procedure }) => {
          const call = createProcedureClient(procedure, { context });
          return [path.join('.'), await answerOf(call(undefined))] as const;
        }),
    );
    const answered = Object.fromEntries(checked);

    // Ответ валидации — код, статус и текст фикстуры провода (тот же источник,
    // из которого строится спека), а не списанный руками
    const validationFailed = errorResponses.validationFailed.body;
    const invalidInput = {
      code: validationFailed.code,
      status: validationFailed.status,
      message: validationFailed.message,
    };
    const forbidden = { code: 'FORBIDDEN', status: 403, message: ERROR_MESSAGES.FORBIDDEN };

    // Ожидание выводится из политики каждой проверенной процедуры — тот же
    // признак, что в operationsWithInputValidation, — а не перечисляется по
    // именам: `pnpm gen feature` добавляет домен в роутер, этот файл не трогая.
    const expected = Object.fromEntries(
      [...collectProcedures(router)]
        .filter(({ procedure }) => hasValidatedInput(procedure))
        .map(
          ({ path, procedure }) =>
            [
              path.join('.'),
              accessPolicyFromMeta(procedure['~orpc'].meta)?.type === 'public'
                ? invalidInput
                : forbidden,
            ] as const,
        ),
    );

    // Перечень не пуст: иначе порядок доказывался бы впустую
    expect(Object.keys(expected), 'no procedure validates its input').not.toEqual([]);
    expect(answered).toEqual(expected);
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

// e56 (ревью): ответы HTTP-слоя не зависят от того, что объявляет операция:
// ограждения стоят на всём `/api/*`, а JSON разбирает транспорт до мидлвари
// авторизации. Правило спеки (documentErrorResponses в openapi-spec.ts)
// проверяется на проводе настоящего createApp — для каждой операции контракта.
describe('spec on the wire', () => {
  const HTTP_METHODS = [
    'get',
    'put',
    'post',
    'delete',
    'options',
    'head',
    'patch',
    'trace',
  ] as const;
  const JSON_HEADERS = { 'content-type': 'application/json' };
  /** Тела запроса; массив, null и пустой объект не проходит ни одна схема входа роутера. */
  const SENT = {
    malformed: '{"title": ',
    overTheLimit: JSON.stringify({ title: 'x'.repeat(2048) }),
    array: '[]',
    null: 'null',
    object: '{}',
  } as const;
  type Sent = Record<keyof typeof SENT, number>;

  /**
   * Операции спеки настоящего контракта. В path подставлен id несуществующей
   * задачи: процедуры ничего не меняют, а 404 и 403 — их собственные ответы.
   *
   * Спека собирается теми же конвертерами генератора и тем же правилом
   * ответов HTTP-слоя, что и `generateSpec` контрактов
   * (packages/contracts/scripts/openapi-spec.ts). Композиция повторена здесь,
   * а не импортирована: generateSpec — скрипт пакета, а вынести его в
   * публичный экспорт контрактов нельзя без `@orpc/openapi` и `@orpc/zod`
   * в корневом entry (его импортирует web).
   */
  async function operationsOfSpec() {
    const spec: OpenAPI.Document = documentErrorResponses(
      await new OpenAPIGenerator({
        schemaConverters: [voidSchemaConverter, new ZodToJsonSchemaConverter()],
      }).generate(contract),
      operationsWithInputValidation(contract),
    );
    return Object.entries(spec.paths ?? {}).flatMap(([path, pathItem]) =>
      HTTP_METHODS.flatMap((method) => {
        const operation = pathItem?.[method];
        return operation === undefined
          ? []
          : [
              {
                key: `${method.toUpperCase()} ${path}`,
                method,
                url: `/api${path.replaceAll('{id}', UNKNOWN_ID)}`,
                documented: Object.keys(operation.responses ?? {}),
              },
            ];
      }),
    );
  }

  /** Ответы операции на проводе: `sent` — по каждому телу SENT, `noBody` — на запрос без тела. */
  interface WireAnswers {
    sent: Sent;
    noBody: number;
  }

  /**
   * Ответы на проводе — для операций, которым адаптер передаёт тело. Запрос без
   * тела — контроль: ответ самой операции на отсутствие входа.
   */
  async function answers(): Promise<Record<string, WireAnswers>> {
    const app = createApp({ tasks: new InMemoryTaskRepository(), bodyLimitBytes: 1024 });
    const rows = await Promise.all(
      (await operationsOfSpec())
        // GET и HEAD с телом собирает только настоящий адаптер — app.test.ts, «on a real HTTP server»
        .filter(({ method }) => method !== 'get' && method !== 'head')
        .map(async ({ key, method, url }) => {
          const statusOf = async (body?: string) =>
            (
              await app.request(url, {
                method: method.toUpperCase(),
                headers: JSON_HEADERS,
                ...(body === undefined ? {} : { body }),
              })
            ).status;
          return [
            key,
            {
              sent: {
                malformed: await statusOf(SENT.malformed),
                overTheLimit: await statusOf(SENT.overTheLimit),
                array: await statusOf(SENT.array),
                null: await statusOf(SENT.null),
                object: await statusOf(SENT.object),
              },
              noBody: await statusOf(),
            },
          ] as const;
        }),
    );
    return Object.fromEntries(rows);
  }

  // Ограждения отвечают по форме байтов, а не по операции: битое тело — 400,
  // тело сверх потолка — 413 на каждой операции, которой адаптер передаёт
  // тело, — и на тех, что тела в спеке не объявляют (toggle, remove).
  // Корректное тело в пределах потолка ограждение не отбивает — отвечает сама
  // операция: с проверкой доступа — FORBIDDEN (проверка доступа раньше
  // валидации и раньше домена); public — как на запрос без тела: массив, null
  // и пустой объект входа не несут. Ожидание строится из роутера для каждой
  // операции спеки, без перечня по именам: `pnpm gen feature` добавляет домен
  // в роутер, этот файл не трогая.
  it('answers a body sent to an operation that declares none with the guard responses', async () => {
    // Ключи «METHOD /path» операций с проверкой доступа: политика не public —
    // та же политика, по которой спека решает, каким обещать 400 валидации
    const accessChecked = new Set(
      [...collectProcedures(router)]
        .filter(({ procedure }) => accessPolicyFromMeta(procedure['~orpc'].meta)?.type !== 'public')
        .map(({ procedure }) => {
          const route = procedure['~orpc'].route;
          return `${route?.method?.toUpperCase()} ${route?.path}`;
        }),
    );
    const rows = await answers();

    const guard = { malformed: 400, overTheLimit: 413 };
    const expected = Object.fromEntries(
      Object.entries(rows).map(([key, { noBody }]) => {
        const own = accessChecked.has(key) ? 403 : noBody;
        return [key, { ...guard, array: own, null: own, object: own }] as const;
      }),
    );

    // Перечень не пуст: иначе инвариант доказывался бы впустую
    expect(Object.keys(rows), 'no operation receives a body on the wire').not.toEqual([]);
    expect(
      Object.fromEntries(Object.entries(rows).map(([key, { sent }]) => [key, sent] as const)),
    ).toEqual(expected);
  });

  // Красный, когда операция отвечает статусом, которого спека не описывает, —
  // в том числе когда добавили процедуру с валидируемым входом, а 400 у неё нет.
  it('documents every status the wire answers to those bodies', async () => {
    const documented = new Map(
      (await operationsOfSpec()).map(({ key, documented: codes }) => [key, codes] as const),
    );
    const undocumented = Object.entries(await answers()).flatMap(([key, { sent }]) =>
      Object.entries(sent)
        .filter(([, status]) => !documented.get(key)?.includes(String(status)))
        .map(([name, status]) => `${key}: ${name} → ${status}`),
    );

    expect(undocumented).toEqual([]);
  });
});
