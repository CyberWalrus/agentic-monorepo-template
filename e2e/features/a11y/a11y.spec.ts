import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '../../fixtures.ts';

test.describe('accessibility', () => {
  test('home page has no accessibility violations', async ({ page, uniqueTitle }) => {
    await page.goto('/');

    // Своя задача (uniqueTitle): скан идёт по заполненной странице независимо
    // от того, что параллельные тесты сделали с общими данными (З9). Форма
    // активна только после гидратации — это и есть ожидание финального DOM.
    const title = uniqueTitle('A11y probe');
    await page.getByLabel('New task').fill(title);
    await page.getByRole('button', { name: 'Add task' }).click();

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
