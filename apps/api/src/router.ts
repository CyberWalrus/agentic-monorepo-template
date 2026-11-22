import { contract } from '@repo/contracts';
import { implement } from '@orpc/server';

import { authorizationMiddleware, type AppContext } from './authorization.ts';

// Мидлварь на строителе, а не на отдельных процедурах: у каждой процедуры
// роутера она в цепочке, пути вызвать её в обход нет (C2.2).
const os = implement(contract).$context<AppContext>().use(authorizationMiddleware);

export const router = os.router({
  tasks: {
    // Скоупинг по рабочему пространству запроса (ADR 0020): null-контекст —
    // «ничей» scope, контракт процедур не меняется.
    list: os.tasks.list.handler(({ context }) =>
      context.tasks.list(context.workspaceId ?? undefined),
    ),
    // Создатель задачи становится её владельцем; без актора задача ничья
    // (null) и для политики «owner» неотличима от чужой — fail-closed (C2.2).
    create: os.tasks.create.handler(({ input, context }) =>
      context.tasks.create(
        input.title,
        context.actor?.id ?? null,
        context.workspaceId ?? undefined,
      ),
    ),
    toggle: os.tasks.toggle.handler(async ({ input, context, errors }) => {
      const task = await context.tasks.toggle(input.id, context.workspaceId ?? undefined);
      if (!task) {
        throw errors.NOT_FOUND();
      }
      return task;
    }),
    // Домен не проверяет владельца: NOT_FOUND здесь недостижим — у задачи без
    // владельца (нет или чужая) мидлварь отказывает раньше (C2.3, план).
    remove: os.tasks.remove.handler(async ({ input, context }) => {
      await context.tasks.remove(input.id, context.workspaceId ?? undefined);
    }),
  },
});
