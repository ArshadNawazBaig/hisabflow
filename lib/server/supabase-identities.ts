import { AuthIdentityError, checkedFlow, checkedHash, checkedId, checkedTime, type IdentityStore, type OAuthFlow } from './auth-identities.ts';
import { HISABFLOW_SUPABASE_URL } from './supabase-workspace.ts';

export type SupabaseIdentityConfig = {
  url: string;
  secretKey: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
};

const MAX_RESPONSE_BYTES = 16 * 1024;
type LinkRow = { google_user_id: string; owner_id: string };

function unavailable(): never { throw new AuthIdentityError('unavailable'); }

function credentialHeaders(key: string): Record<string, string> {
  if (typeof key !== 'string' || !key || key !== key.trim() || /\s/.test(key)) return unavailable();
  const headers: Record<string, string> = {
    apikey: key, Accept: 'application/json', 'Accept-Profile': 'public', 'Content-Profile': 'public',
  };
  if (/^sb_secret_[A-Za-z0-9_-]+$/.test(key)) return headers;
  try {
    const parts = key.split('.');
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return unavailable();
    const encoded = parts[1].replaceAll('-', '+').replaceAll('_', '/');
    const payload = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '='))) as { role?: unknown };
    if (payload.role !== 'service_role') return unavailable();
    headers.Authorization = `Bearer ${key}`;
    return headers;
  } catch { return unavailable(); }
}

function oneRow(value: unknown): Record<string, unknown> | null {
  if (!Array.isArray(value) || value.length > 1) return unavailable();
  if (value.length === 0) return null;
  const row: unknown = value[0];
  if (!row || typeof row !== 'object' || Array.isArray(row)) return unavailable();
  return row as Record<string, unknown>;
}

function checkedLink(value: Record<string, unknown>): LinkRow {
  try { return { google_user_id: checkedId(value.google_user_id), owner_id: checkedId(value.owner_id) }; }
  catch { return unavailable(); }
}

/** Privileged identity and one-use OAuth state stay on the approved server endpoint. */
export function createSupabaseIdentityStore(config: SupabaseIdentityConfig): IdentityStore {
  let origin: URL;
  try {
    origin = new URL(config.url);
    if (origin.origin !== HISABFLOW_SUPABASE_URL || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return unavailable();
  } catch { return unavailable(); }
  const headers = credentialHeaders(config.secretKey);
  const timeoutMs = config.timeoutMs ?? 15_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) return unavailable();
  const fetcher = config.fetcher ?? fetch;

  async function request(url: URL, body?: Record<string, unknown>, identityConflict = false): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new AuthIdentityError('unavailable')); }, timeoutMs);
    });
    const operation = async () => {
      const response = await fetcher(url.toString(), {
        method: body ? 'POST' : 'GET',
        headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        cache: 'no-store', redirect: 'manual', signal: controller.signal,
      });
      // Never read remote error bodies, which can contain private identity values.
      if (!response.ok) {
        if (identityConflict && response.status === 409) throw new AuthIdentityError('conflict');
        return unavailable();
      }
      if (Number(response.headers.get('content-length') || '0') > MAX_RESPONSE_BYTES) {
        await response.body?.cancel().catch(() => {});
        return unavailable();
      }
      const reader = response.body?.getReader();
      if (!reader) return unavailable();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > MAX_RESPONSE_BYTES) {
            await reader.cancel().catch(() => {});
            return unavailable();
          }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
      catch { return unavailable(); }
    };
    try { return await Promise.race([operation(), expired]); }
    catch (error) {
      if (error instanceof AuthIdentityError) throw error;
      return unavailable();
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }

  async function find(column: 'google_user_id' | 'owner_id', value: string): Promise<LinkRow | null> {
    checkedId(value);
    const url = new URL('/rest/v1/hisabflow_auth_identity_links', origin);
    url.searchParams.set('select', 'google_user_id,owner_id');
    // A standalone equality filter keeps punctuation inside its bound value.
    url.searchParams.set(column, `eq.${value}`);
    url.searchParams.set('limit', '2');
    const row = oneRow(await request(url));
    if (!row) return null;
    const link = checkedLink(row);
    if (link[column] !== value) return unavailable();
    return link;
  }

  return {
    async getOwnerForGoogle(googleUserId) { return (await find('google_user_id', googleUserId))?.owner_id ?? null; },
    async getGoogleForOwner(ownerId) { return (await find('owner_id', ownerId))?.google_user_id ?? null; },
    async linkGoogleToOwner(googleUserId, ownerId) {
      checkedId(googleUserId); checkedId(ownerId);
      // Both unique constraints are checked inside one transaction by this RPC.
      const row = oneRow(await request(new URL('/rest/v1/rpc/hisabflow_link_google_identity', origin), {
        p_google_user_id: googleUserId, p_owner_id: ownerId,
      }, true));
      if (!row) return unavailable();
      const link = checkedLink(row);
      if (link.google_user_id !== googleUserId || link.owner_id !== ownerId) return unavailable();
    },
    async createFlow(flow) {
      const checked = checkedFlow(flow);
      const saved = await request(new URL('/rest/v1/rpc/hisabflow_create_oauth_flow', origin), {
        p_nonce_hash: checked.nonceHash, p_intent: checked.intent, p_sites_owner_id: checked.sitesOwnerId,
        p_expires_at: checked.expiresAt, p_created_at: checked.createdAt,
      });
      if (saved !== true) return unavailable();
    },
    async consumeFlow(nonceHash, now) {
      checkedHash(nonceHash); checkedTime(now);
      // DELETE RETURNING runs atomically; no separate read can replay a nonce.
      const row = oneRow(await request(new URL('/rest/v1/rpc/hisabflow_consume_oauth_flow', origin), {
        p_nonce_hash: nonceHash, p_now: now,
      }));
      if (!row) return null;
      let flow: OAuthFlow;
      try {
        flow = checkedFlow({
          nonceHash: row.nonce_hash as string, intent: row.intent as OAuthFlow['intent'],
          sitesOwnerId: row.sites_owner_id as string | null,
          expiresAt: row.expires_at as number, createdAt: row.created_at as number,
        });
      } catch { return unavailable(); }
      if (flow.nonceHash !== nonceHash) return unavailable();
      return flow.expiresAt <= now || flow.createdAt > now ? null : flow;
    },
  };
}
