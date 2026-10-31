import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { createSupabaseWorkspaceStore, HISABFLOW_SUPABASE_URL } from '../lib/server/supabase-workspace.ts';

// Read configuration locally without displaying or evaluating credential values.
let values={};
// Match Wrangler: an existing .dev.vars takes precedence over .env.
for(const filename of ['.dev.vars','.env']){
 try {
  values=parseEnv(await readFile(new URL(`../${filename}`,import.meta.url),'utf8'));
  break;
 }catch(error){if(error.code!=='ENOENT'){process.stderr.write('Could not read the local Supabase configuration.\n');process.exit(1);}}
}
const url=process.env.SUPABASE_URL||values.SUPABASE_URL||process.env.NEXT_PUBLIC_SUPABASE_URL||values.NEXT_PUBLIC_SUPABASE_URL||HISABFLOW_SUPABASE_URL;
const secretKey=process.env.SUPABASE_SECRET_KEY||values.SUPABASE_SECRET_KEY||'';
try{
 if(!secretKey)throw new Error('Add SUPABASE_SECRET_KEY privately to .env, .dev.vars, or the server environment. A NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY cannot authorize HisabFlow server storage.');
 const store=createSupabaseWorkspaceStore({url,secretKey});
 await store.get('hisabflow-readiness-probe');
 const headers={apikey:secretKey,'Content-Type':'application/json'};
 if(!secretKey.startsWith('sb_secret_'))headers.Authorization=`Bearer ${secretKey}`;
 // Deliberately invalid revision exercises the RPC guard without writing a row.
 const result=await fetch(`${HISABFLOW_SUPABASE_URL}/rest/v1/rpc/hisabflow_save_workspace`,{method:'POST',headers,redirect:'error',signal:AbortSignal.timeout(15000),body:JSON.stringify({p_owner_id:'hisabflow-readiness-probe',p_data:{},p_expected_revision:-1})});
 const body=await result.json();
 if(result.status!==400||body.code!=='22023')throw new Error('The Supabase save function is not ready. Apply the HisabFlow SQL migration and verify server permissions.');
 process.stdout.write('Supabase read access and the guarded save function are reachable. No business records were changed; verify a controlled create/update round trip before activation.\n');
}catch(error){process.stderr.write((error instanceof Error?error.message:'Supabase connection could not be verified.')+'\n');process.exitCode=1;}
