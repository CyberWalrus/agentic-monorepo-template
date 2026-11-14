import { ErrorState, NotFoundState, PendingState } from '@repo/ui';
import type { ErrorComponentProps } from '@tanstack/react-router';

/**
 * Адаптеры состояний маршрута под TanStack Router (roadmap C5). Презентация —
 * в `@repo/ui`, здесь только клей: пропсы фреймворка и router.invalidate().
 *
 * `reset` инвалидирует роутер и заново прогоняет loader'ы упавшего маршрута —
 * это не инвалидация серверного состояния после мутаций из architecture.md 2.4.
 */

export function RouteError({ reset }: ErrorComponentProps) {
  // Детали ошибки пользователю не показываем: они уезжают в trace и логи (З11).
  return (
    <main>
      <ErrorState onRetry={reset} />
    </main>
  );
}

export function RoutePending() {
  return (
    <main>
      <PendingState />
    </main>
  );
}

export function RouteNotFound() {
  // Состояние заменяет контент маршрута, у которого мог быть свой main:
  // без него страница остаётся без главного landmark (гейт a11y в e2e).
  return (
    <main>
      <NotFoundState homeHref="/" homeLabel="Back to tasks" />
    </main>
  );
}
