import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '../../fixtures.ts';

test.describe('accessibility', () => {
  // Скан после гидратации: страница уже отрисовала данные, DOM финальный.
  test('home page has no accessibility violations', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('list', { name: 'Tasks' })).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(
      describeViolations(results.violations),
      'fix the markup instead of disabling the rules',
    ).toEqual([]);
  });

  test('not-found page has no accessibility violations', async ({ page }) => {
    await page.goto('/this-route-does-not-exist');

    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(
      describeViolations(results.violations),
      'fix the markup instead of disabling the rules',
    ).toEqual([]);
  });
});

/** Компактный отчёт о нарушениях: правило, серьёзность, селекторы. */
function describeViolations(
  violations: Awaited<ReturnType<AxeBuilder['analyze']>>['violations'],
): string[] {
  return violations.map(
    (violation) =>
      `${violation.id} (${violation.impact ?? 'unknown'}): ${violation.nodes
        .map((node) => node.target.join(' '))
        .join('; ')}`,
  );
}
