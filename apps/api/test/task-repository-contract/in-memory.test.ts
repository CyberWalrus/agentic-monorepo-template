import { describe, expect, it } from 'vitest';

import { InMemoryTaskRepository } from '../../src/tasks/repository.ts';

import { taskRepositoryContractChecks } from './contract.ts';

describe('TaskRepository contract: InMemoryTaskRepository', () => {
  it.each(taskRepositoryContractChecks)('$name', async ({ check }) => {
    await expect(check(new InMemoryTaskRepository())).resolves.toBeUndefined();
  });
});
