import { contract } from '@repo/contracts';
import { implement } from '@orpc/server';

import { authorizationMiddleware, type AppContext } from './authorization.ts';

// Мидлварь на строителе, а не на отдельных процедурах: у каждой процедуры
// роутера она в цепочке, пути вызвать её в обход нет (C2.2).
const os = implement(contract).$context<AppContext>().use(authorizationMiddleware);

export const router = os.router({
  tasks: {
    // Скоупинг по рабочему пространству запроса (ADR 0020): null-контекст —
    // «ничей» scope. Заголовок читает мидлварь, а не вход процедуры; в спеке
    // он описан как необязательный параметр операции (readsWorkspace, e58).
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
    // Домен не проверяет владельца: у задачи без владельца (нет или чужая)
    // мидлварь отказывает раньше (C2.3). А вот scope рабочего пространства
    // проверяет только домен: проверка владельца сквозная (ADR 0020), поэтому
    // до домена доходит и запрос владельца из чужого scope. Неудалённая задача
    // (undefined) — отказ FORBIDDEN, тот же, что для неизвестного id: NOT_FOUND
    // для remove контрактом не заявлен, задача вне scope для клиента не
    // существует (e52).
    remove: os.tasks.remove.handler(async ({ input, context, errors }) => {
      const removed = await context.tasks.remove(input.id, context.workspaceId ?? undefined);
      if (!removed) {
        throw errors.FORBIDDEN();
      }
    }),
  },
});
