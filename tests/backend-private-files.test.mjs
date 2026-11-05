import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateFileHandlers } from '../lib/server/private-files.ts';

const origin = 'https://hisabflow.example';
const userId = 'owner:/A';
const prefix = `owners/${encodeURIComponent(userId)}/`;
const key = prefix + 'hash/statement.pdf';
const responseHeaders = { 'Cache-Control': 'private, no-store' };
const download = (fileKey = key) => new Request(`${origin}/api/files?key=${encodeURIComponent(fileKey)}`);
const upload = (file, headers = {}) => {
  const form = new FormData();
  form.set('file', file);
  return new Request(origin + '/api/files', { method: 'POST', body: form, headers });
};
function harness(overrides = {}) {
  const writes = [], reads = [];
  const bucket = {
    async put(...args) { writes.push(args); return {}; },
    async get(value) {
      reads.push(value);
      return { body: new Blob(['private fixture']).stream(), httpMetadata: { contentType: 'application/pdf' }, customMetadata: { ownerId: userId, originalName: 'statement.pdf' } };
    },
  };
  return { writes, reads, ...createPrivateFileHandlers({
    getUser: async () => ({ userId }), getBucket: () => bucket,
    authErrorResponse: () => Response.json({ error: 'Please sign in again.' }, { status: 401, headers: responseHeaders }),
    responseHeaders, ...overrides,
  }) };
}

test('unsigned and invalid-session requests cannot read or write private storage', async () => {
  for (const getUser of [async () => null, async () => { throw new Error('private token'); }]) {
    const api = harness({ getUser });
    assert.equal((await api.GET(download())).status, 401);
    assert.equal((await api.POST(upload(new File(['fixture'], 'statement.pdf')))).status, 401);
    assert.equal(api.writes.length, 0);
    assert.equal(api.reads.length, 0);
  }
});

test('documents outside the authenticated owner prefix are denied before storage access', async () => {
  const api = harness();
  for (const value of ['owners/other/hash/statement.pdf', `owners/${userId}/hash/statement.pdf`, prefix.slice(0, -1) + '-other/file']) {
    assert.equal((await api.GET(download(value))).status, 404);
  }
  assert.equal(api.reads.length, 0);
});

test('download independently checks retained owner metadata and handles missing documents', async () => {
  for (const file of [null, { customMetadata: { ownerId: 'other' } }, { customMetadata: {} }]) {
    const api = harness({ getBucket: () => ({ get: async () => file }) });
    assert.equal((await api.GET(download())).status, 404);
  }
});

test('storage failures return a retryable private response without exposing backend details', async () => {
  const privateError = 'R2 credential and internal account identifier';
  for (const ErrorType of [Error, TypeError]) {
    const api = harness({ getBucket: () => ({ get: async () => { throw new ErrorType(privateError); }, put: async () => { throw new ErrorType(privateError); } }) });
    for (const response of [await api.GET(download()), await api.POST(upload(new File(['fixture'], 'statement.pdf', { type: 'application/pdf' })))]) {
      assert.equal(response.status, 503);
      assert.match(response.headers.get('cache-control'), /no-store/);
      const body = await response.text();
      assert.match(body, /retry/i);
      assert.equal(body.includes(privateError), false);
    }
  }
});

test('downloads retain private headers, safe attachment disposition and original bytes', async () => {
  const api = harness();
  const response = await api.GET(download());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/pdf');
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="statement.pdf"');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal(await response.text(), 'private fixture');
});

test('legacy missing or unsafe filenames cannot crash downloads or inject response headers', async () => {
  for (const originalName of [undefined, 'نام\r\n"\\bad.pdf']) {
    const api = harness({ getBucket: () => ({ get: async () => ({ body: null, customMetadata: { ownerId: userId, originalName } }) }) });
    const response = await api.GET(download());
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /^attachment; filename="[\w. -]+"$/);
  }
});

test('uploads hash exact bytes and retain the encoded owner and safe filename', async () => {
  const api = harness();
  const contents = '%PDF-1.7\nprivate fixture';
  const response = await api.POST(upload(new File([contents], 'name/statement.pdf', { type: 'application/pdf' }), { Origin: origin }));
  assert.equal(response.status, 200);
  const result = await response.json();
  const expectedHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(contents)))].map(n => n.toString(16).padStart(2, '0')).join('');
  assert.equal(result.hash, expectedHash);
  assert.equal(result.key, `${prefix}${expectedHash}/name_statement.pdf`);
  assert.equal(api.writes.length, 1);
  assert.equal(new TextDecoder().decode(api.writes[0][1]), contents);
  assert.equal(api.writes[0][2].customMetadata.ownerId, userId);
  assert.equal(api.writes[0][2].customMetadata.hash, expectedHash);
});

test('cross-origin and explicitly cross-site uploads cannot write storage', async () => {
  const api = harness();
  for (const headers of [{ Origin: 'https://other.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await api.POST(upload(new File(['fixture'], 'statement.pdf'), headers))).status, 403);
  }
  assert.equal(api.writes.length, 0);
});

test('an upload pinned to a different signed-in account cannot retain source bytes', async () => {
  const api = harness();
  const response = await api.POST(upload(new File(['fixture'], 'statement.pdf'), { 'X-Workspace-Owner': encodeURIComponent('another-owner') }));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'WORKSPACE_ACCOUNT_CHANGED');
  assert.equal(api.writes.length, 0);
  const accepted = await api.POST(upload(new File(['fixture'], 'statement.pdf'), { 'X-Workspace-Owner': encodeURIComponent(userId) }));
  assert.equal(accepted.status, 200);
  assert.equal(api.writes.length, 1);
});

test('empty, unsupported, malformed and oversized uploads fail without storage writes', async () => {
  const api = harness();
  for (const file of [new File([], 'statement.pdf'), new File(['fixture'], 'script.html', { type: 'text/html' })]) {
    assert.equal((await api.POST(upload(file))).status, 400);
  }
  assert.equal((await api.POST(new Request(origin + '/api/files', { method: 'POST', body: 'invalid multipart' }))).status, 400);
  const tooLarge = new Request(origin + '/api/files', { method: 'POST', body: new Uint8Array(21 * 1024 * 1024 + 1), duplex: 'half' });
  assert.equal((await api.POST(tooLarge)).status, 413);
  assert.equal(api.writes.length, 0);
});

test('unconfigured document storage reports an actionable unavailable response', async () => {
  const api = harness({ getBucket: () => undefined });
  assert.equal((await api.GET(download())).status, 503);
  assert.equal((await api.POST(upload(new File(['fixture'], 'statement.pdf')))).status, 503);
});
