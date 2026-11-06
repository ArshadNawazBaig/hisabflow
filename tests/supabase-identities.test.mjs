import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthIdentityError } from '../lib/server/auth-identities.ts';
import { createSupabaseIdentityStore } from '../lib/server/supabase-identities.ts';
import { HISABFLOW_SUPABASE_URL } from '../lib/server/supabase-workspace.ts';

const secret = 'sb_secret_unit_test_only_not_a_real_key';
const now = Date.UTC(2026, 10, 6, 12, 0);
const hash = 'a'.repeat(64);
const pending = () => ({ nonceHash: hash, intent: 'signin', sitesOwnerId: null, createdAt: now, expiresAt: now + 600_000 });
const row = (flow = pending()) => ({ nonce_hash: flow.nonceHash, intent: flow.intent, sites_owner_id: flow.sitesOwnerId, created_at: flow.createdAt, expires_at: flow.expiresAt });
const link = (google = 'google-A', owner = 'supabase:google-A') => ({ google_user_id: google, owner_id: owner });
const jwt = role => [Buffer.from('{"alg":"HS256"}').toString('base64url'), Buffer.from(JSON.stringify({ role })).toString('base64url'), 'test_signature'].join('.');
function mock(responses) {
  const calls = [];
  const fetcher = async (input, init) => {
    calls.push({ url: new URL(String(input)), init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next(input, init);
    return next instanceof Response ? next : Response.json(next);
  };
  return { calls, fetcher };
}
const make = fetcher => createSupabaseIdentityStore({ url: HISABFLOW_SUPABASE_URL, secretKey: secret, fetcher });
const unavailable = error => error instanceof AuthIdentityError && error.code === 'unavailable';

test('identity reads retain reserved owner characters in one encoded exact filter', async () => {
  const difficult = 'owner.&or=(owner_id.neq.any),"name"/\\folder:tag+%26/اردو';
  const { calls, fetcher } = mock([[link('google-A', difficult)], [link('google-A', difficult)], []]);
  const store = make(fetcher);
  assert.equal(await store.getGoogleForOwner(difficult), 'google-A');
  assert.equal(await store.getOwnerForGoogle('google-A'), difficult);
  assert.equal(await store.getOwnerForGoogle('missing'), null);
  const call = calls[0];
  assert.equal(call.url.origin, HISABFLOW_SUPABASE_URL);
  assert.equal(call.url.pathname, '/rest/v1/hisabflow_auth_identity_links');
  assert.deepEqual([...call.url.searchParams.keys()].sort(), ['limit', 'owner_id', 'select']);
  assert.equal(call.url.searchParams.get('owner_id'), 'eq.' + difficult);
  assert.equal(call.url.searchParams.get('limit'), '2');
  assert.equal(call.init.headers.apikey, secret);
  assert.equal(call.init.headers.Authorization, undefined);
  assert.equal(call.init.cache, 'no-store');
  assert.equal(call.init.redirect, 'manual');
});

test('immutable linking uses one atomic RPC and confirms both exact returned identities', async () => {
  const { calls, fetcher } = mock([[link()]]);
  await make(fetcher).linkGoogleToOwner('google-A', 'supabase:google-A');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, '/rest/v1/rpc/hisabflow_link_google_identity');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { p_google_user_id: 'google-A', p_owner_id: 'supabase:google-A' });
  for (const response of [[], [link('other')], [link('google-A', 'other')], [link(), link()]]) {
    await assert.rejects(make(mock([response]).fetcher).linkGoogleToOwner('google-A', 'supabase:google-A'), unavailable);
  }
});

test('only the immutable-link RPC maps a conflict to the fixed identity conflict message', async () => {
  const response = () => new Response('private raw identity and SQL conflict detail', { status: 409 });
  const { calls, fetcher } = mock([response()]);
  await assert.rejects(make(fetcher).linkGoogleToOwner('google-A', 'supabase:google-A'), error => {
    assert.equal(error.code, 'conflict');
    assert.equal(error.message.includes('private raw identity'), false);
    return true;
  });
  assert.equal(calls.length, 1);
  await assert.rejects(make(mock([response()]).fetcher).createFlow(pending()), unavailable);
});

test('nonce creation uses the bounded hashed flow and preserves explicit owner-binding semantics', async () => {
  const { calls, fetcher } = mock([true, true]);
  const store = make(fetcher);
  await store.createFlow(pending());
  const explicit = { ...pending(), intent: 'link', sitesOwnerId: 'legacy:explicit-owner' };
  await store.createFlow(explicit);
  assert.equal(calls[0].url.pathname, '/rest/v1/rpc/hisabflow_create_oauth_flow');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    p_nonce_hash: hash, p_intent: 'signin', p_sites_owner_id: null, p_created_at: now, p_expires_at: now + 600_000,
  });
  assert.equal(JSON.parse(calls[1].init.body).p_sites_owner_id, explicit.sitesOwnerId);
  await assert.rejects(make(mock([null]).fetcher).createFlow(pending()), unavailable);
});

test('OAuth consumption uses one delete-and-return RPC without a separate replayable read', async () => {
  const { calls, fetcher } = mock([[row()], []]);
  const store = make(fetcher);
  assert.deepEqual(await store.consumeFlow(hash, now + 1), pending());
  assert.equal(await store.consumeFlow(hash, now + 2), null);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url.pathname, '/rest/v1/rpc/hisabflow_consume_oauth_flow');
    assert.equal(call.init.method, 'POST');
    assert.equal(JSON.parse(call.init.body).p_nonce_hash, hash);
  }
  assert.deepEqual(JSON.parse(calls[0].init.body), { p_nonce_hash: hash, p_now: now + 1 });
});

test('expired, future, wrong-nonce and malformed consumed responses never authorize a callback', async () => {
  assert.equal(await make(mock([[row()]]).fetcher).consumeFlow(hash, now + 600_000), null);
  assert.equal(await make(mock([[row()]]).fetcher).consumeFlow(hash, now - 1), null);
  for (const response of [
    [row({ ...pending(), nonceHash: 'b'.repeat(64) })],
    [row({ ...pending(), intent: 'signin', sitesOwnerId: 'unexpected-owner' })],
    [row({ ...pending(), expiresAt: now + 600_001 })],
    [row({ ...pending(), createdAt: String(now) })],
    [row(), row()], {}, [null],
  ]) await assert.rejects(make(mock([response]).fetcher).consumeFlow(hash, now + 1), unavailable);
});

test('untrusted or ambiguous identity responses are rejected rather than claiming a workspace', async () => {
  for (const response of [[link('other')], [link('google-A', '')], [link(), link()], [null], {}]) {
    await assert.rejects(make(mock([response]).fetcher).getOwnerForGoogle('google-A'), unavailable);
  }
});

test('malformed submitted identity and flow values fail before network access', async () => {
  let calls = 0;
  const store = make(async () => { calls++; return Response.json([]); });
  for (const value of ['', ' ', 'x'.repeat(201), 'line\nbreak']) {
    await assert.rejects(store.getOwnerForGoogle(value), error => error.code === 'invalid-data');
    await assert.rejects(store.getGoogleForOwner(value), error => error.code === 'invalid-data');
    await assert.rejects(store.linkGoogleToOwner('google-A', value), error => error.code === 'invalid-data');
  }
  for (const flow of [
    { ...pending(), nonceHash: 'raw-cookie-nonce' },
    { ...pending(), expiresAt: now },
    { ...pending(), expiresAt: now + 600_001 },
    { ...pending(), sitesOwnerId: 'unexpected-owner' },
    { ...pending(), intent: 'link' },
  ]) await assert.rejects(store.createFlow(flow), error => error.code === 'invalid-data');
  await assert.rejects(store.consumeFlow('bad-hash', now), error => error.code === 'invalid-data');
  await assert.rejects(store.consumeFlow(hash, NaN), error => error.code === 'invalid-data');
  assert.equal(calls, 0);
});

test('only fixed project URLs and server-only credentials are accepted', () => {
  let calls = 0;
  const fetcher = async () => { calls++; return Response.json([]); };
  for (const url of ['https://other.example', HISABFLOW_SUPABASE_URL + '/rest/v1', HISABFLOW_SUPABASE_URL + '?key=bad', HISABFLOW_SUPABASE_URL + '#fragment', 'https://user:pass@coeazyvaghocoxuzngcc.supabase.co']) {
    assert.throws(() => createSupabaseIdentityStore({ url, secretKey: secret, fetcher }), unavailable);
  }
  for (const secretKey of ['', 'sb_publishable_test', jwt('anon'), jwt('authenticated'), 'not-a-key', secret + ' ', 'sb_secret_line\nbreak']) {
    assert.throws(() => createSupabaseIdentityStore({ url: HISABFLOW_SUPABASE_URL, secretKey, fetcher }), unavailable);
  }
  assert.equal(calls, 0);
});

test('legacy service-role JWT credentials send both required headers', async () => {
  const key = jwt('service_role'), { calls, fetcher } = mock([[]]);
  const store = createSupabaseIdentityStore({ url: HISABFLOW_SUPABASE_URL + '/', secretKey: key, fetcher });
  assert.equal(await store.getOwnerForGoogle('google-A'), null);
  assert.equal(calls[0].init.headers.apikey, key);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${key}`);
});

test('redirects, failed requests and non-JSON responses fail once without leaking remote details', async () => {
  for (const response of [
    new Response(null, { status: 307, headers: { Location: 'https://other.example/private' } }),
    new Response('private-owner-token SQL error', { status: 500 }),
    new Response('private-owner-token not json'),
    new Error('private-owner-token transport error'),
  ]) {
    const { calls, fetcher } = mock([response]);
    await assert.rejects(make(fetcher).getOwnerForGoogle('google-A'), error => unavailable(error) && !error.message.includes('private-owner-token'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.redirect, 'manual');
    assert.equal(calls[0].url.origin, HISABFLOW_SUPABASE_URL);
  }
});

test('oversized declared and streamed responses are bounded and never treated as identity rows', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(17 * 1024)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(make(mock([new Response(stream)]).fetcher).getOwnerForGoogle('google-A'), unavailable);
  assert.equal(cancelled, true);
  await assert.rejects(make(mock([new Response('[]', { headers: { 'Content-Length': String(17 * 1024) } })]).fetcher).getOwnerForGoogle('google-A'), unavailable);
});

test('timeout aborts the request without retrying or exposing identity or credential values', async () => {
  let calls = 0, signal;
  const store = createSupabaseIdentityStore({
    url: HISABFLOW_SUPABASE_URL, secretKey: secret, timeoutMs: 5,
    fetcher: async (_input, init) => { calls++; signal = init.signal; return new Promise(() => {}); },
  });
  await assert.rejects(store.getOwnerForGoogle('private-owner-token'), error => unavailable(error) && !error.message.includes(secret) && !error.message.includes('private-owner-token'));
  assert.equal(calls, 1);
  assert.equal(signal.aborted, true);
});
