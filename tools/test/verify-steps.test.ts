/**
 * Шаг test доводит упавший прогон до конца (turbo --continue): отчёты vitest пишут все пакеты, даже когда
 * один упал. Диагностика упавшего шага и канарейки гейтов читают сообщение любого пакета, а не только
 * первого упавшего — иначе канарейка, ждущая тест соседнего пакета, слепнет (22.11, 24.11, 25.11).
 */
import { expect, it } from 'vitest';
import { fast } from '../verify-steps.ts';

it('шаг test запускает turbo с --continue', () => {
  const test = fast.find((step) => step.name === 'test');
  expect(test?.command).toBe('pnpm');
  expect(test?.args.slice(0, 4)).toEqual(['turbo', 'run', 'test', '--output-logs=errors-only']);
  expect(test?.args, 'упавший прогон test доводится до конца (turbo --continue)').toContain(
    '--continue',
  );
});
