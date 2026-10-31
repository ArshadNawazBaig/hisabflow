export type AuthIdentityErrorCode = 'invalid-data' | 'conflict' | 'unavailable';

const messages: Record<AuthIdentityErrorCode, string> = {
  'invalid-data': 'The sign-in request is invalid. Please start again.',
  conflict: 'This Google account or workspace is already linked to a different account.',
  unavailable: 'Sign-in storage is temporarily unavailable. Please retry.',
};

/** Database errors and submitted identity values never leave this boundary. */
export class AuthIdentityError extends Error {
  readonly code: AuthIdentityErrorCode;
  constructor(code: AuthIdentityErrorCode) {
    super(messages[code]);
    this.name = 'AuthIdentityError';
    this.code = code;
  }
}

export type OAuthFlow = {
  nonceHash: string;
  intent: 'signin' | 'link';
  sitesOwnerId: string | null;
  expiresAt: number;
  createdAt: number;
};

export interface IdentityStore {
  getOwnerForGoogle(googleUserId: string): Promise<string | null>;
  getGoogleForOwner(ownerId: string): Promise<string | null>;
  /** Linking is immutable: the exact existing pair is idempotent. */
  linkGoogleToOwner(googleUserId: string, ownerId: string): Promise<void>;
  createFlow(flow: OAuthFlow): Promise<void>;
  /** Delete-and-return makes the flow one-use, including concurrent callbacks. */
  consumeFlow(nonceHash: string, now: number): Promise<OAuthFlow | null>;
}

type LinkRow = { google_user_id: unknown; owner_id: unknown };
type FlowRow = {
  nonce_hash: unknown;
  intent: unknown;
  sites_owner_id: unknown;
  expires_at: unknown;
  created_at: unknown;
};

function checkedId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new AuthIdentityError('invalid-data');
  }
  return value;
}
function checkedHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new AuthIdentityError('invalid-data');
  return value;
}
function checkedTime(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new AuthIdentityError('invalid-data');
  return value;
}
function checkedFlow(value: OAuthFlow): OAuthFlow {
  const nonceHash = checkedHash(value?.nonceHash);
  const createdAt = checkedTime(value?.createdAt), expiresAt = checkedTime(value?.expiresAt);
  if (expiresAt <= createdAt || expiresAt - createdAt > 600_000) throw new AuthIdentityError('invalid-data');
  if (value.intent === 'signin' && value.sitesOwnerId === null) {
    return { nonceHash, intent: value.intent, sitesOwnerId: null, createdAt, expiresAt };
  }
  if (value.intent === 'link') {
    return { nonceHash, intent: value.intent, sitesOwnerId: checkedId(value.sitesOwnerId), createdAt, expiresAt };
  }
  throw new AuthIdentityError('invalid-data');
}

/** Uses the retained D1 database only for immutable identity links and OAuth state. */
export function createIdentityStore(db: Pick<D1Database, 'prepare'>): IdentityStore {
  if (!db || typeof db.prepare !== 'function') throw new AuthIdentityError('unavailable');

  async function guarded<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof AuthIdentityError) throw error;
      throw new AuthIdentityError('unavailable');
    }
  }

  async function getOwnerForGoogle(googleUserId: string): Promise<string | null> {
    checkedId(googleUserId);
    return guarded(async () => {
      const row = await db.prepare('SELECT google_user_id, owner_id FROM auth_identity_links WHERE google_user_id = ?').bind(googleUserId).first<LinkRow>();
      if (!row) return null;
      if (row.google_user_id !== googleUserId) throw new AuthIdentityError('unavailable');
      return checkedId(row.owner_id);
    });
  }

  async function getGoogleForOwner(ownerId: string): Promise<string | null> {
    checkedId(ownerId);
    return guarded(async () => {
      const row = await db.prepare('SELECT google_user_id, owner_id FROM auth_identity_links WHERE owner_id = ?').bind(ownerId).first<LinkRow>();
      if (!row) return null;
      if (row.owner_id !== ownerId) throw new AuthIdentityError('unavailable');
      return checkedId(row.google_user_id);
    });
  }

  async function linkGoogleToOwner(googleUserId: string, ownerId: string): Promise<void> {
    checkedId(googleUserId); checkedId(ownerId);
    await guarded(async () => {
      // Both unique keys are authoritative. Never update or reassign on conflict.
      await db.prepare('INSERT INTO auth_identity_links (google_user_id, owner_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').bind(googleUserId, ownerId, new Date().toISOString()).run();
      const linkedOwner = await getOwnerForGoogle(googleUserId);
      const linkedGoogle = await getGoogleForOwner(ownerId);
      if (linkedOwner !== ownerId || linkedGoogle !== googleUserId) throw new AuthIdentityError('conflict');
    });
  }

  async function createFlow(flow: OAuthFlow): Promise<void> {
    const checked = checkedFlow(flow);
    await guarded(async () => {
      // The indexed cleanup cannot remove any still-valid flow.
      await db.prepare('DELETE FROM auth_oauth_flows WHERE expires_at <= ?').bind(checked.createdAt).run();
      await db.prepare('INSERT INTO auth_oauth_flows (nonce_hash, intent, sites_owner_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)').bind(checked.nonceHash, checked.intent, checked.sitesOwnerId, checked.expiresAt, checked.createdAt).run();
    });
  }

  async function consumeFlow(nonceHash: string, now: number): Promise<OAuthFlow | null> {
    checkedHash(nonceHash); checkedTime(now);
    return guarded(async () => {
      const row = await db.prepare('DELETE FROM auth_oauth_flows WHERE nonce_hash = ? RETURNING nonce_hash, intent, sites_owner_id, expires_at, created_at').bind(nonceHash).first<FlowRow>();
      if (!row) return null;
      if (row.nonce_hash !== nonceHash) throw new AuthIdentityError('unavailable');
      const flow = checkedFlow({ nonceHash: row.nonce_hash as string, intent: row.intent as OAuthFlow['intent'], sitesOwnerId: row.sites_owner_id as string | null, expiresAt: row.expires_at as number, createdAt: row.created_at as number });
      if (flow.expiresAt <= now || flow.createdAt > now) return null;
      return flow;
    });
  }

  return { getOwnerForGoogle, getGoogleForOwner, linkGoogleToOwner, createFlow, consumeFlow };
}
