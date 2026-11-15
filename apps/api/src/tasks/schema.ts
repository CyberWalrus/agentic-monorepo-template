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
});
