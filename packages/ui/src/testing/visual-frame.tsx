import type { ReactNode } from 'react';

import '../tokens.css';

/**
 * Общая рамка визуальных сценариев: одинаковая ширина и отступы дают
 * детерминированные снимки. Токены импортируются здесь, а не в каждом
 * сценарии: пиксели не должны зависеть от того, подключил ли сценарий CSS.
 * Сценарии (`*.visual.test.tsx`) запускаются только в Docker-образе Playwright
 * (`pnpm visual`); обновление базлайнов — только `pnpm visual:update`, это
 * делает человек.
 */
export function Frame({ children }: { children: ReactNode }) {
  return (
    <div data-testid="frame" style={{ display: 'inline-flex', gap: 12, padding: 16, width: 360 }}>
      {children}
    </div>
  );
}
