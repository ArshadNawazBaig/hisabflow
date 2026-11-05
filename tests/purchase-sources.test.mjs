import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalDeliveryUnit, normalizeDeliveryLabel } from '../lib/delivery-units.ts';
import { isAllocationQuantity, purchaseSourceAvailable, reviewPurchaseSources } from '../lib/purchase-sources.ts';
import { confirmedMargin, validateWorkspaceRecords } from '../lib/accounting.ts';

const receipt = (changes = {}) => ({ id:'purchase',direction:'Receipt',companyId:'supplier',deliveryParty:'Synthetic warehouse',date:'2026-10-31',vehicle:'SYN-001',product:'Steam coal',grade:'Grade A',weight:'4.000',unit:'t',rate:'100.00',amount:'400.00',status:'Delivered',...changes });
const sale = (changes = {}) => receipt({ id:'sale',direction:'Dispatch',companyId:'customer',rate:'200.00',amount:'800.00',...changes });
const workspace = (shipments = []) => ({ business:'Synthetic business',currency:'PKR',openingCash:'0.00',companies:[{ id:'supplier',name:'Synthetic supplier',role:'Supplier',aliases:[],balance:'0.00',status:'Active' },{ id:'customer',name:'Synthetic customer',role:'Customer',aliases:[],balance:'0.00',status:'Active' }],shipments,payments:[],imports:[],audit:[] });
const confirmedSale = (changes = {}) => sale({ costAllocations:[{ shipmentId:'purchase',weight:'4.000',amount:'400.00' }],costAllocationConfirmed:true,costAllocationEvidence:'Synthetic source quantity, rate and relationship reviewed.',...changes });

test('approved unit aliases are equivalent without changing scales or guessing an unspecified ton', () => {
  for (const unit of ['t','tonne','tonnes','Metric tonnes','metric tonne','metric ton','metric tons','  METRIC  TONNES  ']) assert.equal(canonicalDeliveryUnit(unit), 't');
  for (const unit of ['kg','Kilogram','kilograms']) assert.equal(canonicalDeliveryUnit(unit), 'kg');
  for (const unit of ['Unit','units']) assert.equal(canonicalDeliveryUnit(unit), 'units');
  assert.notEqual(canonicalDeliveryUnit('kg'), canonicalDeliveryUnit('t'));
  assert.notEqual(canonicalDeliveryUnit('ton'), canonicalDeliveryUnit('t'));
  assert.notEqual(canonicalDeliveryUnit('tons'), canonicalDeliveryUnit('t'));
  assert.notEqual(canonicalDeliveryUnit('MT'), canonicalDeliveryUnit('t'));
  assert.equal(canonicalDeliveryUnit('  Large   bags '), 'large bags');
  assert.equal(normalizeDeliveryLabel('  Steam\t Coal\n A  '), 'steam coal a');
});

test('allocation quantity validation matches financial decimal limits', () => {
  for (const value of ['0','0.000000','4','4.123456','999999999999.999999']) assert.equal(isAllocationQuantity(value), true, value);
  for (const value of ['','-1','1e3','1,000',' 1','1.','1.0000001','1000000000000']) assert.equal(isAllocationQuantity(value), false, value);
});

test('sale without purchase receipts has an explicit empty review and no fabricated sources', () => {
  const order = sale(), data = workspace([order]), original = structuredClone(data);
  assert.deepEqual(reviewPurchaseSources(data, order), { available:[],excluded:[],receiptsCount:0 });
  assert.deepEqual(data, original);
  assert.deepEqual(confirmedMargin(data), { amount:'0.00',unresolved:1 });
});

test('imported and manual approved unit labels can supply the same named product', () => {
  const purchase = receipt({ unit:'Metric tonnes',product:'  STEAM   coal ',grade:' GRADE  A ' });
  const order = confirmedSale(), data = workspace([purchase,order]);
  const review = reviewPurchaseSources(data, order);
  assert.deepEqual(review.available, [{ shipment:purchase,available:'4.000000' }]);
  assert.deepEqual(review.excluded, []);
  assert.deepEqual(validateWorkspaceRecords(data), []);
  assert.deepEqual(confirmedMargin(data), { amount:'400.00',unresolved:0 });
});

test('kilogram aliases work for both allocations and reciprocal source matches', () => {
  const purchase = receipt({ unit:'Kilograms' }), order = confirmedSale({ unit:'kg' });
  const data = workspace([purchase,order]);
  assert.equal(reviewPurchaseSources(data, order).available.length, 1);
  assert.deepEqual(validateWorkspaceRecords(data), []);
  purchase.matchConfirmed = true; purchase.matchedId = order.id;
  order.matchConfirmed = true; order.matchedId = purchase.id;
  delete order.costAllocations; delete order.costAllocationConfirmed;
  assert.deepEqual(validateWorkspaceRecords(data), []);
  assert.deepEqual(confirmedMargin(data), { amount:'400.00',unresolved:0 });
});

test('unit conversion and ambiguous tons remain rejected on client review and server validation', () => {
  for (const unit of ['kg','ton','tons']) {
    const purchase = receipt({ unit }), order = confirmedSale(), data = workspace([purchase,order]);
    assert.deepEqual(reviewPurchaseSources(data, order).excluded[0].reasons, ['Different unit']);
    assert.ok(validateWorkspaceRecords(data).some(error => error.includes('same approved unit')));
    assert.deepEqual(confirmedMargin(data), { amount:'0.00',unresolved:1 });
  }
});

test('all mismatched evidence is reported and a generic imported product never becomes a named product', () => {
  const purchase = receipt({ product:'Imported goods',unit:'kg',grade:'Grade B' }), order = confirmedSale();
  const data = workspace([purchase,order]);
  assert.deepEqual(reviewPurchaseSources(data, order), { available:[],excluded:[{ shipment:purchase,reasons:['Different product','Different unit','Different grade'] }],receiptsCount:1 });
  assert.ok(validateWorkspaceRecords(data).some(error => error.includes('same product')));
});

test('whitespace-only grades remain unrecorded on either side in source review and server confirmation', () => {
  for (const [sourceGrade,saleGrade] of [[' \t\n ','Grade A'],['Grade A',' \t\n '],[' \t ','   ']]) {
    const purchase = receipt({ grade:sourceGrade }), order = confirmedSale({ grade:saleGrade });
    const data = workspace([purchase,order]);
    assert.deepEqual(reviewPurchaseSources(data, order).available, [{ shipment:purchase,available:'4.000000' }]);
    assert.deepEqual(reviewPurchaseSources(data, order).excluded, []);
    assert.deepEqual(validateWorkspaceRecords(data), []);
    assert.deepEqual(confirmedMargin(data), { amount:'400.00',unresolved:0 });
  }
});

test('blank product and unit cannot become compatible just because both records are blank', () => {
  const purchase = receipt({ product:' ',unit:' ' }), order = sale({ product:'',unit:'' });
  assert.deepEqual(reviewPurchaseSources(workspace([purchase,order]), order).excluded[0].reasons, ['Different product','Different unit']);
});

test('unknown quantity or rate stays unresolved even when a positive manual purchase total exists', () => {
  const purchase = receipt({ weight:'',rate:'',amount:'400.00' }), order = sale(), data = workspace([purchase,order]);
  assert.deepEqual(validateWorkspaceRecords(data), []);
  assert.deepEqual(reviewPurchaseSources(data, order).excluded[0].reasons, ['Missing or invalid purchase quantity','Missing or invalid purchase rate']);
  assert.deepEqual(confirmedMargin(data), { amount:'0.00',unresolved:1 });
  assert.equal(purchase.weight, ''); assert.equal(purchase.rate, '');
  purchase.weight = '4.000'; purchase.rate = '';
  assert.deepEqual(reviewPurchaseSources(data, order).excluded[0].reasons, ['Missing or invalid purchase rate']);
  assert.ok(validateWorkspaceRecords(data).some(error => error.includes('valid rate')));
});

test('zero or invalid quantities and rates cannot be offered as a purchase source', () => {
  const order = sale();
  for (const weight of ['0.000','-4','4.1234567','1000000000000']) {
    assert.ok(reviewPurchaseSources(workspace([receipt({ weight }),order]), order).excluded[0].reasons.includes('Missing or invalid purchase quantity'));
  }
  for (const rate of ['','0.00','-100.00','1.234']) {
    assert.ok(reviewPurchaseSources(workspace([receipt({ rate }),order]), order).excluded[0].reasons.includes('Missing or invalid purchase rate'));
  }
});

test('draft quantities reserve other stock while an edited sale can reuse its own allocation', () => {
  const purchase = receipt(), order = sale({ costAllocations:[{ shipmentId:'purchase',weight:'1.000',amount:'100.00' }] });
  const other = sale({ id:'other',weight:'2.500',amount:'500.00',costAllocations:[{ shipmentId:'purchase',weight:'2.500',amount:'250.00' }],costAllocationConfirmed:false });
  const data = workspace([purchase,order,other]);
  assert.equal(purchaseSourceAvailable(data, purchase, order.id), '1.500000');
  assert.deepEqual(reviewPurchaseSources(data, order).available, [{ shipment:purchase,available:'1.500000' }]);
  assert.deepEqual(validateWorkspaceRecords(data), []);
});

test('fully consumed and over-reserved sources are excluded and remain protected on the server', () => {
  const purchase = receipt(), order = sale(), other = confirmedSale({ id:'other' });
  const data = workspace([purchase,order,other]);
  assert.equal(purchaseSourceAvailable(data, purchase, order.id), '0.000000');
  assert.deepEqual(reviewPurchaseSources(data, order).excluded[0].reasons, ['Quantity already allocated']);
  order.costAllocations = [{ shipmentId:'purchase',weight:'0.000001',amount:'0.00' }];
  assert.ok(validateWorkspaceRecords(data).some(error => error.includes('insufficient unallocated quantity')));
  other.costAllocations[0].weight = '5.000';
  assert.equal(purchaseSourceAvailable(data, purchase, order.id), '-1.000000');
  assert.deepEqual(reviewPurchaseSources(data, order).excluded[0].reasons, ['Quantity already allocated']);
});

test('reciprocal matches reserve stock alongside other draft allocations', () => {
  const purchase = receipt({ matchedId:'other',matchConfirmed:true });
  const order = sale(), other = sale({ id:'other',matchedId:'purchase',matchConfirmed:true });
  const data = workspace([purchase,order,other]);
  assert.equal(purchaseSourceAvailable(data, purchase, order.id), '0.000000');
  assert.deepEqual(reviewPurchaseSources(data, order).excluded[0].reasons, ['Quantity already allocated']);
  purchase.matchConfirmed = false;
  assert.equal(purchaseSourceAvailable(data, purchase, order.id), '4.000000');
});

test('availability preserves six decimals beyond floating point precision and fails closed for unresolved reservations', () => {
  const purchase = receipt({ weight:'999999999999.999999' }), order = sale();
  const other = sale({ id:'other',costAllocations:[{ shipmentId:'purchase',weight:'0.000001',amount:'0.00' }] });
  const data = workspace([purchase,order,other]);
  assert.equal(purchaseSourceAvailable(data, purchase, order.id), '999999999999.999998');
  other.costAllocations[0].weight = 'unresolved';
  assert.equal(purchaseSourceAvailable(data, purchase, order.id), '0.000000');
  assert.equal(reviewPurchaseSources(data, order).available.length, 0);
});
