import test from 'node:test';
import assert from 'node:assert/strict';
import { affectsCash, validateWorkspaceRecords } from '../lib/accounting.ts';
import { today } from '../lib/types.ts';
import { applyCompanyAdvance, availableCompanyAdvances, companyAccountBalance, companyAccountSummary, companyBalanceLabel, economicCompanyBalance, economicCompanyBalances, shipmentAdvanceSummary, shipmentSettlementLabel, validateAdvanceApplications } from '../lib/company-account.ts';
import { workspaceSchema } from '../lib/workspace-validation.ts';

const company = (changes={}) => ({id:'customer',name:'Example customer',role:'Customer',aliases:[],balance:'0.00',status:'Active',...changes});
const advance = (changes={}) => ({id:'PAY-advance',direction:'Received',date:'2000-01-01',companyId:'customer',actor:'Example payer',amount:'100.00',account:'Business current',bankLabel:'',reference:'ADV-001',treatment:'Advance',status:'Allocated',balanceApplied:false,...changes});
const sale = (changes={}) => ({id:'SHP-order',direction:'Dispatch',companyId:'customer',deliveryParty:'Example destination',date:'2000-01-02',vehicle:'',product:'Example product',weight:'',unit:'t',rate:'',amount:'60.00',status:'Pending',settlement:'Unsettled',...changes});
const workspace = (changes={}) => ({business:'Example trading',currency:'PKR',openingCash:'0.00',companies:[company()],payments:[],shipments:[],imports:[],audit:[],...changes});
const orderWithCredit = () => workspace({companies:[company({balance:'60.00'})],payments:[advance()],shipments:[sale()]});
const entry = (changes={}) => ({id:'ADV-application',companyId:'customer',paymentId:'PAY-advance',shipmentId:'SHP-order',amount:'60.00',date:today(),...changes});

test('customer account is positive for an approved advance and negative for an unpaid order',()=>{
  const deposit=workspace({payments:[advance()]});
  assert.equal(companyAccountBalance(deposit,'customer'),'100.00');
  assert.equal(companyBalanceLabel(deposit,'customer'),'Advance / credit');
  const unpaid=workspace({companies:[company({balance:'60.00'})],shipments:[sale()]});
  assert.equal(companyAccountBalance(unpaid,'customer'),'-60.00');
  assert.equal(companyBalanceLabel(unpaid,'customer'),'Due from company');
  const credit=orderWithCredit();
  assert.equal(economicCompanyBalance(credit,'customer'),'-40.00');
  assert.equal(companyAccountSummary(credit,'customer').balance,'40.00');
});

test('applying 60 of a 100 advance links existing money without changing cash or balances',()=>{
  const before=orderWithCredit(),snapshot=structuredClone(before),after=applyCompanyAdvance(before,'SHP-order','60.00');
  assert.deepEqual(before,snapshot);
  assert.deepEqual(after.payments,before.payments);assert.deepEqual(after.companies,before.companies);assert.deepEqual(after.shipments,before.shipments);
  assert.equal(after.payments.filter(affectsCash).length,1);
  assert.equal(after.advanceApplications.length,1);assert.equal(after.advanceApplications[0].paymentId,'PAY-advance');
  assert.deepEqual(shipmentAdvanceSummary(after,'SHP-order'),{applied:'60.00',outstanding:'0.00'});
  assert.equal(companyAccountSummary(after,'customer').availableAdvance,'40.00');
  assert.equal(companyAccountBalance(after,'customer'),'40.00');
  assert.deepEqual(validateWorkspaceRecords(after,before),[]);
});

test('a second 50 order can use only the remaining 40 and leaves a negative 10 account',()=>{
  const first=applyCompanyAdvance(orderWithCredit(),'SHP-order','60');
  const second={...first,companies:[company({balance:'110.00'})],shipments:[...first.shipments,sale({id:'SHP-second',amount:'50.00'})]};
  const result=applyCompanyAdvance(second,'SHP-second','40.00');
  assert.equal(companyAccountBalance(result,'customer'),'-10.00');
  assert.equal(companyAccountSummary(result,'customer').availableAdvance,'0.00');
  assert.deepEqual(shipmentAdvanceSummary(result,'SHP-second'),{applied:'40.00',outstanding:'10.00'});
  assert.throws(()=>applyCompanyAdvance(result,'SHP-second','0.01'),/enough available advance/);
});

test('multiple sources are applied FIFO and partial top-ups may use the same source/order pair',()=>{
  const data=workspace({companies:[company({balance:'200.00'})],payments:[advance({id:'later',date:'2000-02-01'}),advance({id:'earlier'})],shipments:[sale({amount:'200.00'})]});
  const first=applyCompanyAdvance(data,'SHP-order','130.00');
  assert.deepEqual(first.advanceApplications.map(item=>[item.paymentId,item.amount]),[['earlier','100.00'],['later','30.00']]);
  const second=applyCompanyAdvance(first,'SHP-order','20.00');
  assert.equal(second.advanceApplications[2].paymentId,'later');assert.equal(second.advanceApplications[2].amount,'20.00');
  assert.equal(new Set(second.advanceApplications.map(item=>item.id)).size,3);
  assert.deepEqual(validateAdvanceApplications(second),[]);
});

test('pending, unknown-account, noncash, future, and already-booked advances are not spendable',()=>{
  for(const changes of [{status:'Needs review'},{account:'Unassigned'},{account:'Unknown account'},{account:'Non-cash adjustment'},{balanceApplied:true},{date:'2999-01-01'}]){
    const data=workspace({payments:[advance(changes)],shipments:[sale()]});
    assert.equal(availableCompanyAdvances(data,'customer').length,0);
    assert.equal(companyAccountSummary(data,'customer').availableAdvance,'0.00');
    assert.throws(()=>applyCompanyAdvance(data,'SHP-order','1'),/enough available advance/);
  }
});

test('imported advances become available when own account and approval are resolved without rebasing history',()=>{
  const unresolved=workspace({payments:[advance({status:'Needs review',account:'Unassigned — review own account',sourceRef:'IMP-source'})]});
  assert.equal(companyAccountBalance(unresolved,'customer'),'0.00');
  const resolved=structuredClone(unresolved);resolved.payments[0].status='Allocated';resolved.payments[0].account='Business current';
  assert.equal(companyAccountBalance(resolved,'customer'),'100.00');
  assert.deepEqual(resolved.companies,unresolved.companies);
  assert.deepEqual(validateWorkspaceRecords(resolved,unresolved),[]);
});

test('ordinary receipts retain their existing balance effect and are not counted again as advances',()=>{
  const data=workspace({companies:[company({balance:'35.00'})],shipments:[sale()],payments:[advance({amount:'25.00',treatment:'Customer receipt',balanceApplied:true})]});
  const summary=companyAccountSummary(data,'customer');
  assert.equal(summary.balance,'-35.00');assert.equal(summary.totalAdvance,'0.00');
  assert.equal(summary.ordersNotCoveredByAdvance,'60.00','Order advance coverage does not invent a per-order receipt allocation.');
});

test('supplier and Both balances preserve historical signs internally and use role-aware display labels',()=>{
  const data=workspace({companies:[company({role:'Supplier',balance:'-70.00'})]});
  assert.equal(companyAccountBalance(data,'customer'),'70.00');assert.equal(companyBalanceLabel(data,'customer'),'To pay');
  data.companies[0].balance='0.00';data.payments=[advance({direction:'Paid'})];
  assert.equal(economicCompanyBalance(data,'customer'),'100.00');assert.equal(companyAccountBalance(data,'customer'),'-100.00');assert.equal(companyBalanceLabel(data,'customer'),'Supplier advance / credit');
  assert.equal(availableCompanyAdvances(data,'customer').length,0);
  data.companies[0].role='Both';data.payments=[advance()];assert.equal(companyAccountSummary(data,'customer').availableAdvance,'100.00');
});

test('bulk company balances match individual calculations across roles without changing stored records',()=>{
  const data=workspace({companies:[company({balance:'60.00'}),company({id:'supplier',role:'Supplier',balance:'-50.00'}),company({id:'both',role:'Both',balance:'20.00'})],payments:[advance(),advance({id:'supplier-deposit',companyId:'supplier',direction:'Paid',amount:'20.00'}),advance({id:'both-received',companyId:'both',amount:'10.00'}),advance({id:'both-paid',companyId:'both',direction:'Paid',amount:'5.00'}),advance({id:'unresolved',account:'Unassigned',amount:'500.00'}),advance({id:'normal-receipt',treatment:'Customer receipt',balanceApplied:true,amount:'25.00'})]});
  const original=structuredClone(data),balances=economicCompanyBalances(data);
  assert.deepEqual(balances,new Map([['customer','-40.00'],['supplier','-30.00'],['both','15.00']]));
  for(const company of data.companies)assert.equal(balances.get(company.id),economicCompanyBalance(data,company.id));
  assert.deepEqual(data,original);
});

test('refunds consume unapplied credits FIFO and cannot withdraw money already reserved for orders',()=>{
  const before=workspace({companies:[company({balance:'100.00'})],payments:[advance({id:'first'}),advance({id:'second',date:'2000-02-01'})],shipments:[sale({amount:'100.00'})]});
  const used=applyCompanyAdvance(before,'SHP-order','100.00');
  used.payments.push(advance({id:'refund',direction:'Paid',amount:'100.00'}));
  assert.equal(companyAccountSummary(used,'customer').availableAdvance,'0.00');
  assert.deepEqual(validateAdvanceApplications(used),[]);
  used.payments.at(-1).amount='100.01';assert.ok(validateAdvanceApplications(used).some(error=>error.includes('after refunds')));
});

test('applications cannot overuse a source across different orders or exceed order coverage',()=>{
  const data=orderWithCredit();data.shipments.push(sale({id:'second',amount:'100.00'}));
  data.advanceApplications=[entry(),entry({id:'other',shipmentId:'second',amount:'41.00'})];
  assert.ok(validateAdvanceApplications(data).some(error=>error.includes('exceed the received payment')));
  data.advanceApplications=[entry({amount:'60.01'})];assert.ok(validateAdvanceApplications(data).some(error=>error.includes('exceed the product order')));
  assert.throws(()=>applyCompanyAdvance(orderWithCredit(),'SHP-order','60.01'),/exceeds the part/);
});

test('cross-company, non-advance, missing, and wrong-direction sources are rejected server-side',()=>{
  for(const changes of [{companyId:'other'},{treatment:'Customer receipt'},{direction:'Paid'},{status:'Needs review'},{account:'Non-cash adjustment'}]){
    const data=orderWithCredit();data.companies.push(company({id:'other'}));Object.assign(data.payments[0],changes);data.advanceApplications=[entry()];
    assert.ok(validateWorkspaceRecords(data).some(error=>error.includes('approved received advance')));
  }
  const missing=orderWithCredit();missing.payments=[];missing.advanceApplications=[entry()];assert.ok(validateAdvanceApplications(missing).length);
  const receipt=orderWithCredit();receipt.shipments[0].direction='Receipt';receipt.advanceApplications=[entry()];assert.ok(validateAdvanceApplications(receipt).some(error=>error.includes('product order')));
});

test('used advances cannot be reduced, removed, reassigned, or unapproved later',()=>{
  const original=applyCompanyAdvance(orderWithCredit(),'SHP-order','60.00');
  for(const changes of [{amount:'59.99'},{status:'Needs review'},{companyId:'other'},{account:'Unassigned'}]){
    const next=structuredClone(original);next.companies.push(company({id:'other'}));Object.assign(next.payments[0],changes);
    assert.ok(validateWorkspaceRecords(next,original).length);
  }
  const removed=structuredClone(original);removed.payments=[];assert.ok(validateWorkspaceRecords(removed,original).length);
});

test('application IDs are unique while legitimate repeated source/order pairs remain valid',()=>{
  const data=orderWithCredit();data.advanceApplications=[entry({amount:'20.00'}),entry({amount:'20.00'})];
  assert.ok(validateAdvanceApplications(data).some(error=>error.includes('unique')));
  data.advanceApplications[1].id='ADV-second';assert.deepEqual(validateAdvanceApplications(data),[]);
  data.advanceApplications[1].id='SHP-order';assert.ok(validateAdvanceApplications(data).some(error=>error.includes('unique')));
});

test('existing applications cannot be erased or rewritten to free a previously used payment',()=>{
  const before=applyCompanyAdvance(orderWithCredit(),'SHP-order','60.00');
  const removed=structuredClone(before);removed.advanceApplications=[];removed.payments[0].amount='1.00';
  assert.ok(validateWorkspaceRecords(removed,before).some(error=>error.includes('cannot be changed or removed')));
  for(const changes of [{amount:'1.00'},{date:'2000-01-01'},{paymentId:'another'}]){
    const changed=structuredClone(before);Object.assign(changed.advanceApplications[0],changes);
    assert.ok(validateWorkspaceRecords(changed,before).some(error=>error.includes('cannot be changed or removed')));
  }
});

test('application dates cannot precede receipt, be invalid, or use future funds',()=>{
  for(const date of ['1999-12-31','2026-02-31','2999-01-01']){
    const data=orderWithCredit();data.advanceApplications=[entry({date})];assert.ok(validateAdvanceApplications(data).length);
  }
  const futureOrder=orderWithCredit();futureOrder.shipments[0].date='2999-01-01';
  assert.doesNotThrow(()=>applyCompanyAdvance(futureOrder,'SHP-order','60.00'), 'An existing advance can reserve a future delivery today.');
});

test('money arithmetic remains exact at large values and at single-cent boundaries',()=>{
  const data=workspace({companies:[company({balance:'999999999999999.99'})],payments:[advance({amount:'999999999999999.99'})],shipments:[sale({amount:'999999999999999.99'})]});
  const after=applyCompanyAdvance(data,'SHP-order','999999999999999.98');
  assert.equal(companyAccountSummary(after,'customer').availableAdvance,'0.01');
  assert.equal(shipmentAdvanceSummary(after,'SHP-order').outstanding,'0.01');assert.equal(companyAccountBalance(after,'customer'),'0.00');
  assert.deepEqual(economicCompanyBalances(after),new Map([['customer','0.00']]));
});

test('workspace schema preserves old snapshots and enforces typed application records',()=>{
  assert.ok(workspaceSchema.safeParse(workspace()).success);
  const applied=applyCompanyAdvance(orderWithCredit(),'SHP-order','20.00');assert.ok(workspaceSchema.safeParse(applied).success);
  for(const changes of [{amount:'-1.00'},{amount:'1.001'},{date:'not-a-date'},{paymentId:''},{unreviewed:'field'}]){
    const invalid=structuredClone(applied);Object.assign(invalid.advanceApplications[0],changes);assert.equal(workspaceSchema.safeParse(invalid).success,false);
  }
});

test('settlement display reflects advance coverage without rewriting the recorded settlement',()=>{
  const data=orderWithCredit();data.shipments[0].settlement='Unsettled';
  assert.equal(shipmentSettlementLabel(data,'SHP-order'),'Unsettled');
  const partial=applyCompanyAdvance(data,'SHP-order','20.00');
  assert.equal(shipmentSettlementLabel(partial,'SHP-order'),'Partially covered by advance');
  const complete=applyCompanyAdvance(partial,'SHP-order','40.00');
  assert.equal(shipmentSettlementLabel(complete,'SHP-order'),'Covered by advance');
  assert.equal(complete.shipments[0].settlement,'Unsettled');
});
