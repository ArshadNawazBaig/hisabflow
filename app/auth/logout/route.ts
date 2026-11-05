import { env } from 'cloudflare:workers';
import { createAuthClient, clearGoogleCookies, authErrorResponse, authRedirect, googleAuthConfigured, localAuthAllowed } from '@/lib/server/auth';
import { assertSameOriginAuthRequest } from '@/lib/server/auth-policy';

export const dynamic='force-dynamic';
export async function POST(request: Request) {
  try {assertSameOriginAuthRequest(request,localAuthAllowed(),env.HISABFLOW_APP_ORIGIN);}
  catch(error) {return authErrorResponse(error);}
  try {
    if (googleAuthConfigured()) await (await createAuthClient()).auth.signOut({scope:'local'});
  } catch { /* Always clear this browser's cookies when remote sign-out fails. */ }
  await clearGoogleCookies();
  return authRedirect('/login');
}
