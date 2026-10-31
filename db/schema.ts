import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const workspaces = sqliteTable('workspaces', {
  ownerId: text('owner_id').primaryKey(),
  revision: integer('revision').notNull().default(1),
  data: text('data').notNull(),
  updatedAt: text('updated_at').notNull(),
});
