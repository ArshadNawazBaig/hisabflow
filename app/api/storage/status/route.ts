import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '../../../chatgpt-auth';
import { configuredWorkspaceProvider, configuredSupabaseStore, getWorkspaceStore, workspaceStorageMessage } from '@/lib/server/workspace-store';
import { HISABFLOW_SUPABASE_URL } from '@/lib/server/supabase-workspace';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  const json = (value:unknown,status=200) => Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
  if (!user) return json({error:'Sign in to check your private workspace connection.'},401);
  try {
    const provider = configuredWorkspaceProvider();
    const probeSupabase = new URL(request.url).searchParams.get('probe') === 'supabase';
    // A readiness probe never migrates records or freezes the D1 source.
    const row = probeSupabase ? await configuredSupabaseStore().get(user.userId) : await getWorkspaceStore().get(user.userId);
    return json({provider,checked:probeSupabase?'supabase':provider,connected:true,workspaceFound:!!row,supabaseConfigured:!!env.SUPABASE_URL&&!!env.SUPABASE_SECRET_KEY,projectUrl:HISABFLOW_SUPABASE_URL,documents:'r2'});
  } catch(error) {return json({connected:false,error:workspaceStorageMessage(error)},503);}
}
