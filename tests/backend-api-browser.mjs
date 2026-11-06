import { request } from '@playwright/test';
import assert from 'node:assert/strict';

const base = process.env.HISABFLOW_TEST_ORIGIN || 'http://127.0.0.1:5173';
const client = await request.newContext({ baseURL: base });
try {
  for (const [method, path] of [
    ['get', '/api/workspace'], ['put', '/api/workspace'],
    ['get', '/api/files?key=owners/another-user/private.pdf'], ['post', '/api/files'],
    ['get', '/api/storage/status'],
  ]) {
    const response = await client[method](path, { maxRedirects: 0 });
    assert.equal(response.status(), 401, `${method.toUpperCase()} ${path} must require authentication`);
    assert.match(response.headers()['cache-control'], /no-store/);
    assert.equal(typeof (await response.json()).error, 'string');
  }
  const status = await client.get('/api/auth/status');
  assert.equal(status.status(), 200);
  assert.match(status.headers()['cache-control'], /no-store/);
  const authStatus = await status.json();
  assert.equal(authStatus.signedIn, false);
  assert.equal(authStatus.googleConfigured, true, 'Google sign-in must be configured in the running local app');

  for (const headers of [{ Origin: 'https://other.example' }, { 'Sec-Fetch-Site': 'cross-site' }, {}]) {
    assert.equal((await client.post('/auth/logout', { headers, maxRedirects: 0 })).status(), 403);
    assert.equal((await client.post('/auth/google', { headers, form: { intent: 'signin' }, maxRedirects: 0 })).status(), 403);
  }
  const started = await client.post('/auth/google', { headers: { Origin: base }, form: { intent: 'signin' }, maxRedirects: 0 });
  let flowNeedsCleanup = true;
  try {
    assert.equal(started.status(), 303);
    const authorization = new URL(started.headers().location);
    assert.equal(authorization.origin, 'https://coeazyvaghocoxuzngcc.supabase.co');
    assert.equal(authorization.searchParams.get('redirect_to'), base + '/auth/callback');
    const startedCookies = (await client.storageState()).cookies;
    const flowCookie = startedCookies.find(cookie => cookie.name === 'hisabflow-oauth-flow');
    assert.ok(flowCookie, 'OAuth state must be retained by the browser');
    const pkceCookies = startedCookies.filter(cookie => cookie.name.startsWith('hisabflow-google-session') && cookie.name.includes('code-verifier'));
    assert.ok(pkceCookies.length, 'The PKCE verifier must be retained by the browser');
    for (const cookie of [flowCookie, ...pkceCookies]) {
      assert.equal(cookie.httpOnly, true);
      assert.equal(cookie.sameSite, 'Lax');
      if (new URL(base).protocol === 'http:') assert.equal(cookie.secure, false, 'The trusted local runtime must support loopback HTTP cookies');
    }

    // Inspect the provider's effective return destination, not just the app's
    // requested redirect_to. Supabase silently falls back to its Site URL when
    // a deployed callback is missing from its redirect allowlist.
    async function isolatedOAuthGet(url) {
      try { return await client.get(url, { maxRedirects: 0 }); }
      catch { throw new Error('The isolated OAuth redirect check could not complete.'); }
    }
    function redirectLocation(response, fallback) {
      try { return new URL(response.headers().location, fallback); }
      catch { throw new Error('The OAuth response did not provide a valid redirect destination.'); }
    }
    const provider = await isolatedOAuthGet(authorization.toString());
    assert.equal(provider.status(), 302, 'Supabase must start the configured Google provider');
    const google = redirectLocation(provider, authorization.origin);
    assert.equal(google.origin, 'https://accounts.google.com', 'OAuth must redirect only to the configured Google provider');
    const state = google.searchParams.get('state');
    assert.ok(state, 'The provider request must retain isolated OAuth state');
    const deniedCallback = new URL('/auth/v1/callback', authorization.origin);
    deniedCallback.searchParams.set('state', state);
    deniedCallback.searchParams.set('error', 'access_denied');
    const denied = await isolatedOAuthGet(deniedCallback.toString());
    assert.equal(denied.status(), 302, 'Supabase must return provider cancellation to the app');
    const effective = redirectLocation(denied, authorization.origin);
    assert.equal(effective.origin + effective.pathname, base + '/auth/callback', 'Supabase rejected the app callback. Set its Site URL to the deployed origin and add the exact /auth/callback URL to Redirect URLs.');
    const cancelled = await isolatedOAuthGet(effective.toString());
    assert.equal(cancelled.status(), 303);
    assert.equal(cancelled.headers().location, '/login?auth_error=cancelled');
    flowNeedsCleanup = false;
    const finishedCookies = (await client.storageState()).cookies;
    assert.equal(finishedCookies.some(cookie => cookie.name === 'hisabflow-oauth-flow'), false);
    assert.equal(finishedCookies.some(cookie => pkceCookies.some(verifier => verifier.name === cookie.name)), false);
  } finally {
    // Consume only this test context's nonce, including when configuration
    // assertions fail before Supabase returns to the application.
    if (flowNeedsCleanup) await client.get('/auth/callback?error=access_denied', { maxRedirects: 0 }).catch(() => {});
  }
  const invalidSession = await request.newContext({ baseURL: base, storageState: { cookies: [{
    name: 'hisabflow-auth-provider', value: 'google', domain: new URL(base).hostname, path: '/',
    expires: -1, httpOnly: true, secure: new URL(base).protocol === 'https:', sameSite: 'Lax',
  }], origins: [] } });
  try {
    const expired = await invalidSession.get('/api/workspace');
    assert.equal(expired.status(), 401);
    assert.equal((await expired.json()).code, 'AUTH_SESSION_INVALID');
    const reset = await invalidSession.post('/auth/logout', { headers: { Origin: base }, maxRedirects: 0 });
    assert.equal(reset.status(), 303);
    assert.equal(reset.headers().location, '/login');
    assert.equal((await (await invalidSession.get('/api/auth/status')).json()).signedIn, false);
    assert.equal((await invalidSession.storageState()).cookies.some(cookie => cookie.name === 'hisabflow-auth-provider'), false);
  } finally {
    await invalidSession.dispose();
  }
  console.log('PASS private API authentication, no-store responses, auth CSRF rejection, effective OAuth provider return URL and cookie lifecycle, invalid-session recovery and sign-out cookie reset.');
} finally {
  await client.dispose();
}
