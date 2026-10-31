import type { Workspace } from '../types';
import { workspaceSchema } from '../workspace-validation.ts';

export const HISABFLOW_SUPABASE_URL = 'https://coeazyvaghocoxuzngcc.supabase.co';
const TABLE = 'hisabflow_workspaces';
const RPC = 'hisabflow_save_workspace';
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const encoder = new TextEncoder();

export type StoredWorkspace = { data: Workspace; revision: number };
export interface WorkspaceStore {
  get(ownerId: string): Promise<StoredWorkspace | null>;
  /** A null result means another writer already changed this owner's revision. */
  save(ownerId: string, data: Workspace, expectedRevision: number): Promise<StoredWorkspace | null>;
}
export interface SupabaseWorkspaceStore extends WorkspaceStore {
  /** Insert-only migration: an existing Supabase workspace always remains authoritative. */
  insertExisting(ownerId: string, stored: StoredWorkspace): Promise<StoredWorkspace>;
}

export type SupabaseWorkspaceConfig = {
  url: string;
  secretKey: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
};
type StorageErrorCode = 'configuration' | 'invalid-data' | 'permissions' | 'schema' | 'response' | 'unavailable' | 'timeout';
const errorMessages: Record<StorageErrorCode, string> = {
  configuration: 'Configure the approved Supabase project URL and a server-only secret key.',
  'invalid-data': 'Workspace data or its revision is invalid for private storage.',
  permissions: 'Supabase rejected the server credential or its workspace permissions.',
  schema: 'The Supabase workspace schema is not ready. Apply the HisabFlow migration.',
  response: 'Supabase returned an invalid workspace response. No fallback was used.',
  unavailable: 'Supabase workspace storage is temporarily unavailable. No retry was attempted.',
  timeout: 'The Supabase request timed out. No retry was attempted.',
};

/** Only fixed messages leave this boundary; remote bodies and credential values are never exposed. */
export class SupabaseWorkspaceError extends Error {
  readonly code: StorageErrorCode;
  constructor(code: StorageErrorCode) {
    super(errorMessages[code]);
    this.name = 'SupabaseWorkspaceError';
    this.code = code;
  }
}

function validRevision(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}
function checkedOwner(ownerId: string): string {
  if (typeof ownerId !== 'string' || !ownerId.trim() || ownerId.length > 200 || /[\u0000-\u001f\u007f]/.test(ownerId)) {
    throw new SupabaseWorkspaceError('invalid-data');
  }
  return ownerId;
}
function checkedWorkspace(data: unknown): Workspace {
  const parsed = workspaceSchema.safeParse(data);
  if (!parsed.success) throw new SupabaseWorkspaceError('invalid-data');
  return parsed.data as Workspace;
}
function checkedStored(value: unknown, ownerId?: string): StoredWorkspace {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SupabaseWorkspaceError('response');
  const row = value as Record<string, unknown>;
  if (ownerId !== undefined && row.owner_id !== ownerId) throw new SupabaseWorkspaceError('response');
  if (!validRevision(row.revision, 1)) throw new SupabaseWorkspaceError('response');
  try { return { data: checkedWorkspace(row.data), revision: row.revision }; }
  catch { throw new SupabaseWorkspaceError('response'); }
}
function oneRow(value: unknown, ownerId?: string): StoredWorkspace | null {
  if (!Array.isArray(value) || value.length > 1) throw new SupabaseWorkspaceError('response');
  return value.length === 0 ? null : checkedStored(value[0], ownerId);
}
function canonical(value: unknown): string {
  const sorted = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(sorted);
    if (entry && typeof entry === 'object') {
      const object = entry as Record<string, unknown>;
      return Object.fromEntries(Object.keys(object).filter(key => object[key] !== undefined).sort().map(key => [key, sorted(object[key])]));
    }
    return entry;
  };
  try { return JSON.stringify(sorted(value)); }
  catch { throw new SupabaseWorkspaceError('invalid-data'); }
}
function credentialHeaders(key: string): Record<string, string> {
  if (typeof key !== 'string' || !key || key !== key.trim() || /\s/.test(key)) throw new SupabaseWorkspaceError('configuration');
  const headers: Record<string, string> = {
    apikey: key,
    Accept: 'application/json',
    'Accept-Profile': 'public',
    'Content-Profile': 'public',
  };
  if (/^sb_secret_[A-Za-z0-9_-]+$/.test(key)) return headers;
  // Legacy keys are JWTs. Reject anon/user JWTs before sending anything to the project.
  try {
    const parts = key.split('.');
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error();
    const normalized = parts[1].replaceAll('-', '+').replaceAll('_', '/');
    const payload = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))) as { role?: unknown };
    if (payload.role !== 'service_role') throw new Error();
    headers.Authorization = `Bearer ${key}`;
    return headers;
  } catch { throw new SupabaseWorkspaceError('configuration'); }
}

/** Server-only transport. Never import this module into a client component or expose its key. */
export function createSupabaseWorkspaceStore(config: SupabaseWorkspaceConfig): SupabaseWorkspaceStore {
  let origin: URL;
  try {
    origin = new URL(config.url);
    if (origin.origin !== HISABFLOW_SUPABASE_URL || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error();
  } catch { throw new SupabaseWorkspaceError('configuration'); }
  const headers = credentialHeaders(config.secretKey);
  const timeoutMs = config.timeoutMs ?? 15_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new SupabaseWorkspaceError('configuration');
  const fetcher = config.fetcher ?? fetch;

  async function request(url: URL, method: 'GET' | 'POST', value?: unknown, extraHeaders?: Record<string, string>): Promise<unknown> {
    let body: string | undefined;
    if (value !== undefined) {
      try { body = JSON.stringify(value); }
      catch { throw new SupabaseWorkspaceError('invalid-data'); }
      if (encoder.encode(body).byteLength > MAX_REQUEST_BYTES) throw new SupabaseWorkspaceError('invalid-data');
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new SupabaseWorkspaceError('timeout')); }, timeoutMs);
    });
    const operation = async () => {
      const response = await fetcher(url.toString(), {
        method,
        headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders },
        body,
        cache: 'no-store',
        // Workers supports manual redirects; non-2xx responses fail below.
        // Never forward the privileged headers to a redirect destination.
        redirect: 'manual',
        signal: controller.signal,
      });
      if (!response.ok) {
        // Do not read, log, or echo database errors: they can include submitted business data.
        if (response.status === 401 || response.status === 403) throw new SupabaseWorkspaceError('permissions');
        if (response.status === 404) throw new SupabaseWorkspaceError('schema');
        throw new SupabaseWorkspaceError('unavailable');
      }
      if (Number(response.headers.get('content-length') || '0') > MAX_RESPONSE_BYTES) throw new SupabaseWorkspaceError('response');
      const text = await response.text();
      if (encoder.encode(text).byteLength > MAX_RESPONSE_BYTES) throw new SupabaseWorkspaceError('response');
      try { return JSON.parse(text) as unknown; }
      catch { throw new SupabaseWorkspaceError('response'); }
    };
    try { return await Promise.race([operation(), expired]); }
    catch (error) {
      if (error instanceof SupabaseWorkspaceError) throw error;
      throw new SupabaseWorkspaceError('unavailable');
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }

  function tableUrl(): URL { return new URL(`/rest/v1/${TABLE}`, origin); }
  async function get(ownerId: string): Promise<StoredWorkspace | null> {
    checkedOwner(ownerId);
    const url = tableUrl();
    url.searchParams.set('select', 'owner_id,data,revision');
    // A standalone eq filter consumes the whole value; added quotes become
    // literal owner characters. URLSearchParams keeps it in one parameter.
    url.searchParams.set('owner_id', `eq.${ownerId}`);
    url.searchParams.set('limit', '2');
    return oneRow(await request(url, 'GET'), ownerId);
  }

  async function save(ownerId: string, data: Workspace, expectedRevision: number): Promise<StoredWorkspace | null> {
    checkedOwner(ownerId);
    if (!validRevision(expectedRevision, 0) || expectedRevision === Number.MAX_SAFE_INTEGER) throw new SupabaseWorkspaceError('invalid-data');
    const checked = checkedWorkspace(data);
    const expectedData = canonical(checked);
    const url = new URL(`/rest/v1/rpc/${RPC}`, origin);
    const saved = oneRow(await request(url, 'POST', { p_owner_id: ownerId, p_data: checked, p_expected_revision: expectedRevision }));
    if (saved && (saved.revision !== expectedRevision + 1 || canonical(saved.data) !== expectedData)) throw new SupabaseWorkspaceError('response');
    return saved;
  }

  async function insertExisting(ownerId: string, stored: StoredWorkspace): Promise<StoredWorkspace> {
    checkedOwner(ownerId);
    if (!validRevision(stored?.revision, 1)) throw new SupabaseWorkspaceError('invalid-data');
    const checked = checkedWorkspace(stored.data);
    const expectedData = canonical(checked);
    const url = tableUrl();
    url.searchParams.set('on_conflict', 'owner_id');
    url.searchParams.set('select', 'owner_id,data,revision');
    const inserted = oneRow(await request(url, 'POST', {
      owner_id: ownerId, data: checked, revision: stored.revision, updated_at: new Date().toISOString(),
    }, { Prefer: 'resolution=ignore-duplicates,return=representation' }), ownerId);
    if (inserted) {
      if (inserted.revision !== stored.revision || canonical(inserted.data) !== expectedData) throw new SupabaseWorkspaceError('response');
      return inserted;
    }
    const existing = await get(ownerId);
    if (!existing) throw new SupabaseWorkspaceError('response');
    return existing;
  }

  return { get, save, insertExisting };
}
