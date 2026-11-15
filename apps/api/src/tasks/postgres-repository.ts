import { randomUUID } from 'node:crypto';

import { desc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { Task } from '@repo/contracts';

import type { TaskRepository } from './repository.ts';
import * as schema from './schema.ts';

export interface PostgresTaskRepositoryOptions {
  db: NodePgDatabase<typeof schema>;
  now?: () => Date;
  generateId?: () => string;
}

function toTask(row: typeof schema.tasks.$inferSelect): Task {
  return {
    id: row.id,
    title: row.title,
    completed: row.completed,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Хранилище задач на Postgres за Drizzle — вторая реализация TaskRepository
 * (образец работы с постоянным хранилищем). Включается переменной DATABASE_URL
 * в server.ts; контрактный набор C1.1 гоняется против обеих реализаций без
 * изменений. Порядок list() — newest first (созданный позже в списке выше),
 * при равных createdAt порядок не определён — как в контракте (C1.1).
 */
export class PostgresTaskRepository implements TaskRepository {
  readonly #db: NodePgDatabase<typeof schema>;
  readonly #now: () => Date;
  readonly #generateId: () => string;

  constructor({
    db,
    now = () => new Date(),
    generateId = randomUUID,
  }: PostgresTaskRepositoryOptions) {
    this.#db = db;
    this.#now = now;
    this.#generateId = generateId;
  }

  async list(): Promise<Task[]> {
    const rows = await this.#db.select().from(schema.tasks).orderBy(desc(schema.tasks.createdAt));
    return rows.map(toTask);
  }

  async create(title: string): Promise<Task> {
    const task: Task = {
      id: this.#generateId(),
      title,
      completed: false,
      createdAt: this.#now().toISOString(),
    };
    await this.#db.insert(schema.tasks).values({
      id: task.id,
      title: task.title,
      completed: task.completed,
      createdAt: new Date(task.createdAt),
    });
    return task;
  }

  async toggle(id: string): Promise<Task | undefined> {
    // NOT completed в самом SQL: переключение атомарно, без чтения перед записью.
    const rows = await this.#db
      .update(schema.tasks)
      .set({ completed: sql`not ${schema.tasks.completed}` })
      .where(eq(schema.tasks.id, id))
      .returning();
    const row = rows.at(0);
    return row === undefined ? undefined : toTask(row);
  }

  async reset(tasks: readonly Task[]): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx.delete(schema.tasks);
      if (tasks.length === 0) {
        // insert с пустым набором значений drizzle не допускает — сброс до пустоты
        // это просто delete (проверяется контрактом: reset with an empty list).
        return;
      }
      await tx.insert(schema.tasks).values(
        tasks.map((task) => ({
          id: task.id,
          title: task.title,
          completed: task.completed,
          createdAt: new Date(task.createdAt),
        })),
      );
    });
  }
}
