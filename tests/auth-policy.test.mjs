import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedProductionOrigin, approvedAppOrigin, assertSameOriginAuthRequest, checkedGoogleIdentity, resolveWorkspaceIdentity, assertCallbackOwner, isGoogleSessionCookie, isGooglePkceCookie, AUTH_COOKIE_NAME, WorkspaceAuthError } from '../lib/server/auth-policy.ts';

const origin='https://hisabflow.example.com';
const google={id:'12345678-1234-1234-1234-123456789abc',email:'owner@example.com',email_confirmed_at:'2026-10-31T00:00:00Z',identities:[{provider:'google'}],user_metadata:{full_name:'Display name'}};
const rejected=code=>error=>error instanceof WorkspaceAuthError && error.code===code;

test('production origins come only from a validated server configuration',()=>{
  assert.equal(checkedProductionOrigin(origin),origin);
  assert.equal(approvedAppOrigin(new Request(origin+'/auth/google'),false,origin),origin);
  assert.throws(()=>approvedAppOrigin(new Request('https://other.example/auth/google'),false,origin),rejected('origin'));
});

test('production origin configuration fails closed when missing or containing credentials, paths, query, or insecure protocol',()=>{
  for(const value of [undefined,'','http://hisabflow.example.com','https://user:password@hisabflow.example.com','https://hisabflow.example.com/path','https://hisabflow.example.com?secret=value','https://hisabflow.example.com#fragment']){
    assert.throws(()=>checkedProductionOrigin(value),rejected('configuration'));
  }
});

test('localhost is allowed only for development requests',()=>{
  for(const local of ['http://127.0.0.1:5173','http://localhost:5173','http://[::1]:5173']){
    assert.equal(approvedAppOrigin(new Request(local+'/auth/google'),true),local);
    assert.throws(()=>approvedAppOrigin(new Request(local+'/auth/google'),false,origin),rejected('origin'));
  }
});

test('sign-in and sign-out reject cross-origin and unspecified navigation requests',()=>{
  assert.equal(assertSameOriginAuthRequest(new Request(origin+'/auth/google',{method:'POST',headers:{Origin:origin}}),false,origin),origin);
  for(const headers of [{Origin:'https://other.example'},{Origin:'null'},{'Sec-Fetch-Site':'cross-site'},{}]){
    assert.throws(()=>assertSameOriginAuthRequest(new Request(origin+'/auth/google',{method:'POST',headers}),false,origin),rejected('origin'));
  }
  assert.equal(assertSameOriginAuthRequest(new Request(origin+'/auth/logout',{method:'POST',headers:{'Sec-Fetch-Site':'same-origin'}}),false,origin),origin);
});

test('session detection distinguishes session chunks from a pending PKCE verifier',()=>{
  assert.equal(isGoogleSessionCookie(AUTH_COOKIE_NAME),true);
  assert.equal(isGoogleSessionCookie(AUTH_COOKIE_NAME+'.0'),true);
  assert.equal(isGoogleSessionCookie(AUTH_COOKIE_NAME+'.12'),true);
  assert.equal(isGoogleSessionCookie(AUTH_COOKIE_NAME+'-code-verifier'),false);
  assert.equal(isGoogleSessionCookie(AUTH_COOKIE_NAME+'.bad'),false);
});

test('cleanup recognizes all current SSR flow verifier cookies without clearing sessions or other applications',()=>{
  for(const name of [
    'hisabflow-google-session-code-verifier',
    'hisabflow-google-session-code-verifier.0',
    'hisabflow-google-session-flows-code-verifier',
    'hisabflow-google-session-flows-code-verifier.1',
    'hisabflow-google-session-flow-7c59947d79f9e0bc6d138684ade9e4b4-code-verifier',
  ]) assert.equal(isGooglePkceCookie(name),true);
  for(const name of [AUTH_COOKIE_NAME,AUTH_COOKIE_NAME+'.0','another-app-code-verifier','hisabflow-oauth-flow'])assert.equal(isGooglePkceCookie(name),false);
});

test('a server-verified Google identity requires confirmed email and a Google provider identity',()=>{
  assert.deepEqual(checkedGoogleIdentity(google),{id:google.id,email:google.email,fullName:'Display name'});
  for(const invalid of [null,{...google,id:'not-a-uuid'},{...google,email:''},{...google,email_confirmed_at:undefined},{...google,identities:[{provider:'email'}]},{...google,identities:[]}]){
    assert.throws(()=>checkedGoogleIdentity(invalid),rejected('unauthenticated'));
  }
});

test('display metadata never selects or changes a workspace owner',async()=>{
  const verified=checkedGoogleIdentity({...google,user_metadata:{full_name:'other-owner'}});
  let lookedUp;
  const user=await resolveWorkspaceIdentity({googleSelected:true,google:verified,ownerForGoogle:async id=>{lookedUp=id;return 'canonical-existing-owner';}});
  assert.equal(lookedUp,google.id);
  assert.equal(user.userId,'canonical-existing-owner');
  assert.equal(user.provider,'google');
  assert.equal(user.canLinkGoogle,false);
});

test('an unsigned request stays unsigned and performs no owner lookup',async()=>{
  let calls=0;
  assert.equal(await resolveWorkspaceIdentity({googleSelected:false,google:null,ownerForGoogle:async()=>{calls++;return 'owner';}}),null);
  assert.equal(calls,0);
});

test('invalid or unmapped Google sessions fail closed without another login fallback',async()=>{
  await assert.rejects(()=>resolveWorkspaceIdentity({googleSelected:true,google:null,ownerForGoogle:async()=> 'owner'}),rejected('unauthenticated'));
  await assert.rejects(()=>resolveWorkspaceIdentity({googleSelected:true,google:checkedGoogleIdentity(google),ownerForGoogle:async()=>null}),rejected('unlinked'));
});

test('callback accepts only an unexpired Google sign-in flow without a legacy owner',()=>{
  const now=1000;
  assert.doesNotThrow(()=>assertCallbackOwner({intent:'signin',sitesOwnerId:null,expiresAt:now+1},now));
  assert.throws(()=>assertCallbackOwner({intent:'link',sitesOwnerId:'legacy-owner',expiresAt:now+1},now),rejected('unauthenticated'));
  assert.throws(()=>assertCallbackOwner({intent:'signin',sitesOwnerId:'legacy-owner',expiresAt:now+1},now),rejected('unauthenticated'));
  assert.throws(()=>assertCallbackOwner({intent:'signin',sitesOwnerId:null,expiresAt:now},now),rejected('expired'));
});
