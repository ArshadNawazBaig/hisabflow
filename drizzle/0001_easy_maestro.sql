CREATE TABLE `workspace_storage_locks` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`target` text NOT NULL,
	`locked_at` text NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER workspaces_block_migrated_insert
BEFORE INSERT ON workspaces
WHEN EXISTS (SELECT 1 FROM workspace_storage_locks WHERE owner_id = NEW.owner_id)
BEGIN
  SELECT RAISE(ABORT, 'This workspace has moved to Supabase');
END;
--> statement-breakpoint
CREATE TRIGGER workspaces_block_migrated_update
BEFORE UPDATE ON workspaces
WHEN EXISTS (SELECT 1 FROM workspace_storage_locks WHERE owner_id = OLD.owner_id OR owner_id = NEW.owner_id)
BEGIN
  SELECT RAISE(ABORT, 'This workspace has moved to Supabase');
END;
--> statement-breakpoint
CREATE TRIGGER workspaces_block_migrated_delete
BEFORE DELETE ON workspaces
WHEN EXISTS (SELECT 1 FROM workspace_storage_locks WHERE owner_id = OLD.owner_id)
BEGIN
  SELECT RAISE(ABORT, 'Retained workspace evidence is locked after migration');
END;
