import * as z from 'zod';

import { notFoundError } from './errors.ts';
import { ocAccess, ocPublic } from './access-policy.ts';
import { readsWorkspace } from './workspace.ts';

export const TASK_TITLE_MAX_LENGTH = 200;

/**
 * createdAt на границе — одна каноническая форма (e58): UTC с `Z`, без
 * смещения часового пояса. `z.iso.datetime()` по умолчанию смещение и
 * отбрасывает; ответы всегда пишут форму Date#toISOString() с миллисекундами —
 * к ней приведены обе реализации хранилища (apps/api/src/tasks).
 */
const CREATED_AT_DESCRIPTION =
  'Creation instant in UTC: RFC 3339 with the `Z` suffix, a UTC offset is rejected. Answers always carry the canonical form of JavaScript Date#toISOString(), milliseconds included (for example 2026-11-01T10:00:00.000Z), from every storage implementation.';

export const TaskSchema = z.object({
  id: z.uuid(),
  title: z.string().min(1).max(TASK_TITLE_MAX_LENGTH),
  completed: z.boolean(),
  createdAt: z.iso.datetime().describe(CREATED_AT_DESCRIPTION),
});

/**
 * Вход создания — строгий объект (e57): лишний ключ (опечатка в имени поля)
 * — ошибка валидации, одна и та же на клиенте и на сервере, а не молчаливо
 * отброшенное значение. «Отказывает явно» держит сама схема и не зависит от
 * отправителя.
 */
export const CreateTaskInputSchema = z.strictObject({
  title: z.string().trim().min(1, 'Title is required').max(TASK_TITLE_MAX_LENGTH),
});

export const TaskIdInputSchema = z.object({
  id: z.uuid(),
});

export type Task = z.infer<typeof TaskSchema>;
export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;

/**
 * Строитель — по политике процедуры (e57): public-процедуры на `ocPublic`
 * без FORBIDDEN (проверки доступа нет — бросать его некому), процедура с
 * проверкой владельца — на `ocAccess`, где отказ объявлен.
 *
 * Все четыре процедуры читают заголовок рабочего пространства (ADR 0020:
 * список и мутации ограничены scope запроса) и объявляют это обёрткой
 * readsWorkspace — по ней спека описывает заголовок у операции
 * (packages/contracts/src/workspace.ts, e58). Обёртка — последнее звено цепочки.
 */
export const tasksContract = {
  list: readsWorkspace(
    ocPublic
      .route({ method: 'GET', path: '/tasks', summary: 'List tasks, newest first' })
      .meta({ access: { type: 'public' } })
      .output(z.array(TaskSchema)),
  ),
  create: readsWorkspace(
    ocPublic
      .route({ method: 'POST', path: '/tasks', summary: 'Create a task' })
      .meta({ access: { type: 'public' } })
      .input(CreateTaskInputSchema)
      .output(TaskSchema),
  ),
  toggle: readsWorkspace(
    ocPublic
      .route({ method: 'POST', path: '/tasks/{id}/toggle', summary: 'Toggle task completion' })
      .meta({ access: { type: 'public' } })
      .errors({ NOT_FOUND: notFoundError })
      .input(TaskIdInputSchema)
      .output(TaskSchema),
  ),
  // Первая процедура с политикой «owner» (C2.3): удалять может только владелец
  // задачи. NOT_FOUND не объявляется намеренно: проверка владельца идёт до
  // доменной логики, у несуществующей задачи владельца нет — ownerOf отвечает
  // null — и оба случая (чужой и неизвестный id) получают отказ FORBIDDEN
  // без оракула «ресурс существует» (fail-closed, C2.2).
  remove: readsWorkspace(
    ocAccess
      .route({
        method: 'DELETE',
        path: '/tasks/{id}',
        summary: 'Delete an owned task',
        // c1.7: авторизация исполняется до валидации входа, поэтому не-uuid id
        // получает тот же FORBIDDEN, а не BAD_REQUEST — потребитель не отличает
        // «битый формат» от «нет доступа». Поведение закреплено тестом (app.test).
        description:
          'Authorization runs before input validation: a malformed id (not a uuid) is answered with 403 FORBIDDEN, indistinguishable from having no access.',
      })
      .meta({ access: { type: 'owner' } })
      .input(TaskIdInputSchema)
      .output(z.void()),
  ),
};
