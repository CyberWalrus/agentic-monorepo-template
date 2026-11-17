import { boolean, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Схема демо-домена задач. Новая миграция — `pnpm --filter @repo/api db:generate`,
 * применяется `migrateTaskDatabase` (тесты и сервер делают это сами).
 */
export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey(),
  title: text('title').notNull(),
  completed: boolean('completed').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  // Владелец — серверные данные политики доступа (C2.3): мидлварь сверяет
  // актора с ним через порт ownerOf репозитория. text, а не uuid: Actor.id —
  // непрозрачная строка, формы аутентификации ещё нет (C2.2). Nullable: у
  // задачи, созданной без актора, владельца нет, и удаляема она быть не может —
  // для политики «owner» это тот же отказ, что и чужая задача (fail-closed).
  // В контракте Task поля нет: клиентам владение не видно (кроме исполнения).
  ownerId: text('owner_id'),
});
