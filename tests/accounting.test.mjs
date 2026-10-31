import test from 'node:test';
import assert from 'node:assert/strict';
import { add, subtract, multiply, reconcile, validateImport, postImport, confirmedMargin, validatePostedChanges, validateWorkspaceRecords, affectsCash } from '../lib/accounting.ts';

const workspace = () => ({ business:'Private test business',currency:'PKR',openingCash:'0.00',companies:[{id:'supplier',name:'Fictional supplier',role:'Supplier',aliases:[],balance:'0.00',status:'Active'},{id:'customer',name:'Fictional customer',role:'Customer',aliases:[],balance:'0.00',status:'Active'}],shipments:[],payments:[],imports:[],audit:[] });
const sourceRow = (changes={}) => ({id:'r1',page:1,sequence:1,rawDate:'16/10/2026',proposedDate:'2026-10-16',effectiveDate:'2026-10-16',description:'Goods delivered',party:'Warehouse A',vehicle:'DEMO-001',weight:'2.125',rate:'40000.00',goods:'85000.00',paid:'0.00',balance:'85000.00',reference:'',kind:'goods',status:'Approved',issues:[],raw:'16/10/2026 Goods delivered Warehouse A DEMO-001 2.125 40000 85000',reviewer:'Reviewer',reviewedAt:'2026-10-31T00:00:00Z',...changes});
const batch = (changes={}) => ({id:'BATCH-1',name:'synthetic.pdf',hash:'synthetic-source-hash',fileKey:'owners/test/synthetic.pdf',createdAt:'2026-10-31T00:00:00Z',status:'Draft',step:5,mapping:{business:'Private test business',issuer:'Fictional issuer',counterpartyId:'supplier',perspective:'Supplier statement',partyMeaning:'Delivery destination',currency:'PKR',unit:'tonnes',unitsConfirmed:true,history:'Complete history',mode:'Transactions',cutoff:'',direction:'Receipt',openingBalance:'0.00',expectedClosing:'85000.00'},rows:[sourceRow()],...changes});

test('decimal money operations preserve cents and millitonne quantities',()=>{
  assert.equal(add('0.10','0.20'),'0.30');
  assert.equal(subtract('1000000000000.01','999999999999.99'),'0.02');
  assert.equal(multiply('28.940','39500.00'),'1143130.00');
  assert.equal(multiply('0.495','40000.00'),'19800.00');
  assert.equal(multiply('0.001','1.50'),'0.00');
  assert.equal(multiply('0.01','1.50'),'0.02');
});
test('source reconciliation preserves original row order and excludes repeated closing totals',()=>{
  const rows=[sourceRow(),sourceRow({id:'r2',sequence:2,rawDate:'15/10/2026',goods:'0',paid:'10000.00',balance:'75000.00',kind:'payment'}),sourceRow({id:'footer',sequence:3,goods:'75000',paid:'0',balance:'75000',kind:'excluded',status:'Excluded'})];
  const r=reconcile(rows);
  assert.equal(r.goods,'85000.00'); assert.equal(r.paid,'10000.00'); assert.equal(r.closing,'75000.00');
  assert.equal(r.goodsCount,1); assert.equal(r.paymentCount,1); assert.equal(r.transitions.length,2); assert.equal(r.balanced,true);
  assert.deepEqual(r.transitions.map(t=>t.id),['r1','r2']);
});
test('provided statement aggregate checks are independent of accounting roles',()=>{
  // Aggregate evidence supplied in the brief; actual PDF row fixtures were not provided.
  assert.equal(subtract('9904680.00','9515500.00'),'389180.00');
  assert.equal(subtract('51765114.50','49908870.00'),'1856244.50');
});
test('unconfirmed issuer perspective, currency and units block posting',()=>{
  const b=batch(); b.mapping.perspective=''; b.mapping.unitsConfirmed=false;
  const errors=validateImport(b,workspace());
  assert.ok(errors.some(e=>e.includes('perspective'))); assert.ok(errors.some(e=>e.includes('currency and weight')));
  assert.throws(()=>postImport(b,workspace(),'Reviewer'));
});
test('anomalous raw dates stay raw and need an approved effective date',()=>{
  const b=batch({rows:[sourceRow({rawDate:'22/07/026',proposedDate:'2026-07-22',effectiveDate:'',status:'Needs review',issues:['Date format is ambiguous']})]});
  assert.ok(validateImport(b,workspace()).some(e=>e.includes('effective date')));
  assert.equal(b.rows[0].rawDate,'22/07/026'); assert.equal(b.rows[0].effectiveDate,'');
});
test('rejected delivery retains its positive source amount without invented refunds',()=>{
  const b=batch({rows:[sourceRow({reference:'Rejected'})]});
  const posted=postImport(b,workspace(),'Reviewer');
  assert.equal(posted.shipments[0].status,'Rejected'); assert.equal(posted.shipments[0].amount,'85000.00');
  assert.equal(posted.companies[0].balance,'-85000.00'); assert.equal(posted.payments.length,0);
  assert.equal(posted.shipments[0].relatedDocument,undefined);
});
test('third-party payment settles only the deliberately allocated company',()=>{
  const b=batch({rows:[sourceRow(),sourceRow({id:'r2',sequence:2,goods:'0.00',paid:'10000.00',balance:'75000.00',kind:'payment',description:'Paid logistics on behalf of supplier',actor:'Fictional transporter',companyId:'supplier',treatment:'Payment on behalf',reference:'note-in-reference'})]});
  b.mapping.expectedClosing='75000.00';
  const posted=postImport(b,workspace(),'Reviewer');
  assert.equal(posted.companies[0].balance,'-75000.00'); assert.equal(posted.companies[1].balance,'0.00');
  assert.equal(posted.payments[0].actor,'Fictional transporter'); assert.equal(posted.payments[0].companyId,'supplier');
  assert.equal(posted.payments[0].reference,'note-in-reference'); assert.match(posted.payments[0].account,/Unassigned/);
});
test('reimporting a posted batch or identical source hash cannot duplicate records',()=>{
  const b=batch(), posted=postImport(b,workspace(),'Reviewer');
  assert.throws(()=>postImport(b,posted,'Reviewer'),/already posted/);
  const copy={...b,id:'BATCH-2'};
  assert.ok(validateImport(copy,posted).some(e=>e.includes('already been imported')));
  assert.equal(posted.shipments.length,1);
});
test('overlap detection uses multiple row attributes, not amount or TID alone',()=>{
  const b=batch(), posted=postImport(b,workspace(),'Reviewer');
  const newBatch=batch({id:'BATCH-2',hash:'different-source-hash'});
  assert.ok(validateImport(newBatch,posted).some(e=>e.includes('overlap')));
  newBatch.rows[0].description='A separate legitimate delivery';
  assert.ok(!validateImport(newBatch,posted).some(e=>e.includes('overlap')));
});
test('an opening balance cannot be posted over the imported history',()=>{
  const b=batch(), posted=postImport(b,workspace(),'Reviewer');
  const opening=batch({id:'OPEN-BATCH',hash:'different-source-hash'}); opening.mapping.mode='Opening balance'; opening.mapping.cutoff='2026-10-31';
  assert.ok(validateImport(opening,posted).some(e=>e.includes('existing counterparty history')));
});
test('unconfirmed shipment candidates and missing costs never fabricate margin',()=>{
  const d=workspace();
  const purchase={id:'purchase',direction:'Receipt',amount:'85000.00',matchedId:'sale',matchConfirmed:false};
  const sale={id:'sale',direction:'Dispatch',amount:'90000.00',matchedId:'purchase',matchConfirmed:false};
  d.shipments=[purchase,sale];
  assert.deepEqual(confirmedMargin(d),{amount:'0.00',unresolved:1});
  purchase.matchConfirmed=true; sale.matchConfirmed=true;
  assert.deepEqual(confirmedMargin(d),{amount:'5000.00',unresolved:0});
  d.shipments=[sale]; assert.deepEqual(confirmedMargin(d),{amount:'0.00',unresolved:1});
});
test('imported records retain file, source page, source row and audit traceability',()=>{
  const posted=postImport(batch(),workspace(),'Reviewer'), s=posted.shipments[0];
  assert.equal(s.sourceRef,'BATCH-1'); assert.equal(s.sourcePage,1); assert.equal(s.sourceRow,1);
  assert.equal(s.attachment,'owners/test/synthetic.pdf'); assert.equal(posted.audit[0].actor,'Reviewer');
  assert.ok(posted.imports[0].postedRecordIds.includes(s.id)); assert.equal(posted.imports[0].rows[0].raw,sourceRow().raw);
});
test('unresolved treatment does not turn a profit-looking description into income',()=>{
  const b=batch({rows:[sourceRow({goods:'0.00',weight:'',rate:'',paid:'10000.00',balance:'-10000.00',kind:'payment',description:'send to munafa',actor:'Unknown actor',companyId:'supplier'})]});
  b.mapping.expectedClosing='-10000.00';
  assert.ok(validateImport(b,workspace()).some(e=>e.includes('accounting treatment')));
});
test('server-side posting validation rejects forged posted records and balances',()=>{
  const before=workspace(), posted=postImport(batch(),before,'Reviewer');
  assert.deepEqual(validatePostedChanges(posted,before,'Reviewer'),[]);
  const forged=structuredClone(posted); forged.shipments[0].amount='1.00'; forged.companies[0].balance='999999.00';
  const errors=validatePostedChanges(forged,before,'Reviewer');
  assert.ok(errors.some(e=>e.includes('shipment differs'))); assert.ok(errors.some(e=>e.includes('balance')));
});
test('posting validation has no partial effects when one row fails',()=>{
  const before=workspace(), snapshot=structuredClone(before);
  const b=batch({rows:[sourceRow(),sourceRow({id:'bad',sequence:2,effectiveDate:'',status:'Needs review',goods:'100.00',weight:'',rate:'',balance:'85100.00'})]});
  b.mapping.expectedClosing='85100.00';
  assert.throws(()=>postImport(b,before,'Reviewer'));
  assert.deepEqual(before,snapshot); assert.equal(before.shipments.length,0); assert.equal(before.companies[0].balance,'0.00');
});
test('posted source evidence is immutable on subsequent snapshot writes',()=>{
  const posted=postImport(batch(),workspace(),'Reviewer'), forged=structuredClone(posted);
  forged.imports[0].rows[0].raw='altered source evidence';
  assert.ok(validatePostedChanges(forged,posted,'Reviewer').some(e=>e.includes('immutable')));
});
const shipment = (changes={}) => ({id:'SHP-manual',direction:'Receipt',companyId:'supplier',deliveryParty:'Example destination',date:'2026-10-31',vehicle:'EX-001',product:'Generic goods',weight:'0.700',unit:'tonnes',rate:'40000.00',amount:'28000.00',status:'Delivered',...changes});
const payment = (changes={}) => ({id:'PAY-manual',direction:'Received',date:'2026-10-31',companyId:'customer',actor:'Example remitter',amount:'10000.00',account:'Unassigned',bankLabel:'UBL',reference:'any text',treatment:'Customer receipt',status:'Needs review',balanceApplied:true,...changes});
test('manual records require valid effective dates, quantities, rates and accounting roles',()=>{
  const d=workspace(); d.shipments=[shipment()]; assert.deepEqual(validateWorkspaceRecords(d),[]);
  d.shipments=[shipment({date:'2026-02-31',weight:'-1.000',rate:'abc',direction:'Dispatch'})];
  const errors=validateWorkspaceRecords(d);
  assert.ok(errors.some(e=>e.includes('effective date'))); assert.ok(errors.some(e=>e.includes('nonnegative decimal')));
  assert.ok(errors.some(e=>e.includes('valid rate'))); assert.ok(errors.some(e=>e.includes('accounting role')));
  d.shipments=[shipment({amount:'28000.01'})]; assert.ok(validateWorkspaceRecords(d).some(e=>e.includes('quantity × rate')));
});
test('manual balance changes must equal the reviewed signed effects of records',()=>{
  const before=workspace(), after=structuredClone(before); after.shipments=[shipment()]; after.companies[0].balance='-28000.00';
  assert.deepEqual(validateWorkspaceRecords(after,before),[]);
  after.companies[0].balance='9000000.00'; assert.ok(validateWorkspaceRecords(after,before).some(e=>e.includes('balance change')));
  const opening=structuredClone(before); opening.companies.push({id:'new',name:'New company',role:'Customer',aliases:[],balance:'1234.56',status:'Active'});
  assert.deepEqual(validateWorkspaceRecords(opening,before),[]);
});
test('unknown own accounts never move cash and resolving an imported account never settles twice',()=>{
  assert.equal(affectsCash(payment()),false);
  assert.equal(affectsCash(payment({status:'Allocated',account:''})),false);
  assert.equal(affectsCash(payment({status:'Allocated',account:'Unknown account'})),false);
  assert.equal(affectsCash(payment({status:'Allocated',account:'Non-cash adjustment'})),false);
  assert.equal(affectsCash(payment({status:'Allocated',account:'Business current'})),true);
  assert.equal(affectsCash(payment({status:'Allocated',account:'Business current',treatment:'Supplier-agreed deduction'})),false);
  const before=workspace(); before.payments=[payment()]; before.companies[1].balance='-10000.00';
  const after=structuredClone(before); after.payments[0].status='Allocated'; after.payments[0].account='Business current';
  assert.deepEqual(validateWorkspaceRecords(after,before),[]);
  after.companies[1].balance='-20000.00'; assert.ok(validateWorkspaceRecords(after,before).some(e=>e.includes('balance change')));
});
test('a truly unresolved payment can remain unallocated without creating a company or settlement',()=>{
  const d=workspace(); d.payments=[payment({companyId:'',balanceApplied:false})];
  assert.deepEqual(validateWorkspaceRecords(d),[]);
  d.payments[0].status='Allocated'; assert.ok(validateWorkspaceRecords(d).some(e=>e.includes('select a company')));
});
test('confirmed matches require reciprocal references, opposite directions and reviewed quantities',()=>{
  const d=workspace(); d.shipments=[shipment({id:'purchase',matchedId:'sale',matchConfirmed:true}),shipment({id:'sale',direction:'Dispatch',companyId:'customer',matchedId:'purchase',matchConfirmed:false})];
  assert.ok(validateWorkspaceRecords(d).some(e=>e.includes('reciprocal')));
  d.shipments[1].matchConfirmed=true; assert.deepEqual(validateWorkspaceRecords(d),[]);
  d.shipments[1].weight='0.800'; d.shipments[1].amount='32000.00'; assert.ok(validateWorkspaceRecords(d).some(e=>e.includes('quantities differ')));
});
test('posted import effects also satisfy the general manual balance invariant',()=>{
  const before=workspace(), after=postImport(batch(),before,'Reviewer');
  assert.deepEqual(validateWorkspaceRecords(after,before),[]);
  after.shipments=[]; assert.ok(validateWorkspaceRecords(after,before).some(e=>e.includes('source link')));
});
const allocationsWorkspace = () => {
  const d=workspace();
  d.shipments=[shipment({id:'source-a',weight:'5.000',rate:'100.00',amount:'500.00'}),shipment({id:'source-b',weight:'7.000',rate:'120.00',amount:'840.00'}),shipment({id:'sale-a',direction:'Dispatch',companyId:'customer',weight:'10.000',rate:'200.00',amount:'2000.00',costAllocations:[{shipmentId:'source-a',weight:'5.000',amount:'500.00'},{shipmentId:'source-b',weight:'5.000',amount:'600.00'}],costAllocationConfirmed:true,costAllocationEvidence:'Receipt quantities and accounting directions reviewed against delivery evidence.'})];
  return d;
};
test('a sale can consume multiple reviewed purchase sources without inventing cost',()=>{
  const d=allocationsWorkspace();
  assert.deepEqual(validateWorkspaceRecords(d),[]);
  assert.deepEqual(confirmedMargin(d),{amount:'900.00',unresolved:0});
  d.shipments.push(shipment({id:'sale-b',direction:'Dispatch',companyId:'customer',weight:'2.000',rate:'200.00',amount:'400.00',costAllocations:[{shipmentId:'source-b',weight:'2.000',amount:'240.00'}],costAllocationConfirmed:true,costAllocationEvidence:'Remaining purchase quantity explicitly allocated.'}));
  assert.deepEqual(validateWorkspaceRecords(d),[]);
  assert.deepEqual(confirmedMargin(d),{amount:'1060.00',unresolved:0});
});
test('partial cost coverage stays unresolved until the complete sale quantity is reviewed',()=>{
  const d=allocationsWorkspace(),sale=d.shipments[2];
  sale.costAllocations.pop(); sale.costAllocationConfirmed=false;
  assert.deepEqual(validateWorkspaceRecords(d),[]);
  assert.deepEqual(confirmedMargin(d),{amount:'0.00',unresolved:1});
  sale.costAllocationConfirmed=true;
  assert.ok(validateWorkspaceRecords(d).some(e=>e.includes('complete dispatch quantity')));
  assert.deepEqual(confirmedMargin(d),{amount:'0.00',unresolved:1});
});
test('purchase quantities cannot be overallocated across separate sales or confirmed simple matches',()=>{
  const d=allocationsWorkspace();
  d.shipments.push(shipment({id:'sale-b',direction:'Dispatch',companyId:'customer',weight:'3.000',rate:'200.00',amount:'600.00',costAllocations:[{shipmentId:'source-b',weight:'3.000',amount:'360.00'}],costAllocationConfirmed:true,costAllocationEvidence:'Review'}));
  assert.ok(validateWorkspaceRecords(d).some(e=>e.includes('insufficient unallocated quantity')));
  assert.deepEqual(confirmedMargin(d),{amount:'0.00',unresolved:2});
  d.shipments[3]={...shipment({id:'sale-b',direction:'Dispatch',companyId:'customer',weight:'7.000',rate:'200.00',amount:'1400.00',matchedId:'source-b',matchConfirmed:true})};
  d.shipments[1].matchedId='sale-b'; d.shipments[1].matchConfirmed=true;
  assert.ok(validateWorkspaceRecords(d).some(e=>e.includes('insufficient unallocated quantity')));
});
test('allocated costs must use actual source rates, approved units/products, and evidence',()=>{
  const d=allocationsWorkspace();
  d.shipments[2].costAllocations[0].amount='1.00'; d.shipments[2].costAllocationEvidence=''; d.shipments[0].unit='kg'; d.shipments[0].product='Other goods';
  const errors=validateWorkspaceRecords(d);
  assert.ok(errors.some(e=>e.includes('reviewed source rate'))); assert.ok(errors.some(e=>e.includes('approved unit')));
  assert.ok(errors.some(e=>e.includes('same product'))); assert.ok(errors.some(e=>e.includes('retain evidence')));
  assert.deepEqual(confirmedMargin(d),{amount:'0.00',unresolved:1});
});

test('history at or before a reviewed opening cutoff cannot be imported again',()=>{
  const opening=batch();opening.mapping.mode='Opening balance';opening.mapping.cutoff='2026-10-20';
  const posted=postImport(opening,workspace(),'Reviewer');
  const next=batch({id:'AFTER-OPEN',hash:'new-source-hash',rows:[sourceRow({id:'new-row',description:'Different description, same historical period'})]});
  assert.ok(validateImport(next,posted).some(e=>e.includes('opening-balance cutoff')));
  next.rows[0].effectiveDate='2026-10-21';
  assert.ok(!validateImport(next,posted).some(e=>e.includes('opening-balance cutoff')));
});
test('currency cannot silently relabel existing financial amounts',()=>{
  const previous=workspace();previous.companies[0].balance='100.00';
  const incoming=structuredClone(previous);incoming.currency='USD';
  assert.ok(validateWorkspaceRecords(incoming,previous).some(e=>e.includes('Currency cannot change')));
  const empty=workspace(),newDefault=structuredClone(empty);newDefault.currency='USD';
  assert.deepEqual(validateWorkspaceRecords(newDefault,empty),[]);
});
