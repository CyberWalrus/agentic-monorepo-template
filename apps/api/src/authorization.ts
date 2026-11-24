import { isProcedure, ORPCError, type AnyProcedure, type MiddlewareResult } from '@orpc/server';
import { AccessPolicySchema, ERROR_MESSAGES } from '@repo/contracts';
import * as z from 'zod';

import type { TaskRepository } from './tasks/repository.ts';

export interface Actor {
  id: string;
}

/**
 * Контекст приложения. Аутентификации в шаблоне ещё нет: actor приходит
 * из resolveActor в app.ts (по умолчанию null), ownerOf — порт «владелец
 * ресурса процедуры». Оба читает только мидлварь авторизации.
 */
export interface AppContext {
  tasks: TaskRepository;
  actor: Actor | null;
  /**
   * Владелец ресурса, к которому обращается процедура, или null — ресурс
   * не найден или владелец неизвестен. Fail-closed: null означает отказ
   * для политики «owner», чтобы отсутствие владельца не давало оракула.
   * Незнакомую форму input порт обязан отвечать null.
   */
  ownerOf: (input: unknown) => Promise<string | null>;
  /**
   * Рабочее пространство запроса (ADR 0020) или null — «ничей»: заголовок
   * `x-workspace-id` отсутствует или не разобрался. Скоупит списки и мутации
   * задач изоляцией E2E-сценариев; в контракте процедур его нет.
   */
  workspaceId: string | null;
}

/**
 * Обёртка meta процедуры, читает мидлварь. Сама политика строгая
 * (AccessPolicySchema), лишние ключи meta за пределами access не проверяет.
 */
const MetaSchema = z.object({ access: AccessPolicySchema.optional() });

/**
 * Политика процедуры из её meta контракта или undefined — meta без политики
 * или с битой политикой (решение в обоих случаях — отказ).
 */
export function accessPolicyFromMeta(meta: unknown) {
  const parsed = MetaSchema.safeParse(meta);
  return parsed.success ? parsed.data.access : undefined;
}

/**
 * Все процедуры роутера: рекурсивный обход вложенных роутеров с путями
 * (перебор реального роутера и guard в createApp идут одной обходилкой).
 */
export function* collectProcedures(
  node: unknown,
  path: readonly string[] = [],
): Generator<{ path: readonly string[]; procedure: AnyProcedure }> {
  if (isProcedure(node)) {
    yield { path, procedure: node };
    return;
  }
  if (node === null || typeof node !== 'object') {
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    yield* collectProcedures(value, [...path, key]);
  }
}

/**
 * Процедуры роутера без authorizationMiddleware в цепочке: у такой процедуры
 * авторизация не исполняется вовсе. createApp отказывается поднимать такой
 * роутер, тест перебора — красит ветку.
 */
export function proceduresWithoutAuthorization(router: unknown): readonly string[] {
  const bypassed: string[] = [];
  for (const { path, procedure } of collectProcedures(router)) {
    if (!procedure['~orpc'].middlewares.includes(authorizationMiddleware)) {
      bypassed.push(path.join('.'));
    }
  }
  return bypassed;
}

/**
 * Структурные части опций мидлвари oRPC, которые использует авторизация.
 * Остальные опции (path, signal, errors, …) мидлварь не трогает, поэтому
 * не объявляет.
 */
interface AuthorizationOptions {
  context: AppContext;
  /** meta и карта ошибок процедуры: по ним мидлварь читает политику и объявлен ли FORBIDDEN. */
  procedure: { '~orpc': { meta: unknown; errorMap?: Record<string, unknown> } };
  next: (options: { context: AppContext }) => MiddlewareResult<AppContext, unknown>;
}

/**
 * Отказ доступа — своя ошибка мидлвари, а не конструктор `errors` процедуры.
 * После снятия 403 с public-процедур (e57, ADR 0024) конструктор FORBIDDEN
 * есть не у каждой процедуры, а отказать мидлварь обязана любую — в том числе
 * без политики (deny-by-default). Код, статус (403 oRPC выводит из кода) и
 * текст из каталога контракта (C4.1) — те же, что даёт объявленный
 * `errors.FORBIDDEN()`; `defined` честен: объявлен ли код процедуре.
 */
function forbid(declared: boolean): ORPCError<'FORBIDDEN', unknown> {
  return new ORPCError('FORBIDDEN', { defined: declared, message: ERROR_MESSAGES.FORBIDDEN });
}

/**
 * Единая точка исполнения политик доступа (ADR 0011): ставится на строитель
 * реализаций (`implement(contract).use(authorizationMiddleware)`), поэтому
 * её проходит каждая процедура роутера — в обход не попасть. Решение — по
 * политике процедуры из meta контракта; процедура без политики или с битой
 * политикой отвергается (deny-by-default).
 */
export async function authorizationMiddleware(
  { context, procedure, next }: AuthorizationOptions,
  input: unknown,
): Promise<Awaited<MiddlewareResult<AppContext, unknown>>> {
  const policy = accessPolicyFromMeta(procedure['~orpc'].meta);
  const forbiddenDeclared = procedure['~orpc'].errorMap?.['FORBIDDEN'] !== undefined;

  if (!policy) {
    // Расхождение «контракт объявил — роутер построил мимо контракта»:
    // отказ безопаснее пропуска, диагностику даёт router-divergence.test.
    throw forbid(forbiddenDeclared);
  }

  if (policy.type === 'public') {
    return next({ context });
  }

  if (policy.type === 'admin') {
    // Ролей в системе ещё нет, источника админ-акторов тоже: отказ до их
    // появления (условие возврата — в журнале задачи C2.2).
    throw forbid(forbiddenDeclared);
  }

  if (!context.actor) {
    throw forbid(forbiddenDeclared);
  }

  const owner = await context.ownerOf(input);
  // null (ресурса нет или владелец неизвестен) — тоже отказ: null !== id.
  if (owner !== context.actor.id) {
    throw forbid(forbiddenDeclared);
  }

  return next({ context });
}
