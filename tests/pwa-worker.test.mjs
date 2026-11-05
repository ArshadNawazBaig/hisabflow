import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
const origin = 'https://hisabflow.example';
const publicChunk = '/_next/static/chunks/public-probe-ABCD1234.js';
const keyOf = request => new URL(typeof request === 'string' ? request : request.url, origin).href;
const html = (body = 'Generic offline screen') => new Response(body, { headers: { 'Content-Type': 'text/html' } });
const script = (body = 'public code', headers = {}) => new Response(body, { headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'public, max-age=31536000, immutable', ...headers } });

function harness({ network = async request => new URL(request.url).pathname === '/favicon.svg'
  ? new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } })
  : html() } = {}) {
  const handlers = new Map(), stores = new Map(), requests = [];
  const self = { location: new URL(origin), claims: 0, skips: 0,
    addEventListener: (name, handler) => handlers.set(name, handler),
    clients: { claim: async () => { self.claims += 1; } },
    skipWaiting: async () => { self.skips += 1; },
  };
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        async put(request, response) { store.set(keyOf(request), response.clone()); },
        async keys() { return [...store.keys()].map(url => new Request(url)); },
        async delete(request) { return store.delete(keyOf(request)); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
    async match(request, { cacheName } = {}) {
      for (const [name, store] of stores) {
        if (cacheName && name !== cacheName) continue;
        const response = store.get(keyOf(request));
        if (response) return response.clone();
      }
    },
  };
  const cacheName=vm.runInNewContext(source+'\nCACHE_NAME', { self, caches, URL, Request, Response, fetch: async request => { requests.push(request); return network(request); } });
  const dispatch = async (name, values = {}) => {
    const pending = []; let response;
    handlers.get(name)({ ...values, waitUntil: promise => pending.push(promise), respondWith: promise => { response = promise; } });
    const resolved = response ? await response : undefined;
    await Promise.all(pending);
    return resolved;
  };
  const request = (pathname, options = {}) => ({ url: new URL(pathname, origin).href, method: 'GET', mode: 'cors', cache: 'default', headers: new Headers(), ...options });
  return { self, caches, stores, requests, dispatch, request, cacheName,
    fetch: (pathname, options) => dispatch('fetch', { request: request(pathname, options) }),
    cachedPaths: () => [...stores.values()].flatMap(store => [...store.keys()].map(url => new URL(url).pathname)),
  };
}

test('PWA installation prepares only the generic offline page and public brand mark', async () => {
  const app = harness(); await app.dispatch('install');
  assert.deepEqual(app.cachedPaths(), ['/offline', '/favicon.svg']);
  assert.equal(app.self.skips, 0, 'New releases must not forcibly replace open windows.');
  assert.ok(app.requests.every(request => request.credentials === 'omit'));
});

test('activation removes only older HisabFlow public caches and claims existing clients', async () => {
  const app = harness(); await app.dispatch('install');
  await app.caches.open('hisabflow-public-v0'); await app.caches.open('another-app-cache');
  await app.dispatch('activate');
  assert.deepEqual(await app.caches.keys(), [app.cacheName, 'another-app-cache']);
  assert.equal(app.self.claims, 1);
});

test('only an explicit same-origin window message activates an update', async () => {
  const app = harness();
  for (const event of [{ data: { type: 'SKIP_WAITING' } }, { data: { type: 'OTHER' }, source: { url: origin } }, { data: { type: 'SKIP_WAITING' }, source: { url: 'https://other.example/' } }]) await app.dispatch('message', event);
  assert.equal(app.self.skips, 0);
  await app.dispatch('message', { data: { type: 'SKIP_WAITING' }, source: { url: origin + '/#Companies' } });
  assert.equal(app.self.skips, 1);
});

test('private APIs, auth, mutations, cross-origin, action and RSC requests bypass the worker', async () => {
  const app = harness();
  const cases = [
    ['/api/workspace'], ['/api/files?key=owners/private/document.pdf'], ['/auth/google'], ['/auth/callback?code=secret'], ['/auth/logout'],
    ['/login'], ['/signup'], ['/signin'], ['https://accounts.google.com/'], ['/', { method: 'POST' }],
    ['/', { headers: new Headers({ RSC: '1' }) }], ['/?_rsc=token'], ['/', { headers: new Headers({ 'Next-Action': 'action' }) }],
    [publicChunk, { headers: new Headers({ Authorization: 'Bearer private' }) }], ['/', { headers: new Headers({ Accept: 'text/x-component' }) }],
    ['/', { headers: new Headers({ 'Next-Router-State-Tree': 'private' }) }],
  ];
  for (const [path, options] of cases) assert.equal(await app.fetch(path, options), undefined, path);
  assert.equal(app.requests.length, 0); assert.deepEqual(app.cachedPaths(), []);
});

test('navigation always fetches the latest protected document and never persists it', async () => {
  const app = harness({ network: async () => html('owner-specific financial records') });
  const response = await app.fetch('/', { mode: 'navigate' });
  assert.equal(await response.text(), 'owner-specific financial records');
  assert.deepEqual(app.cachedPaths(), []);
});

test('offline navigation uses only the generic public page, without financial or identity caches', async () => {
  const app = harness({ network: async () => { throw new TypeError('Offline'); } });
  const cache = await app.caches.open(app.cacheName); await cache.put('/offline', html('Generic offline screen'));
  const response = await app.fetch('/', { mode: 'navigate' });
  assert.equal(await response.text(), 'Generic offline screen');
  assert.deepEqual(app.cachedPaths(), ['/offline']);
});

test('missing offline storage produces a clear uncached 503 and server errors are preserved', async () => {
  const offline = harness({ network: async () => { throw new TypeError('Offline'); } });
  const fallback = await offline.fetch('/', { mode: 'navigate' });
  assert.equal(fallback.status, 503); assert.equal(fallback.headers.get('Cache-Control'), 'no-store');
  const server = harness({ network: async () => new Response('Server unavailable', { status: 503 }) });
  assert.equal(await (await server.fetch('/', { mode: 'navigate' })).text(), 'Server unavailable');
});

test('only public hashed code and exact public fonts or icons use the static cache', async () => {
  const app = harness({ network: async () => script() });
  assert.equal(await (await app.fetch(publicChunk)).text(), 'public code');
  await app.fetch(publicChunk);
  assert.equal(app.requests.length, 1, 'Repeated immutable asset requests use the static cache.');
  await app.fetch('/_next/static/public-probe-ABCD1234.js');
  for (const path of ['/private.js', '/_next/static/unhashed.js', '/_next/static/chunks/unhashed.js', publicChunk + '?private=token', '/icons/private.png', '/pdf.worker.min.mjs', '/manifest.webmanifest']) assert.equal(await app.fetch(path), undefined, path);
  assert.deepEqual(app.cachedPaths(), [publicChunk, '/_next/static/public-probe-ABCD1234.js']);
});

test('private or non-cacheable responses and unexpected HTML are never stored as public code', async () => {
  const responses = [script('private', { 'Cache-Control': 'private' }), script('private', { 'Cache-Control': 'no-store' }), script('private', { 'Cache-Control': 'no-cache' }), script('private', { Vary: 'Cookie' }), script('private', { Vary: 'Authorization' }), script('private', { Vary: '*' }), html('signed-in page'), new Response('missing', { status: 404 }), new Response('partial', { status: 206, headers: { 'Content-Type': 'application/javascript' } })];
  for (const response of responses) {
    const app = harness({ network: async () => response }); await app.fetch(publicChunk);
    assert.deepEqual(app.cachedPaths(), []);
  }
});

test('no-store and explicit revalidation requests cannot read a previously cached asset', async () => {
  const app = harness({ network: async () => script() }); await app.fetch(publicChunk);
  for (const options of [{ cache: 'no-store' }, { cache: 'no-cache' }, { cache: 'reload' }, { headers: new Headers({ 'Cache-Control': 'no-store' }) }]) assert.equal(await app.fetch(publicChunk, options), undefined);
  assert.equal(app.requests.length, 1);
});

test('static storage is bounded while retaining the offline screen and brand resource', async () => {
  const app = harness({ network: async request => new URL(request.url).pathname === '/favicon.svg'
    ? new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } })
    : new URL(request.url).pathname === '/offline' ? html() : script() });
  await app.dispatch('install');
  for (let index = 0; index < 90; index += 1) await app.fetch(`/_next/static/chunks/probe${index}-ABCD1234.js`);
  assert.equal(app.cachedPaths().length, 80);
  assert.ok(app.cachedPaths().includes('/offline')); assert.ok(app.cachedPaths().includes('/favicon.svg'));
  assert.ok(!app.cachedPaths().includes('/_next/static/chunks/probe0-ABCD1234.js'));
});
