import { randomUUID } from 'node:crypto';

import type { Task } from '@repo/contracts';

/**
 * Рабочее пространство (ADR 0020): идентификатор изоляции E2E-сценариев.
 * `undefined` в параметрах интерфейса означает «ничей» scope — то, что видят
 * запросы без заголовка `x-workspace-id` (ручные клиенты, k6). Исключение —
 * `reset`: там `undefined` — легаси-глобальный сброс всего хранилища (общий
 * `/__test__/reset` для точечных сценариев), строка — замена содержимого
 * одного рабочего пространства.
 */
export interface TaskRepository {
  /** Задачи рабочего пространства, newest first. */
  list(workspaceId?: string): Promise<Task[]>;
  /**
   * Создаёт задачу. ownerId — владелец (C2.3); workspaceId — рабочее
   * пространство (ADR 0020), по умолчанию — «ничей».
   */
  create(title: string, ownerId?: string | null, workspaceId?: string): Promise<Task>;
  /** Переключает задачу своего рабочего пространства; чужая или ничейная для scope — undefined. */
  toggle(id: string, workspaceId?: string): Promise<Task | undefined>;
  /** Удаляет задачу своего рабочего пространства и возвращает её; чужая — undefined. */
  remove(id: string, workspaceId?: string): Promise<Task | undefined>;
  /** Владелец задачи или null — задачи нет или она ничья. Читает политика «owner»; сквозной между workspace (ADR 0020). */
  ownerOf(id: string): Promise<string | null>;
  /** См. комментарий интерфейса: workspace-scoped seed или глобальный сброс. */
  reset(tasks: readonly Task[], workspaceId?: string): Promise<void>;
}

export interface InMemoryTaskRepositoryOptions {
  now?: () => Date;
  generateId?: () => string;
}

interface TaskRow {
  task: Task;
  ownerId: string | null;
  workspaceId: string | null;
}

/**
 * Хранилище в памяти. Достаточно для демо-домена;
 * Postgres-реализация — за тем же интерфейсом (postgres-repository.ts).
 * Ключ карты — идентификатор задачи: id уникален в масштабе хранилища
 * (PRIMARY KEY на Postgres), одинаковый id в разных рабочих пространствах
 * отвергается reset-ом громко в обеих реализациях — молчаливое затирание
 * соседа или PK-исключение только на Postgres скрыли бы баг seed-данных
 * (ADR 0020, контрактный набор закрепляет отказ).
 */
export class InMemoryTaskRepository implements TaskRepository {
  // Не readonly: reset заменяет карту целиком (см. reset) — наблюдатели не
  // видят промежуточное состояние между стиранием и заполнением.
  #tasks = new Map<string, TaskRow>();
  readonly #now: () => Date;
  readonly #generateId: () => string;

  constructor({
    now = () => new Date(),
    generateId = randomUUID,
  }: InMemoryTaskRepositoryOptions = {}) {
    this.#now = now;
    this.#generateId = generateId;
  }

  async list(workspaceId?: string): Promise<Task[]> {
    const scope = workspaceId ?? null;
    const tasks = [...this.#tasks.values()]
      .filter((row) => row.workspaceId === scope)
      .map((row) => row.task);
    return tasks.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async create(title: string, ownerId?: string | null, workspaceId?: string): Promise<Task> {
    const task: Task = {
      id: this.#generateId(),
      title,
      completed: false,
      createdAt: this.#now().toISOString(),
    };
    this.#tasks.set(task.id, {
      task,
      ownerId: ownerId ?? null,
      workspaceId: workspaceId ?? null,
    });
    return task;
  }

  async toggle(id: string, workspaceId?: string): Promise<Task | undefined> {
    const row = this.#tasks.get(id);
    if (row === undefined || row.workspaceId !== (workspaceId ?? null)) {
      return undefined;
    }
    const updated = { ...row.task, completed: !row.task.completed };
    this.#tasks.set(id, { task: updated, ownerId: row.ownerId, workspaceId: row.workspaceId });
    return updated;
  }

  async remove(id: string, workspaceId?: string): Promise<Task | undefined> {
    const row = this.#tasks.get(id);
    if (row === undefined || row.workspaceId !== (workspaceId ?? null)) {
      return undefined;
    }
    this.#tasks.delete(id);
    return row.task;
  }

  async ownerOf(id: string): Promise<string | null> {
    return this.#tasks.get(id)?.ownerId ?? null;
  }

  /**
   * Замена набора, атомарная как транзакция Postgres (e53): ни одной мутации
   * хранилища, пока новый набор не собран целиком. Сбойный seed — дубликат id
   * в наборе или id чужого рабочего пространства — оставляет хранилище
   * нетронутым и с той же ошибкой, что Postgres. Порядок проверок закреплён
   * за Postgres: сначала дубликаты (свойство самого набора), затем чужие id
   * (свойство хранилища). Чужие id ищутся только среди строк, которые сброс
   * оставляет: без `workspaceId` стирается всё (легаси-семантика общего
   * `/__test__/reset`), и id прежних строк любого scope свободны.
   */
  async reset(tasks: readonly Task[], workspaceId?: string): Promise<void> {
    const seededIds = new Set<string>();
    for (const task of tasks) {
      if (seededIds.has(task.id)) {
        throw new Error(`Duplicate task id within one seed: ${task.id} (ADR 0020)`);
      }
      seededIds.add(task.id);
    }
    const retained = new Map<string, TaskRow>();
    if (workspaceId !== undefined) {
      for (const [id, row] of this.#tasks) {
        if (row.workspaceId !== workspaceId) {
          retained.set(id, row);
        }
      }
    }
    for (const task of tasks) {
      const foreign = retained.get(task.id);
      if (foreign !== undefined) {
        throw new Error(
          `Task id ${task.id} already exists in workspace "${foreign.workspaceId ?? 'none'}" — seed data must use ids unique across workspaces (ADR 0020)`,
        );
      }
    }
    for (const task of tasks) {
      retained.set(task.id, { task, ownerId: null, workspaceId: workspaceId ?? null });
    }
    this.#tasks = retained;
  }
}
