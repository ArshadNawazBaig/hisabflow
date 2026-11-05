import { env } from 'cloudflare:workers';
import { cookies } from 'next/headers';
import { AuthIdentityError } from '@/lib/server/auth-identities';
import { createAuthClient, identityStore, authCookieOptions, authRedirect, clearGoogleCookies, sha256, WorkspaceAuthError, localAuthAllowed } from '@/lib/server/auth';
import { AUTH_FLOW_COOKIE, AUTH_PROVIDER_COOKIE, approvedAppOrigin, assertCallbackOwner, checkedGoogleIdentity } from '@/lib/server/auth-policy';

export const dynamic='force-dynamic';
export async function GET(request: Request) {
  let exchanged=false;
  try {
    approvedAppOrigin(request,localAuthAllowed(),env.HISABFLOW_APP_ORIGIN);
    const url=new URL(request.url),jar=await cookies();
    const nonce=jar.get(AUTH_FLOW_COOKIE)?.value;
    if (!nonce || !/^[0-9a-f]{64}$/.test(nonce)) throw new WorkspaceAuthError('expired');
    const store=identityStore(),flow=await store.consumeFlow(await sha256(nonce),Date.now());
    jar.set(AUTH_FLOW_COOKIE,'',{...authCookieOptions(),maxAge:0});
    if (!flow) throw new WorkspaceAuthError('expired');
    assertCallbackOwner(flow,Date.now());
    if (url.searchParams.has('error')) {
      await clearGoogleCookies(false);
      return authRedirect('/login?auth_error=cancelled');
    }
    const code=url.searchParams.get('code');
    if (!code || code.length>4096) throw new WorkspaceAuthError('unauthenticated');
    const client=await createAuthClient();
    const result=await client.auth.exchangeCodeForSession(code);
    if (result.error) throw new WorkspaceAuthError('unauthenticated');
    exchanged=true;
    const {data,error}=await client.auth.getUser();
    if (error) throw new WorkspaceAuthError('unauthenticated');
    const google=checkedGoogleIdentity(data.user);
    const existingOwner=await store.getOwnerForGoogle(google.id);
    if (!existingOwner) await store.linkGoogleToOwner(google.id,`supabase:${google.id}`);
    jar.set(AUTH_PROVIDER_COOKIE,'google',{...authCookieOptions(),maxAge:60*60*24*365});
    return authRedirect('/?auth_success=google_signed_in');
  } catch(error) {
    await clearGoogleCookies(false);
    if (exchanged) {
      // An incomplete sign-in must not expose an unlinked Google session.
      await clearGoogleCookies();
      (await cookies()).set(AUTH_PROVIDER_COOKIE,'google',{...authCookieOptions(),maxAge:60*60*24*365});
    }
    const code=error instanceof AuthIdentityError && error.code==='conflict' ? 'identity_conflict'
      : error instanceof WorkspaceAuthError && error.code==='expired' ? 'expired'
      : error instanceof WorkspaceAuthError && error.code==='unauthenticated' ? 'signin_failed' : 'unavailable';
    return authRedirect(`/login?auth_error=${code}`);
  }
}
