import type { StoredWorkspace, SupabaseWorkspaceStore, WorkspaceStore } from './supabase-workspace.ts';

export interface LegacyWorkspaceSource {
  /** Freeze writes at the database level before reading the latest source row. */
  freeze(ownerId: string, target: string): Promise<StoredWorkspace | null>;
}

/** Source locks persist after failures so retries cannot copy a moving snapshot. */
export function createMigratingWorkspaceStore(primary: SupabaseWorkspaceStore, legacy: LegacyWorkspaceSource, target: string): WorkspaceStore {
  const prepared = new Set<string>();
  async function get(ownerId: string): Promise<StoredWorkspace | null> {
    // Verify connectivity, credentials and schema before freezing legacy writes.
    const existing = await primary.get(ownerId);
    const source = await legacy.freeze(ownerId, target);
    const result = existing ?? (source ? await primary.insertExisting(ownerId, source) : null);
    prepared.add(ownerId);
    return result;
  }
  return {
    get,
    async save(ownerId, data, expectedRevision) {
      if (!prepared.has(ownerId)) await get(ownerId);
      return primary.save(ownerId, data, expectedRevision);
    },
  };
}
