import { getWorkspaceUser, googleAuthConfigured, authErrorResponse, AUTH_RESPONSE_HEADERS } from '@/lib/server/auth';

export const dynamic='force-dynamic';
export async function GET() {
  try {
    const user=await getWorkspaceUser();
    return Response.json({signedIn:!!user,user:user?{id:user.userId,name:user.displayName,email:user.email,provider:user.provider,canLinkGoogle:user.canLinkGoogle}:null,googleConfigured:googleAuthConfigured()},{headers:AUTH_RESPONSE_HEADERS});
  } catch(error) {return authErrorResponse(error);}
}
