/* Public app resources only. Private pages, identity, and records stay on the network. */
const CACHE_PREFIX = 'hisabflow-public-';
// Bump this version when replacing an unversioned brand resource or cache policy.
const CACHE_NAME = `${CACHE_PREFIX}v2`;
const OFFLINE_URL = '/offline';
const PRECACHE_URLS = [OFFLINE_URL, '/favicon.svg'];
const MAX_CACHE_ENTRIES = 80;
const publicFiles = new Set([
  ...PRECACHE_URLS,
  '/fonts/manrope-regular.ttf',
  '/fonts/manrope-medium.ttf',
  '/fonts/manrope-semibold.ttf',
  '/fonts/manrope-bold.ttf',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
]);
let cacheWrites = Promise.resolve();

function isPrivateRequest(request, url) {
  return request.method !== 'GET'
    || url.origin !== self.location.origin
    || request.headers.has('authorization')
    || ['rsc', 'next-action', 'next-router-state-tree', 'next-router-prefetch'].some(name => request.headers.has(name))
    || request.headers.get('accept')?.includes('text/x-component')
    || url.searchParams.has('_rsc')
    || /^\/(?:api|auth)(?:\/|$)/.test(url.pathname)
    || /^\/(?:login|signin|signup)\/?$/.test(url.pathname);
}

function isPublicAsset(url) {
  if (url.search) return false;
  return publicFiles.has(url.pathname)
    || /^\/_next\/static\/(?:(?:chunks|css)\/)?[A-Za-z0-9_.-]+[-.][A-Za-z0-9_-]{8,}\.(?:js|css)$/.test(url.pathname);
}

function mayCache(response, url) {
  if (response.status !== 200 || response.redirected || response.type === 'opaque' || response.type === 'opaqueredirect') return false;
  if (response.url && new URL(response.url).origin !== self.location.origin) return false;
  const cacheControl = response.headers.get('cache-control') || '';
  if (/(?:^|,)\s*(?:private|no-store|no-cache)\b/i.test(cacheControl)) return false;
  if (response.headers.get('vary')?.split(',').some(name => ['*', 'cookie', 'authorization'].includes(name.trim().toLowerCase()))) return false;
  const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || '';
  if (url.pathname === OFFLINE_URL) return contentType === 'text/html';
  if (url.pathname.endsWith('.svg')) return contentType === 'image/svg+xml';
  if (url.pathname.endsWith('.png')) return contentType === 'image/png';
  if (url.pathname.endsWith('.ttf')) return contentType.startsWith('font/') || ['application/octet-stream', 'application/x-font-ttf'].includes(contentType);
  if (url.pathname.endsWith('.css')) return contentType === 'text/css';
  return ['text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript'].includes(contentType);
}

function storePublic(request, response) {
  // Serialize writes so parallel chunk fetches cannot grow the cache without bounds.
  cacheWrites = cacheWrites.then(async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response);
    const keys = await cache.keys();
    let excess = keys.length - MAX_CACHE_ENTRIES;
    for (const key of keys) {
      if (excess <= 0) break;
      if (PRECACHE_URLS.includes(new URL(key.url).pathname)) continue;
      await cache.delete(key);
      excess -= 1;
    }
  }).catch(() => { /* A full or unavailable cache must never break an online request. */ });
  return cacheWrites;
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    for (const path of PRECACHE_URLS) {
      const request = new Request(new URL(path, self.location.origin), { cache: 'reload', credentials: 'omit' });
      const response = await fetch(request);
      if (!mayCache(response, new URL(request.url))) throw new Error('Public offline resources could not be prepared.');
      await cache.put(path, response);
    }
    // Updates wait for the user's existing windows to close or an explicit message.
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING' && event.source?.url && new URL(event.source.url).origin === self.location.origin) {
    event.waitUntil(self.skipWaiting());
  }
});

self.addEventListener('fetch', event => {
  const { request } = event, url = new URL(request.url);
  if (isPrivateRequest(request, url)) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(async () => {
      const fallback = await caches.match(OFFLINE_URL, { cacheName: CACHE_NAME });
      if (fallback) return fallback;
      return new Response('HisabFlow needs a connection. Reconnect and try again.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }));
    return;
  }

  if (!isPublicAsset(url) || ['no-store', 'no-cache', 'reload'].includes(request.cache)
    || /(?:^|,)\s*(?:no-store|no-cache)\b/i.test(request.headers.get('cache-control') || '')) return;
  event.respondWith((async () => {
    const cached = await caches.match(request, { cacheName: CACHE_NAME });
    if (cached) return cached;
    const response = await fetch(request);
    if (mayCache(response, url)) event.waitUntil(storePublic(request, response.clone()));
    return response;
  })());
});
