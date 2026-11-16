import { contract } from '@repo/contracts';
import { implement } from '@orpc/server';

import { authorizationMiddleware, type AppContext } from './authorization.ts';

// Мидлварь на строителе, а не на отдельных процедурах: у каждой процедуры
// роутера она в цепочке, пути вызвать её в обход нет (C2.2).
const os = implement(contract).$context<AppContext>().use(authorizationMiddleware);

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
