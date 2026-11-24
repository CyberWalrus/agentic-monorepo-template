import { ErrorState, NotFoundState, PendingState } from '@repo/ui';
import { useRouter } from '@tanstack/react-router';

/**
 * Адаптеры состояний маршрута под TanStack Router (roadmap C5). Презентация —
 * в `@repo/ui`, здесь только клей: router.invalidate().
 *
 * Повтор — `router.invalidate()`: он заново прогоняет loader'ы упавшего
 * маршрута, а сменившийся match сбрасывает и границу ошибок (её ключ сброса —
 * объект match). Пропс `reset` сбрасывает только саму границу: совпадение
 * снова бросает сохранённую ошибку, и кнопка ничего не повторяет (e61). Это не
 * инвалидация серверного состояния после мутаций из architecture.md 2.4.
 */

export function RouteError() {
  const router = useRouter();
  // Детали ошибки пользователю не показываем: они уезжают в trace и логи (З11).
  return (
    <main>
      <ErrorState
        onRetry={() => {
          void router.invalidate();
        }}
      />
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
