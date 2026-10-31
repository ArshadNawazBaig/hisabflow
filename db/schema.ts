import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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

// Canonical owners stay unchanged when a Google account is explicitly linked.
// Both directions are unique; the application never reassigns an existing pair.
export const authIdentityLinks = sqliteTable('auth_identity_links', {
  googleUserId: text('google_user_id').primaryKey(),
  ownerId: text('owner_id').notNull().unique(),
  createdAt: text('created_at').notNull(),
});

// Only hashes of short-lived, one-use OAuth state tokens are stored here.
export const authOauthFlows = sqliteTable('auth_oauth_flows', {
  nonceHash: text('nonce_hash').primaryKey(),
  intent: text('intent', { enum: ['signin', 'link'] }).notNull(),
  sitesOwnerId: text('sites_owner_id'),
  expiresAt: integer('expires_at').notNull(),
  createdAt: integer('created_at').notNull(),
}, table => [index('auth_oauth_flows_expires_at_idx').on(table.expiresAt)]);
