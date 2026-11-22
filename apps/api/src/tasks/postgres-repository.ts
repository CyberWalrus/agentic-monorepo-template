import { randomUUID } from 'node:crypto';

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { SQL } from 'drizzle-orm';

import type { Task } from '@repo/contracts';

import type { TaskRepository } from './repository.ts';
import * as schema from './schema.ts';

export interface PostgresTaskRepositoryOptions {
  db: NodePgDatabase;
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
 * Фильтр строк рабочего пространства (ADR 0020). NULL-колонка и «ничей» scope
 * сопоставляются IS NULL: eq(column, 'w') не матчит NULL-строки — ничейные
 * задачи невидимы из workspace-scope, как и в InMemory-реализации
 * (row.workspaceId === scope).
 */
function workspaceWhere(workspaceId?: string): SQL | undefined {
  return workspaceId === undefined
    ? isNull(schema.tasks.workspaceId)
    : eq(schema.tasks.workspaceId, workspaceId);
}

/**
 * Хранилище задач на Postgres за Drizzle — вторая реализация TaskRepository
 * (образец работы с постоянным хранилищем). Включается переменной DATABASE_URL
 * в server.ts; контрактный набор C1.1 гоняется против обеих реализаций без
 * изменений. Порядок list() — newest first (созданный позже в списке выше),
 * при равных createdAt порядок не определён — как в контракте (C1.1).
 */
export class PostgresTaskRepository implements TaskRepository {
  readonly #db: NodePgDatabase;
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

  async list(workspaceId?: string): Promise<Task[]> {
    const rows = await this.#db
      .select()
      .from(schema.tasks)
      .where(workspaceWhere(workspaceId))
      .orderBy(desc(schema.tasks.createdAt));
    return rows.map(toTask);
  }

  async create(title: string, ownerId?: string | null, workspaceId?: string): Promise<Task> {
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
      ownerId: ownerId ?? null,
      workspaceId: workspaceId ?? null,
    });
    return task;
  }

  async toggle(id: string, workspaceId?: string): Promise<Task | undefined> {
    // NOT completed в самом SQL: переключение атомарно, без чтения перед записью.
    const rows = await this.#db
      .update(schema.tasks)
      .set({ completed: sql`not ${schema.tasks.completed}` })
      .where(and(eq(schema.tasks.id, id), workspaceWhere(workspaceId)))
      .returning();
    const row = rows.at(0);
    return row === undefined ? undefined : toTask(row);
  }

  async remove(id: string, workspaceId?: string): Promise<Task | undefined> {
    const rows = await this.#db
      .delete(schema.tasks)
      .where(and(eq(schema.tasks.id, id), workspaceWhere(workspaceId)))
      .returning();
    const row = rows.at(0);
    return row === undefined ? undefined : toTask(row);
  }

  async ownerOf(id: string): Promise<string | null> {
    const rows = await this.#db
      .select({ ownerId: schema.tasks.ownerId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, id));
    return rows.at(0)?.ownerId ?? null;
  }

  async reset(tasks: readonly Task[], workspaceId?: string): Promise<void> {
    await this.#db.transaction(async (tx) => {
      if (workspaceId === undefined) {
        // Легаси-семантика общего /__test__/reset: стираем всё хранилище.
        await tx.delete(schema.tasks);
      } else {
        await tx.delete(schema.tasks).where(eq(schema.tasks.workspaceId, workspaceId));
      }
      if (tasks.length === 0) {
        // insert с пустым набором значений drizzle не допускает — сброс до пустоты
        // это просто delete (проверяется контрактом: reset with an empty list).
        return;
      }
      // id уникальны в масштабе хранилища (PRIMARY KEY): seed с дубликатом id
      // внутри набора — громкий отказ до insert с тем же текстом, что в
      // InMemory-реализации (ADR 0020, контрактный набор).
      const seededIds = new Set<string>();
      for (const task of tasks) {
        if (seededIds.has(task.id)) {
          throw new Error(`Duplicate task id within one seed: ${task.id} (ADR 0020)`);
        }
        seededIds.add(task.id);
      }
      // Seed с id чужого рабочего пространства — тоже громкий отказ до insert,
      // а не PK-исключение (семантика InMemory-реализации, ADR 0020).
      // IS DISTINCT FROM, а не <>: ничейные строки (NULL) — тоже чужой scope.
      const foreign = await tx
        .select({ id: schema.tasks.id, workspaceId: schema.tasks.workspaceId })
        .from(schema.tasks)
        .where(
          and(
            inArray(
              schema.tasks.id,
              tasks.map((task) => task.id),
            ),
            sql`${schema.tasks.workspaceId} is distinct from ${workspaceId ?? null}`,
          ),
        );
      const clash = foreign.at(0);
      if (clash !== undefined) {
        throw new Error(
          `Task id ${clash.id} already exists in workspace "${clash.workspaceId ?? 'none'}" — seed data must use ids unique across workspaces (ADR 0020)`,
        );
      }
      await tx.insert(schema.tasks).values(
        tasks.map((task) => ({
          id: task.id,
          title: task.title,
          completed: task.completed,
          createdAt: new Date(task.createdAt),
          workspaceId: workspaceId ?? null,
        })),
      );
    });
  }
}
