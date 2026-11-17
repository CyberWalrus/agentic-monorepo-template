import { randomUUID } from 'node:crypto';

import type { Task } from '@repo/contracts';

export interface TaskRepository {
  list(): Promise<Task[]>;
  /** ownerId — владелец новой задачи (C2.3); без него задача ничья (null). */
  create(title: string, ownerId?: string | null): Promise<Task>;
  toggle(id: string): Promise<Task | undefined>;
  /** Удаляет задачу и возвращает её; неизвестный id — undefined. */
  remove(id: string): Promise<Task | undefined>;
  /** Владелец задачи или null — задачи нет или она ничья. Читает политика «owner». */
  ownerOf(id: string): Promise<string | null>;
  reset(tasks: readonly Task[]): Promise<void>;
}

export interface InMemoryTaskRepositoryOptions {
  now?: () => Date;
  generateId?: () => string;
}

interface TaskRow {
  task: Task;
  ownerId: string | null;
}

/**
 * Хранилище в памяти. Достаточно для демо-домена и тестов;
 * реализация на Postgres появится за тем же интерфейсом.
 */
export class InMemoryTaskRepository implements TaskRepository {
  readonly #tasks = new Map<string, TaskRow>();
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
    const tasks = [...this.#tasks.values()].map((row) => row.task);
    return tasks.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async create(title: string, ownerId?: string | null): Promise<Task> {
    const task: Task = {
      id: this.#generateId(),
      title,
      completed: false,
      createdAt: this.#now().toISOString(),
    };
    this.#tasks.set(task.id, { task, ownerId: ownerId ?? null });
    return task;
  }

  async toggle(id: string): Promise<Task | undefined> {
    const row = this.#tasks.get(id);
    if (row === undefined) {
      return undefined;
    }
    const updated = { ...row.task, completed: !row.task.completed };
    this.#tasks.set(id, { task: updated, ownerId: row.ownerId });
    return updated;
  }

  async remove(id: string): Promise<Task | undefined> {
    const row = this.#tasks.get(id);
    if (row === undefined) {
      return undefined;
    }
    this.#tasks.delete(id);
    return row.task;
  }

  async ownerOf(id: string): Promise<string | null> {
    return this.#tasks.get(id)?.ownerId ?? null;
  }

  async reset(tasks: readonly Task[]): Promise<void> {
    this.#tasks.clear();
    for (const task of tasks) {
      this.#tasks.set(task.id, { task, ownerId: null });
    }
  }
}
