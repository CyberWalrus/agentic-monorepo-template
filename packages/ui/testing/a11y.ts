import axe from 'axe-core';

/**
 * Скан доступности отрендеренного компонента (roadmap C5). Возвращает список
 * нарушений «правило (серьёзность): селекторы»; тест сравнивает его с пустым
 * списком. Скан идёт по контейнеру компонента, а не по документу —
 * vitest-обвязка в проверку не попадает. Правила не отключаем: чини разметку.
 */
export async function collectA11yViolations(container: HTMLElement): Promise<string[]> {
  const results = await axe.run(container);

  return results.violations.map(
    (violation) =>
      `${violation.id} (${violation.impact ?? 'unknown'}): ${violation.nodes
        .map((node) => node.target.join(' '))
        .join('; ')}`,
  );
}
