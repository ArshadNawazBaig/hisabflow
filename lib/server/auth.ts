import { env } from 'cloudflare:workers';
import { cookies } from 'next/headers';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { HISABFLOW_SUPABASE_URL } from './supabase-workspace';
import { AuthIdentityError, createIdentityStore } from './auth-identities';
import { AUTH_COOKIE_NAME, AUTH_PROVIDER_COOKIE, AUTH_FLOW_COOKIE, AUTH_FLOW_TTL_MS, AUTH_RESPONSE_HEADERS, isGoogleSessionCookie, isGooglePkceCookie, WorkspaceAuthError, checkedGoogleIdentity, checkedProductionOrigin, resolveWorkspaceIdentity, type WorkspaceUser } from './auth-policy';

export { AUTH_RESPONSE_HEADERS, WorkspaceAuthError } from './auth-policy';
export type { WorkspaceUser } from './auth-policy';
export const authCookieOptions = () => ({path:'/',httpOnly:true,secure:!import.meta.env.DEV,sameSite:'lax' as const});

function configuredPublicKey(): string {
  const key = env.SUPABASE_PUBLISHABLE_KEY || '';
  if (env.SUPABASE_URL !== HISABFLOW_SUPABASE_URL || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) throw new WorkspaceAuthError('configuration');
  if (!import.meta.env.DEV) checkedProductionOrigin(env.HISABFLOW_APP_ORIGIN);
  return key;
}
export function googleAuthConfigured(): boolean {
  try { configuredPublicKey(); return true; } catch { return false; }
}
export function identityStore() {
  if (!env.DB) throw new WorkspaceAuthError('configuration');
  return createIdentityStore(env.DB);
}

/** Fixed-origin transport; manual redirects protect headers in Workers. */
const authFetch: typeof fetch = async (input, init) => {
  let url: URL;
  try { url = new URL(input instanceof Request ? input.url : String(input)); }
  catch { throw new WorkspaceAuthError('configuration'); }
  if (url.origin !== HISABFLOW_SUPABASE_URL || !url.pathname.startsWith('/auth/v1/') || url.username || url.password) throw new WorkspaceAuthError('configuration');
  try {
    const response = await fetch(input,{...init,cache:'no-store',redirect:'manual',signal:AbortSignal.timeout(15000)});
    if (response.status >= 300 && response.status < 400) throw new WorkspaceAuthError('unavailable');
    return response;
  } catch { throw new WorkspaceAuthError('unavailable'); }
};

export type AuthCookie = { name: string; value: string };
export type AuthCookieUpdate = AuthCookie & { options: CookieOptions };
export type AuthCookieAdapter = {
  getAll(): AuthCookie[] | Promise<AuthCookie[]>;
  setAll(updates: AuthCookieUpdate[], headers?: Record<string, string>): void | Promise<void>;
};

/** Every adapter belongs to one request and persists all refreshed cookies. */
export function createAuthClientWithCookies(adapter: AuthCookieAdapter) {
  return createServerClient(HISABFLOW_SUPABASE_URL,configuredPublicKey(),{
    global:{fetch:authFetch},
    cookieOptions:{name:AUTH_COOKIE_NAME,...authCookieOptions()},
    cookies:{
      getAll:()=>adapter.getAll(),
      setAll:async(updates,headers)=>{
        const normalized=updates.map(update=>{
          const pendingFlow=isGooglePkceCookie(update.name) && update.value!=='' && update.options.maxAge!==0;
          return {...update,options:{...update.options,...authCookieOptions(),...(pendingFlow?{maxAge:AUTH_FLOW_TTL_MS/1000,expires:new Date(Date.now()+AUTH_FLOW_TTL_MS)}:{})}};
        });
        await adapter.setAll(normalized,headers);
      },
    },
  });
}

async function routeCookieAdapter(): Promise<AuthCookieAdapter> {
  const jar = await cookies();
  return {
    getAll:()=>jar.getAll(),
    setAll:updates=>{
      for(const update of updates) jar.set(update.name,update.value,update.options);
    },
  };
}

/** Route handlers can mutate cookies; Server Components must use the proxy guard. */
export async function createAuthClient() {
  return createAuthClientWithCookies(await routeCookieAdapter());
}

export async function getWorkspaceUserWithCookies(adapter: AuthCookieAdapter): Promise<WorkspaceUser|null> {
  const entries = await adapter.getAll();
  const selected = entries.some(cookie=>cookie.name===AUTH_PROVIDER_COOKIE && cookie.value==='google') || entries.some(cookie=>isGoogleSessionCookie(cookie.name));
  if (!selected) return null;
  const client = createAuthClientWithCookies(adapter);
  let verified;
  try {
    const {data,error} = await client.auth.getUser();
    if (error) throw new WorkspaceAuthError(!error.status || error.status >= 500 ? 'unavailable':'unauthenticated');
    verified = checkedGoogleIdentity(data.user);
  } catch(error) { throw error instanceof WorkspaceAuthError ? error : new WorkspaceAuthError('unavailable'); }
  return resolveWorkspaceIdentity({googleSelected:true,google:verified,ownerForGoogle:id=>identityStore().getOwnerForGoogle(id)});
}

export async function getWorkspaceUser(): Promise<WorkspaceUser|null> {
  return getWorkspaceUserWithCookies(await routeCookieAdapter());
}

export function authErrorResponse(error: unknown): Response {
  if (error instanceof WorkspaceAuthError) return Response.json({error:error.message,...(error.status===401?{code:'AUTH_SESSION_INVALID'}:{})},{status:error.status,headers:AUTH_RESPONSE_HEADERS});
  if (error instanceof AuthIdentityError && error.code === 'conflict') {
    const conflict = new WorkspaceAuthError('conflict');
    return Response.json({error:conflict.message},{status:conflict.status,headers:AUTH_RESPONSE_HEADERS});
  }
  const unavailable = new WorkspaceAuthError('unavailable');
  return Response.json({error:unavailable.message},{status:503,headers:AUTH_RESPONSE_HEADERS});
}

export async function clearGoogleCookies(includeSession = true) {
  const jar=await cookies();
  for (const cookie of jar.getAll()) {
    const owned = cookie.name === AUTH_FLOW_COOKIE || isGooglePkceCookie(cookie.name)
      || (includeSession && (cookie.name === AUTH_PROVIDER_COOKIE || isGoogleSessionCookie(cookie.name)));
    if (owned) jar.set(cookie.name,'',{...authCookieOptions(),maxAge:0});
  }
}

export function authRedirect(location: string, status = 303): Response {
  return new Response(null,{status,headers:{...AUTH_RESPONSE_HEADERS,Location:location}});
}

export async function sha256(value: string): Promise<string> {
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
