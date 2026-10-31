import { env } from 'cloudflare:workers';
import { workspaceSchema } from '../workspace-validation';
import { createSupabaseWorkspaceStore, HISABFLOW_SUPABASE_URL, SupabaseWorkspaceError, type StoredWorkspace, type WorkspaceStore } from './supabase-workspace';
import { createMigratingWorkspaceStore, type LegacyWorkspaceSource } from './workspace-migration';

export class WorkspaceStorageError extends Error {
  constructor(code: 'configuration' | 'migrated' | 'response' | 'unavailable') {
    super({
      configuration: 'Private workspace storage is not configured. Check the server connection settings.',
      migrated: 'This workspace has moved to Supabase. Restore its Supabase connection to continue.',
      response: 'The saved workspace could not be validated. No empty workspace or fallback was substituted.',
      unavailable: 'Private workspace storage is unavailable. Please retry.',
    }[code]);
    this.name = 'WorkspaceStorageError';
  }
}
export function workspaceStorageMessage(error: unknown): string {
  return error instanceof WorkspaceStorageError || error instanceof SupabaseWorkspaceError
    ? error.message : 'Private workspace storage is unavailable. Please retry.';
}
function decode(row: {data:string;revision:number} | null): StoredWorkspace | null {
  if (!row) return null;
  try {
    const data = workspaceSchema.parse(JSON.parse(row.data));
    if (!Number.isSafeInteger(row.revision) || row.revision < 1) throw new Error();
    return {data, revision:row.revision};
  } catch { throw new WorkspaceStorageError('response'); }
}
function sourceRow(db: D1Database, ownerId: string) {
  return db.prepare('SELECT data, revision FROM workspaces WHERE owner_id = ?').bind(ownerId).first<{data:string;revision:number}>();
}
function d1Store(db: D1Database): WorkspaceStore {
  return {
    async get(ownerId) {
      const locked = await db.prepare('SELECT owner_id FROM workspace_storage_locks WHERE owner_id = ?').bind(ownerId).first();
      if (locked) throw new WorkspaceStorageError('migrated');
      return decode(await sourceRow(db, ownerId));
    },
    async save(ownerId, data, expectedRevision) {
      const now = new Date().toISOString(), encoded = JSON.stringify(data);
      // The database trigger independently enforces migration locks, including
      // for old Worker versions which never checked workspace_storage_locks.
      const result = expectedRevision === 0
        ? await db.prepare('INSERT OR IGNORE INTO workspaces (owner_id, data, revision, updated_at) VALUES (?, ?, 1, ?)').bind(ownerId,encoded,now).run()
        : await db.prepare('UPDATE workspaces SET data = ?, revision = revision + 1, updated_at = ? WHERE owner_id = ? AND revision = ?').bind(encoded,now,ownerId,expectedRevision).run();
      return result.meta.changes === 1 ? {data,revision:expectedRevision+1} : null;
    },
  };
}
function legacySource(db: D1Database): LegacyWorkspaceSource {
  return {
    async freeze(ownerId, target) {
      await db.prepare('INSERT INTO workspace_storage_locks (owner_id, target, locked_at) VALUES (?, ?, ?) ON CONFLICT(owner_id) DO NOTHING').bind(ownerId,target,new Date().toISOString()).run();
      const lock = await db.prepare('SELECT target FROM workspace_storage_locks WHERE owner_id = ?').bind(ownerId).first<{target:string}>();
      if (!lock || lock.target !== target) throw new WorkspaceStorageError('configuration');
      return decode(await sourceRow(db,ownerId));
    },
  };
}
export function configuredWorkspaceProvider(): 'd1' | 'supabase' {
  const provider = env.WORKSPACE_STORAGE_PROVIDER || 'd1';
  if (provider !== 'd1' && provider !== 'supabase') throw new WorkspaceStorageError('configuration');
  return provider;
}
export function configuredSupabaseStore() {
  return createSupabaseWorkspaceStore({url:env.SUPABASE_URL || '',secretKey:env.SUPABASE_SECRET_KEY || ''});
}
export function getWorkspaceStore(): WorkspaceStore {
  const provider = configuredWorkspaceProvider();
  if (!env.DB) throw new WorkspaceStorageError('configuration');
  if (provider === 'd1') return d1Store(env.DB);
  return createMigratingWorkspaceStore(configuredSupabaseStore(),legacySource(env.DB),HISABFLOW_SUPABASE_URL);
}
