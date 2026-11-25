/**
 * Визуальные базлайны состояний маршрута (ErrorState, NotFoundState, PendingState).
 * Состояния снимаются одним кадром: базлайн сверяет их относительно друг друга.
 * Запускаются только в Docker-образе Playwright (`pnpm visual`), чтобы шрифты
 * и рендеринг совпадали локально и в CI. Обновление базлайнов — только
 * `pnpm visual:update`, это делает человек.
 */
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';

import { ErrorState } from './error-state/error-state.tsx';
import { NotFoundState } from './not-found-state/not-found-state.tsx';
import { PendingState } from './pending-state/pending-state.tsx';
import { Frame } from '../testing/visual-frame.tsx';

describe('visual', () => {
  it('Route states', async () => {
    const screen = await render(
      <Frame>
        <div style={{ display: 'grid', gap: 16, width: '100%' }}>
          <ErrorState onRetry={() => {}} />
          <NotFoundState homeHref="/" homeLabel="Back to tasks" />
          <PendingState />
        </div>
      </Frame>,
    );

    // data-testid обоснован: Frame — layout-обёртка сценария, у div нет роли и подписи,
    // текст принадлежит детям — семантики нет.
    await expect.element(screen.getByTestId('frame')).toMatchScreenshot('route-states');
  });
});
