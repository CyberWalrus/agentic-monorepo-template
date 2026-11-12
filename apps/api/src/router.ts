import { contract } from '@repo/contracts';
import { implement } from '@orpc/server';

import type { TaskRepository } from './tasks/repository.ts';

interface AppContext {
  tasks: TaskRepository;
}

const os = implement(contract).$context<AppContext>();

export const router = os.router({
  tasks: {
    list: os.tasks.list.handler(({ context }) => context.tasks.list()),
    create: os.tasks.create.handler(({ input, context }) => context.tasks.create(input.title)),
    toggle: os.tasks.toggle.handler(async ({ input, context, errors }) => {
      const task = await context.tasks.toggle(input.id);
      if (!task) {
        throw errors.NOT_FOUND();
      }
      return task;
    }),
  },
});
