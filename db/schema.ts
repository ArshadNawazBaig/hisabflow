import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const workspaces = sqliteTable('workspaces', {
  ownerId: text('owner_id').primaryKey(),
  revision: integer('revision').notNull().default(1),
  data: text('data').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// A lock freezes the legacy row while it is copied to Supabase. SQL triggers
// enforce the lock even for requests still running an older app version.
export const workspaceStorageLocks = sqliteTable('workspace_storage_locks', {
  ownerId: text('owner_id').primaryKey(),
  target: text('target').notNull(),
  lockedAt: text('locked_at').notNull(),
});
