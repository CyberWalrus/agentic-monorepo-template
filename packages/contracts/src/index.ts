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

export { AccessPolicySchema, ocAccess, ocPublic } from './access-policy.ts';

export { ERROR_MESSAGES } from './errors.ts';

export {
  documentErrorResponses,
  errorResponses,
  hasValidatedInput,
  operationsWithInputValidation,
  voidSchemaConverter,
  type WireResponse,
} from './openapi-spec.ts';

export { WORKSPACE_HEADER, parseWorkspaceId } from './workspace.ts';
