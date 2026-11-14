import { describe, expect, it } from 'vitest';

import { collectA11yViolations } from './a11y.ts';

describe('a11y helper canary', () => {
  // Канарейка гейта a11y: если axe перестал ловить нарушения, этот тест
  // краснеет первым — раньше, чем недоступная разметка доедет до UI.
  it('reports an image without alt text as a violation', async () => {
    const container = document.createElement('div');
    const image = document.createElement('img');
    image.src = '/broken.png';
    container.append(image);
    document.body.append(container);

    const violations = await collectA11yViolations(container);

    expect(violations, 'axe must catch the missing alt text').toContainEqual(
      expect.stringMatching(/^image-alt/),
    );

    container.remove();
  });
});
