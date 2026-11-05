import { env } from 'cloudflare:workers';
import { cookies } from 'next/headers';
import { createAuthClient, identityStore, authErrorResponse, authCookieOptions, authRedirect, sha256, WorkspaceAuthError, localAuthAllowed } from '@/lib/server/auth';
import { AUTH_FLOW_COOKIE, AUTH_FLOW_TTL_MS, assertSameOriginAuthRequest } from '@/lib/server/auth-policy';
import { HISABFLOW_SUPABASE_URL } from '@/lib/server/supabase-workspace';
import { readBoundedFormData, RequestBodyTooLargeError } from '@/lib/server/request-body';

export const dynamic='force-dynamic';
export async function POST(request: Request) {
  try {
    const origin=assertSameOriginAuthRequest(request,localAuthAllowed(),env.HISABFLOW_APP_ORIGIN);
    const form=await readBoundedFormData(request,2048);
    const intent=form.get('intent');
    if (intent!=='signin') throw new WorkspaceAuthError('origin');
    const now=Date.now();
    const nonce=[...crypto.getRandomValues(new Uint8Array(32))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
    await identityStore().createFlow({nonceHash:await sha256(nonce),intent,sitesOwnerId:null,createdAt:now,expiresAt:now+AUTH_FLOW_TTL_MS});
    const client=await createAuthClient();
    const {data,error}=await client.auth.signInWithOAuth({provider:'google',options:{redirectTo:new URL('/auth/callback',origin).toString(),skipBrowserRedirect:true,queryParams:{prompt:'select_account'}}});
    if (error || !data.url) throw new WorkspaceAuthError('unavailable');
    const authorize=new URL(data.url);
    if (authorize.origin!==HISABFLOW_SUPABASE_URL || authorize.pathname!=='/auth/v1/authorize' || authorize.searchParams.get('provider')!=='google') throw new WorkspaceAuthError('configuration');
    const jar=await cookies();
    jar.set(AUTH_FLOW_COOKIE,nonce,{...authCookieOptions(),maxAge:AUTH_FLOW_TTL_MS/1000});
    return authRedirect(authorize.toString());
  } catch(error) {return authErrorResponse(error instanceof RequestBodyTooLargeError ? new WorkspaceAuthError('origin') : error);}
}
