import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseWorkspaceStore, HISABFLOW_SUPABASE_URL, SupabaseWorkspaceError } from '../lib/server/supabase-workspace.ts';

const secret = 'sb_secret_unit_test_only_not_a_real_key';
const owner = 'test-owner';
const workspace = () => ({ business:'Fictional test business',currency:'PKR',companies:[],shipments:[],payments:[],imports:[],audit:[],openingCash:'0.00' });
const storedRow = (revision=1,data=workspace(),ownerId=owner) => ({owner_id:ownerId,data,revision});
const jwt = role => [Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'),Buffer.from(JSON.stringify({role})).toString('base64url'),'test_signature'].join('.');
function mock(responses) {
  const calls=[];
  const fetcher=async(input,init)=>{
    calls.push({url:new URL(String(input)),init});
    const next=responses.shift();
    if(next instanceof Error)throw next;
    if(typeof next==='function')return next(input,init);
    if(next instanceof Response)return next;
    return Response.json(next);
  };
  return {calls,fetcher};
}
const make = fetcher => createSupabaseWorkspaceStore({url:HISABFLOW_SUPABASE_URL,secretKey:secret,fetcher});

test('Supabase JSONB reads are owner-scoped and use only the modern apikey header',async()=>{
  const {calls,fetcher}=mock([[storedRow(7)]]),store=make(fetcher);
  assert.deepEqual(await store.get(owner),{data:workspace(),revision:7});
  assert.equal(calls.length,1);
  assert.equal(calls[0].url.origin,HISABFLOW_SUPABASE_URL);
  assert.equal(calls[0].url.pathname,'/rest/v1/hisabflow_workspaces');
  assert.equal(calls[0].url.searchParams.get('select'),'owner_id,data,revision');
  assert.equal(calls[0].url.searchParams.get('owner_id'),'eq.test-owner');
  assert.equal(calls[0].init.headers.apikey,secret);
  assert.equal(calls[0].init.headers.Authorization,undefined);
  assert.equal(calls[0].init.cache,'no-store');
  assert.equal(calls[0].init.redirect,'manual');
});

test('reserved owner characters remain one standalone equality value without added quotes',async()=>{
  const difficult='owner.&or=(owner_id.neq.any),"name"/\\folder:tag';
  const {calls,fetcher}=mock([[storedRow(1,workspace(),difficult)]]);
  assert.equal((await make(fetcher).get(difficult)).revision,1);
  const params=calls[0].url.searchParams;
  assert.deepEqual([...params.keys()].sort(),['limit','owner_id','select']);
  assert.equal(params.get('owner_id'),'eq.'+difficult);
  assert.equal(calls[0].url.pathname,'/rest/v1/hisabflow_workspaces');
});

test('missing owner records return null without consulting another store',async()=>{
  const {calls,fetcher}=mock([[]]);assert.equal(await make(fetcher).get(owner),null);assert.equal(calls.length,1);
});

test('redirects fail without following them or forwarding privileged headers',async()=>{
  const {calls,fetcher}=mock([new Response(null,{status:307,headers:{Location:'https://other.example/private'}})]);
  await assert.rejects(()=>make(fetcher).get(owner),error=>error.code==='unavailable');
  assert.equal(calls.length,1);
  assert.equal(calls[0].url.origin,HISABFLOW_SUPABASE_URL);
  assert.equal(calls[0].init.redirect,'manual');
});

test('a valid legacy service_role JWT sends both required authentication headers',async()=>{
  const key=jwt('service_role'),{calls,fetcher}=mock([[]]);
  await createSupabaseWorkspaceStore({url:HISABFLOW_SUPABASE_URL+'/',secretKey:key,fetcher}).get(owner);
  assert.equal(calls[0].init.headers.apikey,key);assert.equal(calls[0].init.headers.Authorization,`Bearer ${key}`);
});

test('publishable, anon, user, malformed, and whitespace credentials fail before network access',()=>{
  let calls=0;const fetcher=async()=>{calls++;return Response.json([])};
  for(const key of ['sb_publishable_test',jwt('anon'),jwt('authenticated'),'not-a-key','',secret+' ', 'sb_secret_line\nbreak']){
    assert.throws(()=>createSupabaseWorkspaceStore({url:HISABFLOW_SUPABASE_URL,secretKey:key,fetcher}),error=>error instanceof SupabaseWorkspaceError&&error.code==='configuration'&&(!key||!error.message.includes(key)));
  }
  assert.equal(calls,0);
});

test('credentials are never sent to another host, dashboard, path, insecure origin, or query string',()=>{
  let calls=0;const fetcher=async()=>{calls++;return Response.json([])};
  for(const url of ['https://example.com','http://coeazyvaghocoxuzngcc.supabase.co','https://supabase.com/dashboard/project/coeazyvaghocoxuzngcc',HISABFLOW_SUPABASE_URL+'/rest/v1',HISABFLOW_SUPABASE_URL+'?apikey=bad',HISABFLOW_SUPABASE_URL+'#fragment','https://coeazyvaghocoxuzngcc.supabase.co.evil.test',`https://user:pass@coeazyvaghocoxuzngcc.supabase.co`]){
    assert.throws(()=>createSupabaseWorkspaceStore({url,secretKey:secret,fetcher}),error=>error.code==='configuration'&&!error.message.includes(url));
  }
  assert.equal(calls,0);
});

test('creation uses the atomic CAS RPC with expected revision zero',async()=>{
  const data=workspace(),{calls,fetcher}=mock([[{data,revision:1}]]);
  assert.deepEqual(await make(fetcher).save(owner,data,0),{data,revision:1});
  assert.equal(calls[0].url.pathname,'/rest/v1/rpc/hisabflow_save_workspace');
  assert.equal(calls[0].init.method,'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body),{p_owner_id:owner,p_data:data,p_expected_revision:0});
});

test('updates send the current expected revision and accept only its increment',async()=>{
  const data=workspace(),{calls,fetcher}=mock([[{data,revision:5}]]);
  assert.deepEqual(await make(fetcher).save(owner,data,4),{data,revision:5});
  assert.equal(JSON.parse(calls[0].init.body).p_expected_revision,4);
});

test('stale CAS returns null with no automatic write retry',async()=>{
  const {calls,fetcher}=mock([[]]);
  assert.equal(await make(fetcher).save(owner,workspace(),4),null);assert.equal(calls.length,1);
});

test('RPC output must contain the exact submitted workspace and next safe revision',async()=>{
  for(const response of [[{data:workspace(),revision:7}],[{data:{...workspace(),openingCash:'9.00'},revision:5}],{data:workspace(),revision:5},[{data:workspace(),revision:5},{data:workspace(),revision:5}]]){
    const {fetcher}=mock([response]);await assert.rejects(()=>make(fetcher).save(owner,workspace(),4),error=>error.code==='response');
  }
});

test('JSONB property reordering does not create a false mutation',async()=>{
  const original=workspace();const reordered=Object.fromEntries(Object.entries(original).reverse());
  const {fetcher}=mock([[{data:reordered,revision:2}]]);
  assert.deepEqual((await make(fetcher).save(owner,original,1)).data,original);
});

test('wrong owner, duplicate owner rows, stringified JSONB, and unsafe revisions fail closed',async()=>{
  const responses=[
    [storedRow(1,workspace(),'another-owner')],
    [storedRow(),storedRow()],
    [{owner_id:owner,data:JSON.stringify(workspace()),revision:1}],
    [{owner_id:owner,data:workspace(),revision:'1'}],
    [storedRow(Number.MAX_SAFE_INTEGER+1)],
    [storedRow(0)],
    [{data:workspace(),revision:1}],
    [{owner_id:owner,data:{business:'Incomplete'},revision:1}],
  ];
  for(const response of responses){const {fetcher}=mock([response]);await assert.rejects(()=>make(fetcher).get(owner),error=>error.code==='response');}
});

test('invalid owner IDs and revisions are rejected without a request',async()=>{
  const {calls,fetcher}=mock([]),store=make(fetcher);
  for(const value of ['', '   ', 'x'.repeat(201), 'owner\nline'])await assert.rejects(()=>store.get(value),error=>error.code==='invalid-data');
  for(const revision of [-1,1.1,NaN,Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER+1])await assert.rejects(()=>store.save(owner,workspace(),revision),error=>error.code==='invalid-data');
  await assert.rejects(()=>store.save(owner,{...workspace(),companies:[null]},0),error=>error.code==='invalid-data');
  assert.equal(calls.length,0);
});

test('migration preserves the source data and revision through an insert-only request',async()=>{
  const data=workspace(),source={data,revision:19},{calls,fetcher}=mock([[storedRow(19,data)]]);
  assert.deepEqual(await make(fetcher).insertExisting(owner,source),source);
  assert.equal(calls[0].url.pathname,'/rest/v1/hisabflow_workspaces');
  assert.equal(calls[0].url.searchParams.get('on_conflict'),'owner_id');
  assert.equal(calls[0].url.searchParams.get('select'),'owner_id,data,revision');
  assert.equal(calls[0].init.headers.Prefer,'resolution=ignore-duplicates,return=representation');
  const sent=JSON.parse(calls[0].init.body);
  assert.equal(sent.owner_id,owner);assert.equal(sent.revision,19);assert.deepEqual(sent.data,data);assert.ok(Number.isFinite(Date.parse(sent.updated_at)));
});

test('a migration race reads the existing destination and never overwrites it',async()=>{
  const existing={...workspace(),business:'Existing destination business'},source={data:workspace(),revision:3};
  const {calls,fetcher}=mock([[],[storedRow(8,existing)]]);
  assert.deepEqual(await make(fetcher).insertExisting(owner,source),{data:existing,revision:8});
  assert.deepEqual(calls.map(c=>c.init.method),['POST','GET']);
});

test('inconsistent migration responses fail closed rather than pretending a copy succeeded',async()=>{
  for(const response of [[storedRow(1)], [storedRow(4,{...workspace(),openingCash:'2.00'})]]){
    const {fetcher}=mock([response]);await assert.rejects(()=>make(fetcher).insertExisting(owner,{data:workspace(),revision:4}),error=>error.code==='response');
  }
  const {calls,fetcher}=mock([[],[]]);await assert.rejects(()=>make(fetcher).insertExisting(owner,{data:workspace(),revision:4}),error=>error.code==='response');assert.equal(calls.length,2);
});

test('remote error bodies, credential text, and submitted private data are never exposed',async()=>{
  for(const status of [400,401,403,404,409,500]){
    const privateText=`${secret}: private business ${owner}`;
    const {calls,fetcher}=mock([new Response(privateText,{status})]);
    await assert.rejects(()=>make(fetcher).save(owner,workspace(),0),error=>!error.message.includes(secret)&&!error.message.includes(owner)&&!error.message.includes('private business'));
    assert.equal(calls.length,1);
  }
  const {fetcher}=mock([new Error(`Network failed with ${secret}`)]);
  await assert.rejects(()=>make(fetcher).get(owner),error=>error.code==='unavailable'&&!error.message.includes(secret));
});

test('missing table/RPC errors identify schema setup without disclosing server details',async()=>{
  const {fetcher}=mock([new Response('not found',{status:404})]);
  await assert.rejects(()=>make(fetcher).get(owner),error=>error.code==='schema'&&error.message.includes('migration'));
});

test('malformed success bodies and oversized responses are rejected',async()=>{
  const responses=[new Response('not json',{status:200}),new Response('[]',{status:200,headers:{'Content-Length':String(11*1024*1024)}})];
  for(const response of responses){const {fetcher}=mock([response]);await assert.rejects(()=>make(fetcher).get(owner),error=>error.code==='response');}
});

test('timeouts abort the request and never repeat an uncertain write',async()=>{
  let calls=0,signal;
  const fetcher=async(_input,init)=>{calls++;signal=init.signal;return new Promise(()=>{})};
  const store=createSupabaseWorkspaceStore({url:HISABFLOW_SUPABASE_URL,secretKey:secret,fetcher,timeoutMs:5});
  await assert.rejects(()=>store.save(owner,workspace(),0),error=>error.code==='timeout'&&!error.message.includes(secret));
  assert.equal(signal.aborted,true);assert.equal(calls,1);
});
