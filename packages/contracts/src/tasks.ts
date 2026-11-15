import * as z from 'zod';

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
    .errors({ NOT_FOUND: { message: 'Task not found' } })
    .input(TaskIdInputSchema)
    .output(TaskSchema),
};
