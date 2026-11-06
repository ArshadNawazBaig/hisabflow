import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseFileStore, SupabaseFileError, MAX_PRIVATE_FILE_BYTES } from '../lib/server/supabase-files.ts';
import { createVercelFileHandlers } from '../lib/server/vercel-files.ts';
import { uploadPrivateFile } from '../lib/private-file-upload.ts';

const origin = 'https://coeazyvaghocoxuzngcc.supabase.co';
const owner = 'supabase:11111111-1111-1111-1111-111111111111';
const bytes = new TextEncoder().encode('Sanitized private document fixture.');
const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
const key = `owners/${encodeURIComponent(owner)}/${hash}/statement.pdf`;
const physicalOwner = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(owner)))].map(value => value.toString(16).padStart(2, '0')).join('');
const secret = 'sb_secret_fixture_private_server_key';
const json = value => Response.json(value);
const object = () => new Response(bytes, { headers: { 'Content-Type': 'application/pdf' } });
const make = fetcher => createSupabaseFileStore({ url: origin, secretKey: secret, fetcher });
const description = (values = {}) => ({ name: 'statement.pdf', size: bytes.byteLength, type: 'application/pdf', hash, ...values });

test('signed uploads pin the private owner path and prohibit overwriting retained originals', async () => {
  const calls = [];
  const store = make(async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'GET') return new Response(null, { status: 404 });
    return json({ url: '/object/upload/sign/hisabflow-documents/owners/fixture.pdf?token=upload-token' });
  });
  const result = await store.beginUpload(owner, description());
  assert.equal(result.key, key);
  assert.equal(result.hash, hash);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.headers['x-upsert'], 'false');
  assert.deepEqual(JSON.parse(calls[1].options.body), {});
  assert.equal(calls[1].options.headers.apikey, secret);
  assert.equal(calls[1].options.headers.Authorization, undefined);
  assert.equal(calls[1].options.redirect, 'error');
  assert.equal(calls[1].options.cache, 'no-store');
  assert.equal(new URL(result.signedUrl).origin, origin);
  assert.equal(new URL(result.signedUrl).searchParams.get('token'), 'upload-token');
  assert.ok(new URL(result.signedUrl).pathname.endsWith(`/owners/${physicalOwner}/${hash}/statement.pdf`));
  assert.equal(decodeURIComponent(new URL(result.signedUrl).pathname).includes('%'), false);
  assert.equal(result.contentType, 'application/pdf');
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('exact-file retries reuse only content whose server-computed hash matches', async () => {
  let requests = 0;
  const store = make(async () => { requests++; return object(); });
  assert.deepEqual(await store.beginUpload(owner, description()), { key, name: 'statement.pdf', hash });
  assert.equal(requests, 1);
  assert.deepEqual(await store.completeUpload(owner, { key, hash }), { key, name: 'statement.pdf', hash });
  const head = await store.verifyHead(key, owner, hash);
  assert.deepEqual(head.customMetadata, { ownerId: owner, hash, originalName: 'statement.pdf' });
  assert.equal(head.httpMetadata.contentType, 'application/pdf');
});

test('another owner, malformed paths and a substituted expected hash fail before any storage request', async () => {
  let requests = 0;
  const store = make(async () => { requests++; return object(); });
  for (const invalid of [
    key.replace(encodeURIComponent(owner), 'another-owner'),
    key.replace('/statement.pdf', '/nested/statement.pdf'),
    key.replace('/statement.pdf', '/..'),
    key.replace('/statement.pdf', '/%2e%2e'),
    key.replace(hash, 'x'.repeat(64)),
  ]) await assert.rejects(store.verifyHead(invalid, owner), error => error instanceof SupabaseFileError && error.code === 'not-found');
  await assert.rejects(store.verifyHead(key, owner, 'a'.repeat(64)), error => error.code === 'not-found');
  assert.equal(requests, 0);
});

test('uploaded content and browser metadata cannot substitute a different original', async () => {
  const store = make(async () => new Response('different document', { headers: { 'x-metadata': JSON.stringify({ ownerId: owner, hash }) } }));
  await assert.rejects(store.completeUpload(owner, { key, hash }), error => error.code === 'hash');
  await assert.rejects(store.signedDownload(key, owner), error => error.code === 'hash');
});

test('missing and oversized objects are never accepted as retained evidence', async () => {
  const absent = make(async () => new Response(null, { status: 404 }));
  assert.equal(await absent.verifyHead(key, owner, hash), null);
  await assert.rejects(absent.completeUpload(owner, { key, hash }), error => error.code === 'not-found');
  const missing400 = make(async () => Response.json({ statusCode: '404', error: 'not_found' }, { status: 400 }));
  assert.equal(await missing400.verifyHead(key, owner, hash), null);
  const tooLarge = make(async () => new Response('fixture', { headers: { 'Content-Length': String(MAX_PRIVATE_FILE_BYTES + 1) } }));
  await assert.rejects(tooLarge.verifyHead(key, owner, hash), error => error.code === 'invalid-file');
});

test('invalid upload descriptions and client credentials never reach storage', async () => {
  let requests = 0;
  const store = make(async () => { requests++; return object(); });
  for (const invalid of [description({ size: 0 }), description({ size: MAX_PRIVATE_FILE_BYTES + 1 }), description({ hash: 'not-a-hash' }), description({ type: '', name: 'file.exe' })]) {
    await assert.rejects(store.beginUpload(owner, invalid), error => error.code === 'invalid-file');
  }
  assert.throws(() => createSupabaseFileStore({ url: 'https://attacker.invalid', secretKey: secret }), error => error.code === 'configuration');
  assert.throws(() => createSupabaseFileStore({ url: origin, secretKey: 'sb_publishable_public_key' }), error => error.code === 'configuration');
  assert.equal(requests, 0);
});

test('private downloads verify stored bytes then return a short-lived owner-scoped signed URL', async () => {
  const calls = [];
  const store = make(async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'GET') return object();
    return json({ signedURL: '/object/sign/hisabflow-documents/owners/fixture.pdf?token=download-token' });
  });
  const download = new URL(await store.signedDownload(key, owner));
  assert.equal(download.origin, origin);
  assert.equal(download.searchParams.get('token'), 'download-token');
  assert.equal(download.searchParams.get('download'), 'statement.pdf');
  assert.ok(download.pathname.endsWith(`/owners/${physicalOwner}/${hash}/statement.pdf`));
  assert.deepEqual(JSON.parse(calls[1].options.body), { expiresIn: 60 });
});

test('unexpected signed URL origins and raw upstream errors are sanitized', async () => {
  const hostile = make(async (_url, options) => options.method === 'GET' ? new Response(null, { status: 404 }) : json({ url: 'https://attacker.invalid/storage/v1/object/upload/sign/hisabflow-documents/file?token=stolen' }));
  await assert.rejects(hostile.beginUpload(owner, description()), error => error.code === 'unavailable' && !error.message.includes('attacker'));
  const failure = make(async () => { throw new Error(`private transport error ${secret}`); });
  await assert.rejects(failure.verifyHead(key, owner), error => error instanceof SupabaseFileError && !error.message.includes(secret));
});

function handlers({ user = { userId: owner }, store } = {}) {
  return createVercelFileHandlers({ getUser: async () => user, getStore: () => store, authErrorResponse: () => new Response(null, { status: 503 }), responseHeaders: { 'Cache-Control': 'private, no-store' } });
}
const post = (value, headers = {}) => new Request('https://hisabflow.example/api/files', { method: 'POST', headers: { Origin: 'https://hisabflow.example', 'Content-Type': 'application/json', 'X-Workspace-Owner': encodeURIComponent(owner), ...headers }, body: JSON.stringify(value) });

test('file routes reject signed-out users, cross-origin uploads and switched workspace accounts before storage', async () => {
  assert.equal((await handlers({ user: null }).POST(post({ action: 'begin' }))).status, 401);
  assert.equal((await handlers().POST(post({ action: 'begin' }, { Origin: 'https://another.example' }))).status, 403);
  assert.equal((await handlers().POST(post({ action: 'begin' }, { 'X-Workspace-Owner': 'another-owner' }))).status, 409);
  assert.equal((await handlers({ user: null }).GET(new Request('https://hisabflow.example/api/files?key=private'))).status, 401);
});

test('download routes redirect document bytes away from Vercel and do not cache signed URLs', async () => {
  const store = { async signedDownload(actualKey, actualOwner) { assert.equal(actualKey, key); assert.equal(actualOwner, owner); return `${origin}/storage/v1/object/sign/hisabflow-documents/file?token=short-lived`; } };
  const response = await handlers({ store }).GET(new Request(`https://hisabflow.example/api/files?key=${encodeURIComponent(key)}`));
  assert.equal(response.status, 303);
  assert.match(response.headers.get('Location'), /token=short-lived/);
  assert.match(response.headers.get('Cache-Control'), /no-store/);
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(await response.text(), '');
});

test('a document above the Vercel payload limit sends only bounded details through application routes', async () => {
  const originalFetch = globalThis.fetch;
  const originalHosting = process.env.NEXT_PUBLIC_HISABFLOW_HOSTING;
  process.env.NEXT_PUBLIC_HISABFLOW_HOSTING = 'vercel';
  const file = new File([new Uint8Array(5 * 1024 * 1024).fill(7)], 'large-statement.pdf', { type: 'application/pdf' });
  const calls = [];
  let retained;
  globalThis.fetch = async (input, options) => {
    const url = String(input);
    calls.push({ url, options });
    if (url === '/api/files') {
      assert.equal(typeof options.body, 'string');
      assert.ok(options.body.length < 4096);
      assert.equal(options.headers['X-Workspace-Owner'], encodeURIComponent(owner));
      const value = JSON.parse(options.body);
      if (value.action === 'begin') {
        retained = { key: `owners/${encodeURIComponent(owner)}/${value.hash}/large-statement.pdf`, hash: value.hash };
        return json({ ...retained, signedUrl: `${origin}/storage/v1/object/upload/sign/hisabflow-documents/file?token=upload-only`, contentType: file.type });
      }
      assert.deepEqual(value, { action: 'complete', ...retained });
      return json(retained);
    }
    assert.equal(new URL(url).origin, origin);
    assert.equal(options.method, 'PUT');
    assert.equal(options.body, file);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['x-upsert'], 'false');
    return json({ Key: 'private/document' });
  };
  try {
    assert.deepEqual(await uploadPrivateFile(file, owner), retained);
    assert.equal(calls.length, 3);
    assert.equal(calls.filter(call => call.options.body instanceof File).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalHosting === undefined) delete process.env.NEXT_PUBLIC_HISABFLOW_HOSTING;
    else process.env.NEXT_PUBLIC_HISABFLOW_HOSTING = originalHosting;
  }
});
