import { randomUUID } from 'node:crypto';

import type { Task } from '@repo/contracts';

export interface TaskRepository {
  list(): Promise<Task[]>;
  create(title: string): Promise<Task>;
  toggle(id: string): Promise<Task | undefined>;
  reset(tasks: readonly Task[]): Promise<void>;
}

export interface InMemoryTaskRepositoryOptions {
  now?: () => Date;
  generateId?: () => string;
}

/**
 * Хранилище в памяти. Достаточно для демо-домена и тестов;
 * реализация на Postgres появится за тем же интерфейсом.
 */
export class InMemoryTaskRepository implements TaskRepository {
  readonly #tasks = new Map<string, Task>();
  readonly #now: () => Date;
  readonly #generateId: () => string;

  constructor({
    now = () => new Date(),
    generateId = randomUUID,
  }: InMemoryTaskRepositoryOptions = {}) {
    this.#now = now;
    this.#generateId = generateId;
  }

  async list(): Promise<Task[]> {
    return [...this.#tasks.values()].toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async create(title: string): Promise<Task> {
    const task: Task = {
      id: this.#generateId(),
      title,
      completed: false,
      createdAt: this.#now().toISOString(),
    };
    this.#tasks.set(task.id, task);
    return task;
  }

  async toggle(id: string): Promise<Task | undefined> {
    const task = this.#tasks.get(id);
    if (!task) {
      return undefined;
    }
    const updated = { ...task, completed: !task.completed };
    this.#tasks.set(id, updated);
    return updated;
  }

  async reset(tasks: readonly Task[]): Promise<void> {
    this.#tasks.clear();
    for (const task of tasks) {
      this.#tasks.set(task.id, task);
    }
  }
}
