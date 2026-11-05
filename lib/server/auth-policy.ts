export const AUTH_COOKIE_NAME = 'hisabflow-google-session';
export const AUTH_PROVIDER_COOKIE = 'hisabflow-auth-provider';
export const AUTH_FLOW_COOKIE = 'hisabflow-oauth-flow';
export const AUTH_FLOW_TTL_MS = 10 * 60 * 1000;
export const AUTH_RESPONSE_HEADERS = {
  'Cache-Control': 'private, no-cache, no-store, must-revalidate, max-age=0',
  Pragma: 'no-cache',
  Expires: '0',
};

type AuthErrorCode = 'configuration' | 'unavailable' | 'unauthenticated' | 'unlinked' | 'conflict' | 'origin' | 'expired';
export class WorkspaceAuthError extends Error {
  readonly code: AuthErrorCode;
  readonly status: number;
  constructor(code: AuthErrorCode) {
    super({
      configuration: 'Google sign-in is not configured. Please contact the workspace owner.',
      unavailable: 'Sign-in could not be verified. Please retry without changing accounts.',
      unauthenticated: 'Your Google session could not be verified. Sign in again or sign out to reset it.',
      unlinked: 'This Google account has not been connected to a workspace. Please finish signing in.',
      conflict: 'This Google account or workspace is already connected to a different account.',
      origin: 'This sign-in action must start from HisabFlow.',
      expired: 'This sign-in attempt expired or has already been used. Please start again.',
    }[code]);
    this.name = 'WorkspaceAuthError';
    this.code = code;
    this.status = code === 'configuration' || code === 'unavailable' ? 503 : code === 'origin' ? 403 : code === 'conflict' ? 409 : 401;
  }
}

export function checkedProductionOrigin(value?: string): string {
  try {
    if (!value) throw new Error();
    const origin=new URL(value);
    if (origin.protocol!=='https:' || origin.username || origin.password || origin.pathname!=='/' || origin.search || origin.hash) throw new Error();
    return origin.origin;
  } catch {throw new WorkspaceAuthError('configuration');}
}

/** Only the local launcher may set this binding; request headers never enable it. */
export function allowLocalAuthentication(development: boolean, localRuntime?: unknown): boolean {
  return development || localRuntime === '1';
}

export function approvedAppOrigin(request: Request, allowLocalhost: boolean, configuredOrigin?: string): string {
  let url: URL;
  try { url = new URL(request.url); } catch { throw new WorkspaceAuthError('origin'); }
  if (allowLocalhost && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return url.origin;
  if (url.origin === checkedProductionOrigin(configuredOrigin)) return url.origin;
  throw new WorkspaceAuthError('origin');
}

export function assertSameOriginAuthRequest(request: Request, allowLocalhost: boolean, configuredOrigin?: string): string {
  const origin = approvedAppOrigin(request, allowLocalhost, configuredOrigin);
  const sentOrigin = request.headers.get('origin');
  if (sentOrigin ? sentOrigin !== origin : request.headers.get('sec-fetch-site') !== 'same-origin') {
    throw new WorkspaceAuthError('origin');
  }
  return origin;
}

export function isGoogleSessionCookie(name: string): boolean {
  return name === AUTH_COOKIE_NAME || /^hisabflow-google-session\.\d+$/.test(name);
}

export function isGooglePkceCookie(name: string): boolean {
  return /^hisabflow-google-session(?:-flows|-flow-[A-Za-z0-9_-]+)?-code-verifier(?:\.\d+)?$/.test(name);
}

export type VerifiedGoogleIdentity = { id: string; email: string; fullName: string | null };
type UnverifiedAuthUser = {
  id?: unknown;
  email?: unknown;
  email_confirmed_at?: unknown;
  identities?: { provider?: unknown }[];
  user_metadata?: { full_name?: unknown; name?: unknown };
};

/** Input must come from auth.getUser(), never from a cookie/session payload. */
export function checkedGoogleIdentity(value: UnverifiedAuthUser | null): VerifiedGoogleIdentity {
  if (!value || typeof value.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.id)
    || typeof value.email !== 'string' || !value.email || value.email.length > 320
    || typeof value.email_confirmed_at !== 'string' || !value.email_confirmed_at
    || !value.identities?.some(identity => identity.provider === 'google')) {
    throw new WorkspaceAuthError('unauthenticated');
  }
  const rawName = value.user_metadata?.full_name ?? value.user_metadata?.name;
  return { id: value.id, email: value.email, fullName: typeof rawName === 'string' && rawName.trim() ? rawName.slice(0,200) : null };
}

export type WorkspaceUser = {
  userId: string;
  displayName: string;
  email: string;
  fullName: string | null;
  provider: 'google';
  canLinkGoogle: boolean;
};

export async function resolveWorkspaceIdentity(options: {
  googleSelected: boolean;
  google: VerifiedGoogleIdentity | null;
  ownerForGoogle: (id: string) => Promise<string|null>;
}): Promise<WorkspaceUser|null> {
  if (!options.googleSelected) return null;
  if (!options.google) throw new WorkspaceAuthError('unauthenticated');
  const owner = await options.ownerForGoogle(options.google.id);
  if (!owner) throw new WorkspaceAuthError('unlinked');
  return {userId:owner,displayName:options.google.fullName || options.google.email,email:options.google.email,fullName:options.google.fullName,provider:'google',canLinkGoogle:false};
}

export function assertCallbackOwner(flow: {intent:'signin'|'link';sitesOwnerId:string|null;expiresAt:number}, now: number): void {
  if (flow.expiresAt <= now) throw new WorkspaceAuthError('expired');
  // Legacy link attempts cannot select a former hosting identity after the
  // application has switched to Google-only authentication.
  if (flow.intent !== 'signin' || flow.sitesOwnerId !== null) throw new WorkspaceAuthError('unauthenticated');
}
