import * as z from 'zod';

import { notFoundError } from './errors.ts';
import { ocAccess } from './access-policy.ts';

export const TASK_TITLE_MAX_LENGTH = 200;

export const TaskSchema = z.object({
  id: z.uuid(),
  title: z.string().min(1).max(TASK_TITLE_MAX_LENGTH),
  completed: z.boolean(),
  createdAt: z.iso.datetime(),
});

export const CreateTaskInputSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(TASK_TITLE_MAX_LENGTH),
});

export const TaskIdInputSchema = z.object({
  id: z.uuid(),
});

export type Task = z.infer<typeof TaskSchema>;
export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;

export const tasksContract = {
  list: ocAccess
    .route({ method: 'GET', path: '/tasks', summary: 'List tasks, newest first' })
    .meta({ access: { type: 'public' } })
    .output(z.array(TaskSchema)),
  create: ocAccess
    .route({ method: 'POST', path: '/tasks', summary: 'Create a task' })
    .meta({ access: { type: 'public' } })
    .input(CreateTaskInputSchema)
    .output(TaskSchema),
  toggle: ocAccess
    .route({ method: 'POST', path: '/tasks/{id}/toggle', summary: 'Toggle task completion' })
    .meta({ access: { type: 'public' } })
    .errors({ NOT_FOUND: notFoundError })
    .input(TaskIdInputSchema)
    .output(TaskSchema),
  // Первая процедура с политикой «owner» (C2.3): удалять может только владелец
  // задачи. NOT_FOUND не объявляется намеренно: проверка владельца идёт до
  // доменной логики, у несуществующей задачи владельца нет — ownerOf отвечает
  // null — и оба случая (чужой и неизвестный id) получают отказ FORBIDDEN
  // без оракула «ресурс существует» (fail-closed, C2.2).
  remove: ocAccess
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
};
