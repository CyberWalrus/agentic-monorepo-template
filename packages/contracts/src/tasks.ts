import { oc } from '@orpc/contract';
import * as z from 'zod';

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
  list: oc
    .route({ method: 'GET', path: '/tasks', summary: 'List tasks, newest first' })
    .output(z.array(TaskSchema)),
  create: oc
    .route({ method: 'POST', path: '/tasks', summary: 'Create a task' })
    .input(CreateTaskInputSchema)
    .output(TaskSchema),
  toggle: oc
    .route({ method: 'POST', path: '/tasks/{id}/toggle', summary: 'Toggle task completion' })
    .errors({ NOT_FOUND: { message: 'Task not found' } })
    .input(TaskIdInputSchema)
    .output(TaskSchema),
};
