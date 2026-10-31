import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { AuthIdentityError, createIdentityStore } from '../lib/server/auth-identities.ts';

const migrationDirectory = new URL('../drizzle/', import.meta.url);
const now = Date.UTC(2026, 9, 31, 12, 0);
const hash = letter => letter.repeat(64);
const flow = (overrides = {}) => ({ nonceHash: hash('a'), intent: 'link', sitesOwnerId: 'sites-owner-A', createdAt: now, expiresAt: now + 600_000, ...overrides });

function database() {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of readdirSync(migrationDirectory).filter(name => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(file, migrationDirectory), 'utf8'));
  }
  const db = {
    prepare(sql) {
      let bindings = [];
      return {
        bind(...values) { bindings = values; return this; },
        async first() { return sqlite.prepare(sql).get(...bindings) ?? null; },
        async run() { return { meta: { changes: sqlite.prepare(sql).run(...bindings).changes } }; },
      };
    },
  };
  return { sqlite, store: createIdentityStore(db) };
}

test('an explicit Google link keeps the original owner and existing workspace unchanged', async () => {
  const { sqlite, store } = database();
  try {
    sqlite.prepare('INSERT INTO workspaces(owner_id,data,revision,updated_at) VALUES(?,?,?,?)').run('sites-owner-A', '{"fixture":"No business data"}', 8, '2026-10-31');
    const before = sqlite.prepare('SELECT * FROM workspaces').get();
    assert.equal(await store.getOwnerForGoogle('google-A'), null);
    await store.linkGoogleToOwner('google-A', 'sites-owner-A');
    assert.equal(await store.getOwnerForGoogle('google-A'), 'sites-owner-A');
    assert.equal(await store.getGoogleForOwner('sites-owner-A'), 'google-A');
    assert.deepEqual(sqlite.prepare('SELECT * FROM workspaces').get(), before);
  } finally { sqlite.close(); }
});

test('linking the same exact pair is idempotent and preserves its original creation record', async () => {
  const { sqlite, store } = database();
  try {
    await store.linkGoogleToOwner('google-A', 'sites-owner-A');
    const before = sqlite.prepare('SELECT * FROM auth_identity_links').get();
    await store.linkGoogleToOwner('google-A', 'sites-owner-A');
    assert.deepEqual(sqlite.prepare('SELECT * FROM auth_identity_links').all(), [before]);
  } finally { sqlite.close(); }
});

test('neither side of an existing link can be reassigned or silently merged', async () => {
  const { sqlite, store } = database();
  try {
    await store.linkGoogleToOwner('google-A', 'supabase:google-A');
    const before = sqlite.prepare('SELECT * FROM auth_identity_links').all();
    for (const pair of [['google-A', 'sites-owner-A'], ['google-B', 'supabase:google-A']]) {
      await assert.rejects(store.linkGoogleToOwner(...pair), error => error instanceof AuthIdentityError && error.code === 'conflict');
    }
    assert.deepEqual(sqlite.prepare('SELECT * FROM auth_identity_links').all(), before);
    assert.equal(await store.getOwnerForGoogle('google-B'), null);
    assert.equal(await store.getGoogleForOwner('sites-owner-A'), null);
  } finally { sqlite.close(); }
});

test('concurrent conflicting callbacks converge on one immutable owner link', async () => {
  const { sqlite, store } = database();
  try {
    const outcomes = await Promise.allSettled([
      store.linkGoogleToOwner('google-A', 'sites-owner-A'),
      store.linkGoogleToOwner('google-B', 'sites-owner-A'),
    ]);
    assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
    const failure = outcomes.find(outcome => outcome.status === 'rejected');
    assert.equal(failure.reason.code, 'conflict');
    const rows = sqlite.prepare('SELECT * FROM auth_identity_links').all();
    assert.equal(rows.length, 1);
    assert.equal(await store.getGoogleForOwner('sites-owner-A'), rows[0].google_user_id);
    assert.equal(await store.getOwnerForGoogle(rows[0].google_user_id), 'sites-owner-A');
  } finally { sqlite.close(); }
});

test('identity values remain bound parameters rather than widening an ownership lookup', async () => {
  const { sqlite, store } = database();
  try {
    const google = 'google-A\' OR 1=1 --', owner = 'owner,&or=(owner_id.neq.any):"+%26/اردو';
    await store.linkGoogleToOwner(google, owner);
    assert.equal(await store.getOwnerForGoogle(google), owner);
    assert.equal(await store.getOwnerForGoogle('google-A'), null);
    assert.equal(await store.getGoogleForOwner(owner), google);
    assert.equal(await store.getGoogleForOwner('owner'), null);
  } finally { sqlite.close(); }
});

test('OAuth state is consumed once even when two callbacks race', async () => {
  const { sqlite, store } = database();
  try {
    const pending = flow(); await store.createFlow(pending);
    const results = await Promise.all([store.consumeFlow(pending.nonceHash, now + 1), store.consumeFlow(pending.nonceHash, now + 1)]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.deepEqual(results.find(Boolean), pending);
    assert.equal(await store.consumeFlow(pending.nonceHash, now + 2), null);
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM auth_oauth_flows').get().n, 0);
  } finally { sqlite.close(); }
});

test('expired or not-yet-valid OAuth state cannot be used and is still consumed', async () => {
  const { sqlite, store } = database();
  try {
    const expired = flow(); await store.createFlow(expired);
    assert.equal(await store.consumeFlow(expired.nonceHash, expired.expiresAt), null);
    assert.equal(await store.consumeFlow(expired.nonceHash, now + 1), null);
    const future = flow({ nonceHash: hash('b'), createdAt: now + 10, expiresAt: now + 100 });
    await store.createFlow(future);
    assert.equal(await store.consumeFlow(future.nonceHash, now), null);
    assert.equal(await store.consumeFlow(future.nonceHash, now + 11), null);
  } finally { sqlite.close(); }
});

test('sign-in and explicit linking preserve their distinct owner-binding semantics', async () => {
  const { sqlite, store } = database();
  try {
    const signin = flow({ intent: 'signin', sitesOwnerId: null });
    await store.createFlow(signin);
    assert.deepEqual(await store.consumeFlow(signin.nonceHash, now), signin);
    for (const invalid of [
      flow({ sitesOwnerId: null }),
      flow({ intent: 'signin' }),
      flow({ intent: 'reassign' }),
      flow({ nonceHash: 'raw-cookie-token' }),
      flow({ expiresAt: now }),
      flow({ expiresAt: now + 600_001 }),
      flow({ createdAt: NaN }),
    ]) await assert.rejects(store.createFlow(invalid), error => error.code === 'invalid-data');
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM auth_oauth_flows').get().n, 0);
  } finally { sqlite.close(); }
});

test('duplicate nonce creation cannot overwrite another pending link intent', async () => {
  const { sqlite, store } = database();
  try {
    const pending = flow(); await store.createFlow(pending);
    await assert.rejects(store.createFlow(flow({ sitesOwnerId: 'sites-owner-B' })), error => error.code === 'unavailable');
    assert.deepEqual(await store.consumeFlow(pending.nonceHash, now + 1), pending);
  } finally { sqlite.close(); }
});

test('creating a new flow removes only already-expired state', async () => {
  const { sqlite, store } = database();
  try {
    await store.createFlow(flow({ expiresAt: now + 1 }));
    const retained = flow({ nonceHash: hash('b') }); await store.createFlow(retained);
    const next = flow({ nonceHash: hash('c'), createdAt: now + 2, expiresAt: now + 100 }); await store.createFlow(next);
    assert.equal(await store.consumeFlow(hash('a'), now + 2), null);
    assert.deepEqual(await store.consumeFlow(retained.nonceHash, now + 2), retained);
    assert.deepEqual(await store.consumeFlow(next.nonceHash, now + 2), next);
  } finally { sqlite.close(); }
});

test('malformed identities fail before database access and raw database errors are sanitized', async () => {
  let queried = 0;
  const store = createIdentityStore({ prepare() { queried++; throw new Error('SQL error containing private-owner-token'); } });
  for (const invalid of ['', ' ', 'x'.repeat(201), 'line\nbreak']) {
    await assert.rejects(store.getOwnerForGoogle(invalid), error => error.code === 'invalid-data');
    await assert.rejects(store.getGoogleForOwner(invalid), error => error.code === 'invalid-data');
    await assert.rejects(store.linkGoogleToOwner('google-A', invalid), error => error.code === 'invalid-data');
  }
  assert.equal(queried, 0);
  await assert.rejects(store.getOwnerForGoogle('google-A'), error => error instanceof AuthIdentityError && error.code === 'unavailable' && !error.message.includes('private-owner-token'));
});
