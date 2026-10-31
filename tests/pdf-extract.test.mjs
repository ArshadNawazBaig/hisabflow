import test from 'node:test';
import assert from 'node:assert/strict';
import { extractLedgerText, suggestedDate, SAMPLE_LEDGER } from '../lib/pdf-extract.ts';
import { reconcile } from '../lib/accounting.ts';

test('sanitized transcription extracts source transactions and excludes headers/closing totals',()=>{
  const extraction=extractLedgerText(SAMPLE_LEDGER);
  const check=reconcile(extraction.rows);
  assert.equal(check.goodsCount,3); assert.equal(check.paymentCount,2);
  assert.equal(check.goods,'519000.00'); assert.equal(check.paid,'300000.00'); assert.equal(check.closing,'219000.00');
  assert.equal(check.balanced,true);
  assert.equal(extraction.rows.filter(r=>r.kind==='excluded').length,2);
});
test('raw malformed dates remain unresolved and out-of-order rows remain in printed order',()=>{
  assert.equal(suggestedDate('22/07/026'),''); assert.equal(suggestedDate('15/0826'),''); assert.equal(suggestedDate('31-02-2026'),'');
  const extraction=extractLedgerText(SAMPLE_LEDGER), anomaly=extraction.rows.find(r=>r.rawDate==='14/10/026');
  assert.ok(anomaly); assert.equal(anomaly.proposedDate,''); assert.equal(anomaly.effectiveDate,''); assert.equal(anomaly.status,'Needs review');
  const out=extractLedgerText('DATE | DESCRIPTIONS | PARTY | VEH. # | WEIGHT | RATE | TOTAL | PAID | PAYABLE | TID #\n04-09-2026 | First printed | Example destination | X-1 | 1.000 | 10 | 10 | | 10 |\n03-09-2026 | Later printed | Example destination | X-1 | 1.000 | 10 | 10 | | 20 |');
  assert.deepEqual(out.rows.filter(r=>r.kind!=='excluded').map(r=>r.rawDate),['04-09-2026','03-09-2026']);
  assert.ok(out.rows.at(-1).issues.some(i=>i.includes('out of chronological order')));
});
test('rejected goods and small same-vehicle follow-up quantities stay separate positive rows',()=>{
  const extraction=extractLedgerText(SAMPLE_LEDGER), rejected=extraction.rows.find(r=>r.reference==='Rejected');
  assert.equal(rejected.goods,'6000.00'); assert.equal(rejected.kind,'goods'); assert.ok(rejected.issues.some(i=>i.includes('Rejected')));
  const rows=extractLedgerText('DATE | DESCRIPTIONS | PARTY | VEH. # | WEIGHT | RATE | TOTAL | PAID | PAYABLE | TID #\n01-10-2026 | First quantity | Example mill | X-7834 | 31.635 | 100 | 3163.50 | | 3163.50 |\n02-10-2026 | Follow-up quantity | Example mill | X-7834 | 0.495 | 100 | 49.50 | | 3213.00 |').rows.filter(r=>r.kind!=='excluded');
  assert.equal(rows.length,2); assert.notEqual(rows[0].id,rows[1].id); assert.deepEqual(rows.map(r=>r.weight),['31.635','0.495']);
});
test('duplicate amounts and repeated nonnumeric transaction references are preserved',()=>{
  const rows=extractLedgerText('DATE | DESCRIPTIONS | PARTY | VEH. # | WEIGHT | RATE | TOTAL | PAID | PAYABLE | TID #\n01-10-2026 | Payment one | | | | | | 100 | -100 | note\n02-10-2026 | Payment two | | | | | | 100 | -200 | note').rows.filter(r=>r.kind!=='excluded');
  assert.equal(rows.length,2); assert.equal(rows[0].reference,'note'); assert.equal(rows[1].reference,'note'); assert.equal(reconcile(rows).paid,'200.00');
});
test('numeric-only repeated closing balances are excluded while undated freight payments stay active',()=>{
  const rows=extractLedgerText('DATE | DESCRIPTIONS | PARTY | VEH. # | WEIGHT | RATE | TOTAL | PAID | PAYABLE | TID #\n01-10-2026 | Goods | Example mill | X-1 | 1.000 | 100 | 100 | | 100 |\n | Freight paid to example transporter | | | | | | 25 | 75 | freight-note\n | | | | | | | | 75 |').rows;
  const balanceOnly=rows.at(-1),freight=rows.find(r=>r.reference==='freight-note');
  assert.equal(balanceOnly.kind,'excluded');assert.equal(balanceOnly.status,'Excluded');assert.equal(balanceOnly.balance,'75');assert.ok(balanceOnly.raw.includes('75'));
  assert.equal(freight.kind,'payment');assert.equal(freight.paid,'25');assert.equal(freight.rawDate,'');assert.equal(freight.effectiveDate,'');assert.ok(freight.issues.some(issue=>issue.includes('Missing source date')));
  const check=reconcile(rows);assert.equal(check.paymentCount,1);assert.equal(check.goodsCount,1);assert.equal(check.closing,'75.00');
});
