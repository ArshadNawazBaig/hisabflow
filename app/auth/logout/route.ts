import { createAuthClient, clearGoogleCookies, authErrorResponse, authRedirect, googleAuthConfigured } from '@/lib/server/auth';
import { assertSameOriginAuthRequest } from '@/lib/server/auth-policy';

export const dynamic='force-dynamic';
export async function POST(request: Request) {
  try {assertSameOriginAuthRequest(request,import.meta.env.DEV,env.HISABFLOW_APP_ORIGIN);}
  catch(error) {return authErrorResponse(error);}
  try {
    if (googleAuthConfigured()) await (await createAuthClient()).auth.signOut({scope:'local'});
  } catch { /* Always clear this browser's cookies when remote sign-out fails. */ }
  await clearGoogleCookies();
  return authRedirect('/login');
}
import { env } from 'cloudflare:workers';
