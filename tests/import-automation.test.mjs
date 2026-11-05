import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAutomaticDraft, prepareAutomaticImport, commitAutomaticImports } from '../lib/import-automation.ts';
import { extractLedgerText } from '../lib/pdf-extract.ts';
import { validatePostedChanges, validateWorkspaceRecords, confirmedMargin, affectsCash } from '../lib/accounting.ts';
import { workspaceSchema } from '../lib/workspace-validation.ts';

// Entirely synthetic source text. No uploaded statements or customer data belong here.
const header='DATE | DESCRIPTIONS | PARTY | VEH. # | WEIGHT | RATE | TOTAL | PAID | PAYABLE | TID #';
const workspace=()=>({business:'Synthetic trading business',currency:'PKR',openingCash:'0.00',companies:[],shipments:[],payments:[],imports:[],audit:[]});
const choices=(changes={})=>({companyName:'Example Metals',relationship:'Supplier',perspective:'Supplier statement',unit:'Metric tonnes',history:'Complete history',...changes});
const hash=text=>createHash('sha256').update(text).digest('hex');
function ledger({name='Example Metals',goodsDate='01-10-2026',paymentDate='02-10-2026',goodsDescription='Material delivery',paymentDescription=`F/T to ${name} UBL account`,party='Example destination',vehicle='TEST-1',opening='0.00'}={}) {
  const afterGoods=opening==='0.00'?'1000.00':'1100.00';
  const closing=opening==='0.00'?'800.00':'900.00';
  return [`Statement of ${name}`,`Opening balance: ${opening}`,header,
    `${goodsDate} | ${goodsDescription} | ${party} | ${vehicle} | 10.000 | 100.00 | 1000.00 | | ${afterGoods} | delivery-note`,
    `${paymentDate} | ${paymentDescription} | | | | | | 200.00 | ${closing} | repeat-note`,
    `Closing balance | | | | | | | | ${closing} |`].join('\n');
}
function draft(text=ledger(),id='PDF-A',retained=true) {
  const digest=hash(text);
  return createAutomaticDraft(extractLedgerText(text),{id,name:`${id}.pdf`,hash:digest,fileKey:retained?`owners/synthetic/${digest}/${id}.pdf`:undefined,business:'Synthetic trading business',currency:'PKR'});
}
const prepare=(source,previous=workspace(),settings=choices())=>prepareAutomaticImport(source,previous,settings,'Synthetic owner');
const commit=(plans,previous=workspace(),confirmed=true)=>commitAutomaticImports(plans,previous,'Synthetic owner',confirmed);
function validPosting(result,previous) {
  assert.deepEqual(validateWorkspaceRecords(result.workspace,previous),[]);
  assert.deepEqual(validatePostedChanges(result.workspace,previous,'Synthetic owner'),[]);
  assert.equal(workspaceSchema.safeParse(result.workspace).success,true);
}

test('a clean supplier statement creates one company and posts its goods and bank transfer atomically',()=>{
  const previous=workspace(),snapshot=structuredClone(previous),source=draft(),plan=prepare(source,previous);
  assert.deepEqual(plan.blockers,[]);assert.equal(plan.reviewRows.length,0);assert.equal(plan.readyRows,2);
  assert.equal(source.mapping.unitsConfirmed,false);assert.ok(source.rows.every(row=>row.kind==='excluded'||row.status==='Needs review'));
  const result=commit([plan],previous);
  assert.deepEqual(previous,snapshot);assert.deepEqual(result.postedIds,['PDF-A']);assert.deepEqual(result.draftIds,[]);
  assert.equal(result.workspace.companies.length,1);assert.equal(result.workspace.companies[0].balance,'-800.00');
  assert.equal(result.workspace.shipments.length,1);assert.equal(result.workspace.payments.length,1);
  assert.equal(result.workspace.shipments[0].direction,'Receipt');assert.equal(result.workspace.payments[0].direction,'Paid');
  assert.equal(result.workspace.payments[0].treatment,'Supplier settlement');assert.equal(result.workspace.payments[0].actor,'Example Metals');
  assert.equal(result.workspace.imports[0].createdCompanyId,result.workspace.companies[0].id);
  assert.equal(affectsCash(result.workspace.payments[0]),false);
  assert.deepEqual(result.workspace.imports[0].rows.map(row=>[row.id,row.page,row.sequence,row.raw,row.rawDate]),source.rows.map(row=>[row.id,row.page,row.sequence,row.raw,row.rawDate]));
  validPosting(result,previous);
});
test('a reviewed CSV with ISO dates posts through the same accounting validation as PDF text',()=>{
  const source='DATE,DESCRIPTIONS,PARTY,VEH. #,WEIGHT,RATE,TOTAL,PAID,PAYABLE,TID #\n2026-10-01,"Material delivery, first load","Example destination, East",TEST-CSV,10.000,100.00,"1,000.00",,"1,000.00",00001\n2026-10-02,F/T to Example Metals UBL account,,,,,,200.00,800.00,00002\nClosing balance,,,,,,,,800.00,';
  const previous=workspace(),plan=prepare(draft(source,'CSV-A'),previous),result=commit([plan],previous);
  assert.deepEqual(plan.blockers,[]);assert.deepEqual(result.postedIds,['CSV-A']);
  assert.equal(result.workspace.shipments[0].date,'2026-10-01');
  assert.equal(result.workspace.shipments[0].deliveryParty,'Example destination, East');
  assert.equal(result.workspace.payments[0].reference,'00002');
  assert.equal(result.workspace.companies[0].balance,'-800.00');
  validPosting(result,previous);
});

test('a customer statement posts sales and receipts while leaving purchase costs unresolved',()=>{
  const previous=workspace(),name='Example Customer';
  const plan=prepare(draft(ledger({name,paymentDescription:`Received from ${name} MBL account`})),previous,choices({companyName:name,relationship:'Customer',perspective:'Customer statement'}));
  const result=commit([plan],previous);
  assert.equal(result.workspace.companies[0].role,'Customer');assert.equal(result.workspace.companies[0].balance,'800.00');
  assert.equal(result.workspace.shipments[0].direction,'Dispatch');assert.equal(result.workspace.payments[0].direction,'Received');
  assert.equal(result.workspace.payments[0].treatment,'Customer receipt');
  assert.equal(result.workspace.shipments[0].matchedId,undefined);assert.equal(result.workspace.shipments[0].costAllocations,undefined);
  assert.deepEqual(confirmedMargin(result.workspace),{amount:'0.00',unresolved:1});
  validPosting(result,previous);
});

test('delivery parties and named third-party remitters never become accounting companies',()=>{
  const previous=workspace(),source=draft(ledger({paymentDescription:'F/T to Example External Actor UBL account'}));
  const plan=prepare(source,previous);
  assert.equal(plan.batch.rows.find(row=>row.kind==='payment').treatment,'Payment on behalf');
  assert.throws(()=>commit([plan],previous,false),/Confirm the relationships/);
  const result=commit([plan],previous);
  assert.deepEqual(result.workspace.companies.map(company=>company.name),['Example Metals']);
  assert.equal(result.workspace.shipments[0].deliveryParty,'Example destination');assert.equal(result.workspace.payments[0].actor,'Example External Actor');
  assert.equal(result.workspace.payments[0].companyId,result.workspace.companies[0].id);
  validPosting(result,previous);
});

test('unknown dates, freight, rejected deliveries, and nonchronological source rows remain drafts with zero money',()=>{
  const cases=[
    ledger({goodsDate:'14/10/026'}),
    ledger({paymentDescription:'Freight paid to Example Transporter'}),
    ledger({goodsDescription:'Rejected material delivery'}),
    ledger({goodsDate:'03-10-2026',paymentDate:'02-10-2026'}),
  ];
  for(const [index,text] of cases.entries()) {
    const previous=workspace(),source=draft(text,`REVIEW-${index}`),plan=prepare(source,previous),result=commit([plan],previous);
    assert.ok(plan.reviewRows.length>0);assert.deepEqual(result.postedIds,[]);assert.equal(result.draftIds.length,1);
    assert.equal(result.workspace.companies[0].balance,'0.00');assert.equal(result.workspace.shipments.length,0);assert.equal(result.workspace.payments.length,0);
    assert.equal(result.workspace.imports[0].status,'Draft');assert.equal(result.workspace.imports[0].createdCompanyId,undefined);
    assert.deepEqual(result.workspace.imports[0].rows.map(row=>[row.id,row.rawDate,row.raw]),source.rows.map(row=>[row.id,row.rawDate,row.raw]));
    validPosting(result,previous);
  }
});

test('a missing relationship cannot create a company and owner confirmation is required',()=>{
  const previous=workspace(),snapshot=structuredClone(previous),source=draft();
  const unresolved=prepare(source,previous,choices({relationship:''}));
  assert.equal(unresolved.newCompany,null);assert.ok(unresolved.blockers.some(message=>message.includes('customer or supplier')));
  assert.throws(()=>commit([unresolved],previous),/Confirm a company relationship/);
  assert.throws(()=>commit([prepare(source,previous)],previous,false),/Confirm the relationships/);
  assert.deepEqual(previous,snapshot);
});

test('missing perspective, missing units, and conflicting perspective never post financial effects',()=>{
  for(const override of [{perspective:''},{unit:''},{perspective:'Customer statement'},{perspective:'Third-party statement'}]) {
    const previous=workspace(),plan=prepare(draft(),previous,choices(override));
    assert.ok(plan.blockers.length>0);
    const result=commit([plan],previous);
    assert.deepEqual(result.postedIds,[]);assert.equal(result.workspace.companies[0].balance,'0.00');
    assert.equal(result.workspace.shipments.length+result.workspace.payments.length,0);
  }
});

test('explicit payment wording that conflicts with the selected money direction remains in review',()=>{
  const previous=workspace();
  const customer=prepare(draft(),previous,choices({relationship:'Customer',perspective:'Customer statement'}));
  const supplier=prepare(draft(ledger({paymentDescription:'Received from Example Metals MBL account'})),previous);
  for(const plan of [customer,supplier]) {
    assert.ok(plan.reviewRows.some(row=>row.issues.some(issue=>issue.includes('conflicts with the selected direction'))));
    const result=commit([plan],previous);
    assert.deepEqual(result.postedIds,[]);assert.equal(result.workspace.companies[0].balance,'0.00');
  }
});

test('bank-account fallback cannot turn unrecognized incoming-payment wording into an outgoing settlement',()=>{
  for(const description of ['Transfer from Example External MBL account','Received via Example External UBL account']) {
    const previous=workspace(),plan=prepare(draft(ledger({paymentDescription:description})),previous);
    const payment=plan.batch.rows.find(row=>row.kind==='payment');
    assert.equal(payment.status,'Needs review');assert.equal(payment.treatment,undefined);
    const result=commit([plan],previous);
    assert.deepEqual(result.postedIds,[]);assert.equal(result.workspace.companies[0].balance,'0.00');
    assert.equal(result.workspace.payments.length,0);
  }
});

test('an existing company is matched by exact normalized name or reviewed alias without changing its role',()=>{
  const previous=workspace();previous.companies.push({id:'existing',name:'Example Metals Limited',role:'Supplier',aliases:['Example Metals'],balance:'0.00',status:'Active'});
  const plan=prepare(draft(),previous,choices({companyName:'  EXAMPLE   METALS  '})),result=commit([plan],previous);
  assert.equal(result.workspace.companies.length,1);assert.equal(result.workspace.companies[0].id,'existing');assert.equal(result.newCompanyIds.length,0);
  assert.equal(result.workspace.imports[0].createdCompanyId,undefined);validPosting(result,previous);
  const conflict=prepare(draft(),previous,choices({relationship:'Customer',perspective:'Customer statement'}));
  assert.ok(conflict.blockers.some(message=>message.includes('existing company role')));
});

test('ambiguous company aliases never select or create an accounting company',()=>{
  const previous=workspace();
  previous.companies=['one','two'].map(id=>({id,name:`Example company ${id}`,role:'Supplier',aliases:['Example Metals'],balance:'0.00',status:'Active'}));
  const plan=prepare(draft(),previous),snapshot=structuredClone(previous);
  assert.equal(plan.company,null);assert.equal(plan.newCompany,null);
  assert.ok(plan.blockers.some(message=>message.includes('Several company records')));
  assert.throws(()=>commit([plan],previous),/Confirm a company relationship/);
  assert.deepEqual(previous,snapshot);
});

test('the same hash cannot be committed twice or overwrite its posted statement',()=>{
  const previous=workspace(),plan=prepare(draft(),previous),snapshot=structuredClone(previous);
  assert.throws(()=>commit([plan,plan],previous),/same PDF/);assert.deepEqual(previous,snapshot);
  const first=commit([plan],previous),saved=structuredClone(first.workspace);
  assert.throws(()=>commit([plan],first.workspace),/statement already exists/);
  assert.deepEqual(first.workspace,saved);
});

test('a different file with overlapping transaction fingerprints remains a draft',()=>{
  const previous=workspace(),first=commit([prepare(draft(),previous)],previous);
  const repeated=draft(ledger()+'\nPage 1 of 1','PDF-OVERLAP');
  assert.notEqual(repeated.hash,first.workspace.imports[0].hash);
  const plan=prepare(repeated,first.workspace);
  assert.ok(plan.blockers.some(message=>message.includes('overlap')));
  const result=commit([plan],first.workspace);
  assert.deepEqual(result.postedIds,[]);assert.deepEqual(result.draftIds,['PDF-OVERLAP']);
  assert.equal(result.workspace.shipments.length,1);assert.equal(result.workspace.payments.length,1);assert.equal(result.workspace.companies[0].balance,'-800.00');
  validPosting(result,first.workspace);
});

test('several clean PDFs for the same exact company create it once and replay sequentially',()=>{
  const previous=workspace(),first=prepare(draft(),previous);
  const second=prepare(draft(ledger({goodsDate:'03-10-2026',paymentDate:'04-10-2026',vehicle:'TEST-2',goodsDescription:'Second material delivery'}),'PDF-B'),previous);
  const result=commit([first,second],previous);
  assert.equal(result.workspace.companies.length,1);assert.equal(result.newCompanyIds.length,1);assert.equal(result.workspace.companies[0].balance,'-1600.00');
  assert.deepEqual(result.postedIds,['PDF-A','PDF-B']);
  assert.equal(result.workspace.imports.filter(batch=>batch.createdCompanyId).length,1);
  assert.equal(result.workspace.imports[0].createdCompanyId,result.workspace.companies[0].id);assert.equal(result.workspace.imports[1].createdCompanyId,undefined);
  validPosting(result,previous);
});

test('a draft followed by a clean PDF for the same new company declares creation on the posted batch',()=>{
  const previous=workspace(),uncertain=prepare(draft(ledger({goodsDate:'14/10/026'}),'PDF-DRAFT'),previous);
  const clean=prepare(draft(ledger({goodsDate:'03-10-2026',paymentDate:'04-10-2026',vehicle:'TEST-2'}),'PDF-CLEAN'),previous);
  const result=commit([uncertain,clean],previous);
  assert.equal(result.workspace.companies.length,1);assert.equal(result.workspace.companies[0].balance,'-800.00');
  assert.deepEqual(result.postedIds,['PDF-CLEAN']);assert.deepEqual(result.draftIds,['PDF-DRAFT']);
  assert.equal(result.workspace.imports.find(batch=>batch.id==='PDF-CLEAN').createdCompanyId,result.workspace.companies[0].id);
  validPosting(result,previous);
});

test('forged preview readiness and company balances are recomputed before committing',()=>{
  const previous=workspace(),uncertain=prepare(draft(ledger({goodsDate:'14/10/026'})),previous);
  uncertain.reviewRows=[];uncertain.blockers=[];uncertain.readyRows=999;
  uncertain.batch.rows=uncertain.batch.rows.map(row=>row.kind==='excluded'?row:{...row,status:'Approved',reviewer:'Forged reviewer',reviewedAt:'2026-10-01T00:00:00Z'});
  const held=commit([uncertain],previous);
  assert.deepEqual(held.postedIds,[]);assert.equal(held.workspace.companies[0].balance,'0.00');
  const clean=prepare(draft(),previous);clean.newCompany.balance='999999.00';clean.company.balance='999999.00';
  const posted=commit([clean],previous);
  assert.equal(posted.workspace.companies[0].balance,'-800.00');validPosting(posted,previous);
});

test('a new company with a nonzero source opening balance stays in review',()=>{
  const previous=workspace(),plan=prepare(draft(ledger({opening:'100.00'})),previous);
  assert.ok(plan.blockers.some(message=>message.includes('source opening balance')));
  const result=commit([plan],previous);
  assert.deepEqual(result.postedIds,[]);assert.equal(result.workspace.companies[0].balance,'0.00');assert.equal(result.workspace.shipments.length,0);
});

test('nonzero openings cannot bypass new-company review through a preceding draft in the same commit',()=>{
  const previous=workspace(),first=prepare(draft(ledger({opening:'100.00'}),'PDF-OPEN-A'),previous);
  const second=prepare(draft(ledger({opening:'100.00',goodsDate:'03-10-2026',paymentDate:'04-10-2026',vehicle:'TEST-2'}),'PDF-OPEN-B'),previous);
  const result=commit([first,second],previous);
  assert.deepEqual(result.postedIds,[]);assert.equal(result.draftIds.length,2);assert.equal(result.workspace.companies[0].balance,'0.00');
  assert.equal(result.workspace.shipments.length+result.workspace.payments.length,0);
});

test('a previously saved zero-balance draft company still requires review of a nonzero source opening',()=>{
  const previous=workspace(),first=commit([prepare(draft(ledger({opening:'100.00'}),'PDF-OPEN-A'),previous)],previous);
  const later=prepare(draft(ledger({opening:'100.00',goodsDate:'03-10-2026',paymentDate:'04-10-2026',vehicle:'TEST-2'}),'PDF-OPEN-B'),first.workspace);
  assert.ok(later.blockers.some(message=>message.includes('source opening balance')));
  const result=commit([later],first.workspace);
  assert.deepEqual(result.postedIds,[]);assert.equal(result.workspace.companies[0].balance,'0.00');
  assert.equal(result.workspace.shipments.length+result.workspace.payments.length,0);
});

test('unreadable source pages hold the complete statement without partial postings',()=>{
  const previous=workspace(),source=draft();source.sourceMetadata.unreadablePages=[2];source.sourcePages=2;
  const plan=prepare(source,previous),result=commit([plan],previous);
  assert.ok(plan.blockers.some(message=>message.includes('Pages 2')));assert.deepEqual(result.postedIds,[]);
  assert.equal(result.workspace.companies[0].balance,'0.00');assert.equal(result.workspace.shipments.length,0);assert.equal(result.workspace.payments.length,0);
});

test('a failed-retention draft can be repaired using its same source ID and hash',()=>{
  for(const emptyKey of [undefined,'']) {
    const previous=workspace(),existing=draft(ledger(),'PDF-RETRY',false);existing.fileKey=emptyKey;previous.imports.push(existing);
    const repaired=structuredClone(existing);repaired.fileKey=`owners/synthetic/${existing.hash}/PDF-RETRY.pdf`;
    const result=commit([prepare(repaired,previous)],previous);
    assert.deepEqual(result.postedIds,['PDF-RETRY']);assert.equal(result.workspace.imports.length,1);
    assert.equal(result.workspace.imports[0].id,existing.id);assert.equal(result.workspace.imports[0].hash,existing.hash);
    assert.equal(result.workspace.imports[0].fileKey,repaired.fileKey);assert.equal(existing.fileKey,emptyKey);
    validPosting(result,previous);
  }
});

test('retained drafts cannot be overwritten and retention repair cannot change source identity',()=>{
  const retainedWorkspace=workspace(),retained=draft();retainedWorkspace.imports.push(retained);
  const retainedSnapshot=structuredClone(retainedWorkspace);
  assert.throws(()=>commit([prepare(retained,retainedWorkspace)],retainedWorkspace),/statement already exists/);
  assert.deepEqual(retainedWorkspace,retainedSnapshot);
  for(const change of [{id:'DIFFERENT-ID'},{hash:'f'.repeat(64)}]) {
    const previous=workspace(),original=draft(ledger(),'PDF-RETRY',false);previous.imports.push(original);
    const repair={...original,...change,fileKey:`owners/synthetic/${original.hash}/PDF-RETRY.pdf`};
    assert.throws(()=>commit([prepare(repair,previous)],previous),/statement already exists/);
    assert.equal(previous.imports[0].fileKey,undefined);assert.equal(previous.companies.length,0);
  }
});
