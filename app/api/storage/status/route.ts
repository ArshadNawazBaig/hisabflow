import { env } from 'cloudflare:workers';
import { getWorkspaceUser, authErrorResponse, AUTH_RESPONSE_HEADERS } from '@/lib/server/auth';
import { configuredWorkspaceProvider, configuredSupabaseStore, getWorkspaceStore, workspaceStorageMessage } from '@/lib/server/workspace-store';
import { HISABFLOW_SUPABASE_URL } from '@/lib/server/supabase-workspace';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  let user: Awaited<ReturnType<typeof getWorkspaceUser>>;
  try { user = await getWorkspaceUser(); } catch (error) { return authErrorResponse(error); }
  const json = (value:unknown,status=200) => Response.json(value,{status,headers:AUTH_RESPONSE_HEADERS});
  if (!user) return json({error:'Sign in to check your private workspace connection.'},401);
  try {
    const provider = configuredWorkspaceProvider();
    const probeSupabase = new URL(request.url).searchParams.get('probe') === 'supabase';
    // A readiness probe never migrates records or freezes the D1 source.
    const row = probeSupabase ? await configuredSupabaseStore().get(user.userId) : await getWorkspaceStore().get(user.userId);
    return json({provider,checked:probeSupabase?'supabase':provider,connected:true,workspaceFound:!!row,supabaseConfigured:!!env.SUPABASE_URL&&!!env.SUPABASE_SECRET_KEY,projectUrl:HISABFLOW_SUPABASE_URL,documents:env.BUCKET?'r2':'supabase'});
  } catch(error) {return json({connected:false,error:workspaceStorageMessage(error)},503);}
}
