import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createMigratingWorkspaceStore } from '../lib/server/workspace-migration.ts';

const data=()=>({business:'Synthetic migration business',currency:'PKR',openingCash:'10.00',companies:[],shipments:[],payments:[],imports:[],audit:[{id:'audit-1',at:'2026-10-31T00:00:00Z',actor:'Test owner',action:'Synthetic fixture',detail:'No real records'}]});
const row=(revision=7)=>({data:data(),revision});
function primary(existing=null) {
 let current=existing;
 return {get:async()=>current,save:async(_owner,data,revision)=>{if((current?.revision??0)!==revision)return null;return current={data,revision:revision+1}},insertExisting:async(_owner,value)=>current??=(structuredClone(value))};
}
test('migration verifies target before freezing and preserves all source evidence and revision',async()=>{
 const order=[],source=row(),target=primary();const pGet=target.get,targetInsert=target.insertExisting;
 target.get=async()=>{order.push('probe');return pGet()};target.insertExisting=async(...args)=>{order.push('insert');return targetInsert(...args)};
 const store=createMigratingWorkspaceStore(target,{freeze:async(owner,destination)=>{order.push('freeze');assert.equal(owner,'owner-A');assert.equal(destination,'approved-project');return source}},'approved-project');
 assert.deepEqual(await store.get('owner-A'),source);assert.deepEqual(order,['probe','freeze','insert']);assert.deepEqual(source,row());
 assert.deepEqual(await store.save('owner-A',data(),7),{data:data(),revision:8});
});
test('a target outage never freezes source or silently returns legacy data',async()=>{
 let frozen=false;const target=primary();target.get=async()=>{throw new Error('Target unavailable')};
 const store=createMigratingWorkspaceStore(target,{freeze:async()=>{frozen=true;return row()}},'target');
 await assert.rejects(store.get('owner-A'),/Target unavailable/);assert.equal(frozen,false);
});
test('existing target records remain authoritative without overwriting concurrent changes',async()=>{
 const authoritative=row(12),target=primary(authoritative);let frozen=false;
 const store=createMigratingWorkspaceStore(target,{freeze:async()=>{frozen=true;return row(7)}},'target');
 assert.deepEqual(await store.get('owner-A'),authoritative);assert.equal(frozen,true);assert.equal(await store.save('owner-A',data(),7),null);
});
test('source-copy failure retains the frozen source and retries insert without duplicate effects',async()=>{
 const source=row(),target=primary();let locked=false,fail=true;const insert=target.insertExisting;
 target.insertExisting=async(...args)=>{if(fail){fail=false;throw new Error('Network interruption')}return insert(...args)};
 const store=createMigratingWorkspaceStore(target,{freeze:async()=>{locked=true;return source}},'target');
 await assert.rejects(store.get('owner-A'));assert.equal(locked,true);assert.deepEqual(source,row());
 assert.deepEqual(await store.get('owner-A'),source);assert.deepEqual(await store.get('owner-A'),source);
});
test('an empty source still acquires its owner lock before a first target save',async()=>{
 let locked=false;const store=createMigratingWorkspaceStore(primary(),{freeze:async(owner)=>{assert.equal(owner,'new-owner');locked=true;return null}},'target');
 assert.deepEqual(await store.save('new-owner',data(),0),{data:data(),revision:1});assert.equal(locked,true);
});
function database(){const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../drizzle/0000_special_frog_thor.sql',import.meta.url),'utf8'));db.exec(readFileSync(new URL('../drizzle/0001_easy_maestro.sql',import.meta.url),'utf8'));return db;}
function seed(db,id='owner-A',revision=7){db.prepare('INSERT INTO workspaces(owner_id,data,revision,updated_at) VALUES(?,?,?,?)').run(id,JSON.stringify(data()),revision,'2026-10-31');}
function lock(db,id='owner-A'){db.prepare('INSERT INTO workspace_storage_locks(owner_id,target,locked_at) VALUES(?,?,?)').run(id,'approved-project','2026-10-31');}
test('SQLite migration locks block older code updates/deletes without modifying original financial data',()=>{
 const db=database();try{seed(db);lock(db);const before=db.prepare('SELECT * FROM workspaces').get();
 assert.throws(()=>db.prepare('UPDATE workspaces SET revision=revision+1 WHERE owner_id=? AND revision=?').run('owner-A',7),/moved to Supabase/);
 assert.throws(()=>db.prepare('DELETE FROM workspaces WHERE owner_id=?').run('owner-A'),/locked after migration/);
 assert.deepEqual(db.prepare('SELECT * FROM workspaces').get(),before);
 }finally{db.close()}
});
test('a write committed before the lock is the latest source revision copied afterward',()=>{
 const db=database();try{seed(db);db.prepare('UPDATE workspaces SET revision=revision+1 WHERE owner_id=?').run('owner-A');lock(db);assert.equal(db.prepare('SELECT revision FROM workspaces WHERE owner_id=?').get('owner-A').revision,8);}finally{db.close()}
});
test('locks stop first creates for migrated owners while other businesses remain writable',()=>{
 const db=database();try{lock(db,'new-owner');assert.throws(()=>seed(db,'new-owner'),/moved to Supabase/);seed(db,'owner-B');db.prepare('UPDATE workspaces SET revision=revision+1 WHERE owner_id=?').run('owner-B');assert.equal(db.prepare('SELECT revision FROM workspaces WHERE owner_id=?').get('owner-B').revision,8);}finally{db.close()}
});
