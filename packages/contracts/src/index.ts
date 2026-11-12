import { tasksContract } from './tasks.ts';

export const contract = {
  tasks: tasksContract,
};

export type Contract = typeof contract;

export {
  CreateTaskInputSchema,
  TASK_TITLE_MAX_LENGTH,
  TaskIdInputSchema,
  TaskSchema,
  type CreateTaskInput,
  type Task,
} from './tasks.ts';
