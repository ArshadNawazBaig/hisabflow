import test from 'node:test';
import assert from 'node:assert/strict';
import { extractLedgerText, extractLedgerPages, extractLedgerMetadata, suggestedDate, SAMPLE_LEDGER, readPdfTextItems } from '../lib/pdf-extract.ts';
import { reconcile } from '../lib/accounting.ts';

test('PDF text extraction reads chunk order without browser stream async iteration', async()=>{
  const first={str:'DATE',transform:[1,0,0,1,30,500],width:28};
  const second={str:'01-11-2026',transform:[1,0,0,1,30,470],width:55};
  const stream=new ReadableStream({start(controller){controller.enqueue({items:[first]});controller.enqueue({items:[second]});controller.close();}});
  Object.defineProperty(stream,Symbol.asyncIterator,{value:undefined});
  assert.deepEqual(await readPdfTextItems(stream),[first,second]);
  assert.equal(stream.locked,false);
});

test('PDF text extraction releases the stream when a chunk fails', async()=>{
  const failure=new Error('Source stream failed');
  const stream=new ReadableStream({start(controller){controller.error(failure);}});
  Object.defineProperty(stream,Symbol.asyncIterator,{value:undefined});
  await assert.rejects(readPdfTextItems(stream),failure);
  assert.equal(stream.locked,false);
});

test('sanitized transcription extracts source transactions and excludes headers/closing totals',()=>{
  const extraction=extractLedgerText(SAMPLE_LEDGER);
  const check=reconcile(extraction.rows);
  assert.equal(check.goodsCount,3); assert.equal(check.paymentCount,2);
  assert.equal(check.goods,'519000.00'); assert.equal(check.paid,'300000.00'); assert.equal(check.closing,'219000.00');
  assert.equal(check.balanced,true);
  assert.equal(extraction.rows.filter(r=>r.kind==='excluded').length,2);
});
test('CSV keeps quoted commas, escaped quotes, multiline evidence and string references',()=>{
  const source = '\uFEFFDATE,DESCRIPTIONS,PARTY,VEH. #,WEIGHT,RATE,TOTAL,PAID,PAYABLE,TID #\r\n2026-10-01,"Goods, \"\"reviewed\"\"\nfirst load","Example, Ltd",TEST-1,1.250,"1,000.00","1,250.00",,"1,250.00",0000123\r\n2026-10-02,Payment from Example Ltd,,,,,,250.00,"1,000.00",0000123\r\nClosing payable,,,,,,,,"1,000.00",';
  const extraction=extractLedgerText(source), rows=extraction.rows.filter(row=>row.kind!=='excluded');
  assert.equal(rows.length,2);
  assert.equal(rows[0].description,'Goods, "reviewed"\nfirst load');
  assert.equal(rows[0].party,'Example, Ltd');
  assert.equal(rows[0].goods,'1250.00');assert.equal(rows[0].reference,'0000123');
  assert.equal(rows[0].proposedDate,'2026-10-01');assert.equal(rows[0].effectiveDate,'');
  assert.ok(rows[0].raw.includes('"Goods, ""reviewed""\nfirst load"'));
  assert.equal(rows[1].page,1);assert.equal(rows[1].sequence,3);
  assert.equal(reconcile(extraction.rows).balanced,true);
  assert.equal(reconcile(extraction.rows).closing,'1000.00');
  assert.equal(extraction.metadata.closingBalance.value,'1000.00');
  assert.deepEqual(extraction.metadata.unreadablePages,[]);
});
test('CSV totals are excluded and malformed quoting or column counts remain for review',()=>{
  const header='DATE,DESCRIPTIONS,TOTAL,PAID,BALANCE';
  const extraction=extractLedgerText(header+'\n2026-10-01,Delivery,100.00,,100.00\nTOTAL,,100.00,,100.00');
  assert.equal(extraction.rows.at(-1).kind,'excluded');assert.equal(reconcile(extraction.rows).goods,'100.00');
  const extra=extractLedgerText(header+'\n2026-10-01,Delivery,1,000.00,,1000.00').rows.at(-1);
  assert.ok(extra.issues.some(issue=>issue.includes('column count')));assert.equal(extra.status,'Needs review');
  const malformed=extractLedgerText(header+'\n2026-10-01,"Unclosed delivery,100.00,,100.00').rows.at(-1);
  assert.ok(malformed.issues.some(issue=>issue.includes('Malformed CSV quoting')));assert.equal(malformed.status,'Needs review');
});
test('fully quoted CSV opening and closing labels remain source evidence rather than transactions',()=>{
  const csv = cells => cells.map(value=>`"${value.replaceAll('"','""')}"`).join(',');
  const opening=csv(['Opening balance','','','','','','','','125.50','']);
  const closing=csv(['','Closing balance','','','','','','','200.50','']);
  const source=[csv(['DATE','DESCRIPTIONS','PARTY','VEH. #','WEIGHT','RATE','TOTAL','PAID','PAYABLE','TID #']),opening,
    csv(['2026-10-01','QA goods','Example destination','QA-1','1.000','100.00','100.00','','225.50','0001']),
    csv(['2026-10-02','QA payment','','','','','','25.00','200.50','0002']),closing].join('\n');
  const extraction=extractLedgerText(source),active=extraction.rows.filter(row=>row.kind!=='excluded');
  assert.equal(active.length,2);assert.equal(extraction.rows[1].status,'Excluded');assert.equal(extraction.rows.at(-1).status,'Excluded');
  assert.equal(extraction.metadata.openingBalance.value,'125.50');assert.equal(extraction.metadata.closingBalance.value,'200.50');
  assert.equal(extraction.metadata.openingBalance.raw,opening);assert.equal(extraction.metadata.closingBalance.raw,closing);
  assert.equal(reconcile(extraction.rows,extraction.metadata.openingBalance.value).balanced,true);
  assert.equal(reconcile(extraction.rows,extraction.metadata.openingBalance.value).closing,'200.50');
});
test('ISO source dates are validated without calendar rollover',()=>{
  assert.equal(suggestedDate('2026-10-01'),'2026-10-01');
  assert.equal(suggestedDate('2024-02-29'),'2024-02-29');
  assert.equal(suggestedDate('2026-02-29'),'');assert.equal(suggestedDate('2026-04-31'),'');
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

const layout = [
  ['date',15,17],['description',45,45],['party',200,20],['vehicle',253,20],['weight',299,25],
  ['rate',352,16],['goods',402,20],['paid',458,15],['balance',509,28],['reference',575,16],
];
const printedLabels=['DATE','DESCRIPTIONS','PARTY','VEH. #','WEIGHT','RATE','TOTAL','RECIVED','RECIVEABLE','TID #'];
const printedHeader=(y=700)=>layout.map(([,x,width],index)=>({text:printedLabels[index],x,y,width}));
const printedRow=(values,y)=>layout.flatMap(([key,,width],index)=>values[key]===undefined?[]:[{text:values[key],x:[6,45,196,250,301,351,396,457,512,571][index],y,width:key==='description'?Math.max(45,values[key].length*3):width+10}]);

test('positioned PDF tables retain both column spellings, source order, and terminal dash/closing summaries',()=>{
  const pages=[[
    {text:'LEDGER OF EXAMPLE MINERALS',x:47,y:740,width:200},...printedHeader(),
    ...printedRow({date:'01-10-2026',description:'Material delivery',party:'Example destination',vehicle:'TEST-1',weight:'10.000',rate:'100.00',goods:'1,000.00',balance:'1,000.00'},680),
    ...printedRow({date:'02-10-2026',description:'Transfer from example remitter MBL Acct',goods:'-',paid:'100.00',balance:'900.00',reference:'repeat-note'},660),
    {text:'Page 1 of 2',x:280,y:20,width:50},
  ],[
    ...printedHeader(),
    ...printedRow({date:'03-10-2026',description:'Follow-up quantity',party:'Example destination',vehicle:'TEST-1',weight:'0.500',rate:'100.00',goods:'50.00',balance:'950.00'},680),
    ...printedRow({description:'Freight paid to example transporter',goods:'-',paid:'25.00',balance:'925.00',reference:'repeat-note'},660),
    ...printedRow({goods:'-',balance:'925.00'},640),...printedRow({goods:'-',balance:'925.00'},620),
    {text:'Page 2 of 2',x:280,y:20,width:50},
  ]];
  const extraction=extractLedgerPages(pages),check=reconcile(extraction.rows);
  assert.equal(check.goodsCount,2);assert.equal(check.paymentCount,2);assert.equal(check.goods,'1050.00');assert.equal(check.paid,'125.00');assert.equal(check.closing,'925.00');assert.equal(check.balanced,true);
  assert.deepEqual(extraction.columns,['date','description','party','vehicle','weight','rate','goods','paid','balance','reference']);
  assert.equal(extraction.metadata.title,'LEDGER OF EXAMPLE MINERALS');assert.equal(extraction.metadata.issuerGuess,'EXAMPLE MINERALS');
  assert.equal(extraction.metadata.columns.find(column=>column.key==='paid').label,'RECIVED');
  assert.equal(extraction.metadata.columns.find(column=>column.key==='balance').label,'RECIVEABLE');
  assert.equal(extraction.metadata.openingBalance,undefined);assert.equal(extraction.metadata.closingBalance.value,'925.00');assert.equal(extraction.metadata.closingBalance.page,2);assert.equal(extraction.metadata.closingBalance.raw,'- | 925.00');
  assert.deepEqual(extraction.metadata.unreadablePages,[]);
  const active=extraction.rows.filter(row=>row.kind!=='excluded'),freight=active.at(-1);
  assert.equal(freight.rawDate,'');assert.equal(freight.effectiveDate,'');assert.ok(freight.issues.some(issue=>issue.includes('Missing source date')));
  assert.equal(active[0].party,'Example destination');assert.equal(active[0].vehicle,active[2].vehicle);assert.notEqual(active[0].id,active[2].id);
  assert.deepEqual(active.filter(row=>row.kind==='payment').map(row=>row.reference),['repeat-note','repeat-note']);
  assert.ok(active.every(row=>row.status==='Needs review'&&row.effectiveDate===''));
  assert.equal(extraction.rows.filter(row=>row.raw==='- | 925.00').length,2);
  assert.ok(extraction.rows.filter(row=>row.raw==='- | 925.00').every(row=>row.kind==='excluded'));
});

test('metadata exposes explicit balance evidence without inferring ownership or a closing from the final transaction',()=>{
  const source='LEDGER OF EXAMPLE TRADING\nOpening balance: 125.50\nDATE | DESCRIPTIONS | PARTY | VEH. # | WEIGHT | RATE | TOTAL | PAID | PAYABLE | TID #\n01-10-2026 | Delivery | Example destination | TEST-2 | 1.000 | 100 | 100 | | 225.50 |';
  const metadata=extractLedgerMetadata(source);
  assert.equal(metadata.issuerGuess,'EXAMPLE TRADING');assert.equal(metadata.openingBalance.value,'125.50');assert.equal(metadata.openingBalance.page,1);assert.equal(metadata.openingBalance.sequence,2);
  assert.equal(metadata.closingBalance,undefined);assert.equal('perspective'in metadata,false);assert.equal('role'in metadata,false);assert.equal('currency'in metadata,false);assert.equal('unit'in metadata,false);
  const closing=extractLedgerText(source+'\nClosing payable | | | | | | | | 225.50 |').metadata.closingBalance;
  assert.equal(closing.value,'225.50');assert.ok(closing.raw.startsWith('Closing payable'));
  const negative=extractLedgerMetadata('Closing balance: (125.50)');assert.equal(negative.closingBalance.value,'-125.50');
  assert.equal(extractLedgerMetadata('Closing balance: 1,2.00').closingBalance,undefined);
  assert.equal(extractLedgerMetadata('Closing balance | 500.00 | 1,2.00').closingBalance,undefined);
});

test('numeric normalization is decimal safe, validates grouping, and keeps malformed numbers in raw evidence',()=>{
  const text='DATE | DESCRIPTIONS | PARTY | VEH. # | WEIGHT | RATE | TOTAL | PAID | PAYABLE | TID #\n01-10-2026 | Precise amount | Example destination | TEST-3 | .125 | 72057594037927944.08 | 9007199254740993.01 | | 9007199254740993.01 | 0000123\n02-10-2026 | Exact payment | | | | | - | 1.01 | 9007199254740992.00 | 0000123';
  const extraction=extractLedgerText(text),goods=extraction.rows[1],check=reconcile(extraction.rows);
  assert.equal(goods.weight,'0.125');assert.equal(goods.rate,'72057594037927944.08');assert.equal(goods.goods,'9007199254740993.01');assert.equal(goods.reference,'0000123');assert.equal(check.closing,'9007199254740992.00');assert.equal(check.balanced,true);
  const bad=extractLedgerText(text.split('\n')[0]+'\n03-10-2026 | Malformed grouping | Example | TEST-4 | 1.000 | 12.00 | 1,2.00 | | 12.00 |').rows[1];
  assert.equal(bad.goods,'');assert.ok(bad.raw.includes('1,2.00'));assert.ok(bad.issues.some(issue=>issue.includes('Unrecognized source goods')));
});

test('positioned split header fragments and wrapped descriptions preserve one row while undated payments remain separate',()=>{
  const header=printedHeader().flatMap(cell=>cell.text==='VEH. #'?[{...cell,text:'VEH.',width:14},{...cell,text:'#',x:271,width:3}]:cell.text==='RECIVED'?[{...cell,text:'RECI',width:12},{...cell,text:'VED',x:471,width:10}]:[cell]);
  const extraction=extractLedgerPages([[
    ...header,
    ...printedRow({date:'01-10-2026',description:'Material delivery',party:'Example destination',vehicle:'TEST-5',weight:'1.000',rate:'100.00',goods:'100.00',balance:'100.00'},680),
    ...printedRow({description:'batch 2',party:'east yard'},672),
    ...printedRow({description:'Freight paid to example transporter',paid:'25.00',balance:'75.00'},640),
    ...printedRow({goods:'-',balance:'75.00'},620),
  ]]);
  const active=extraction.rows.filter(row=>row.kind!=='excluded');
  assert.equal(active.length,2);assert.equal(active[0].description,'Material delivery batch 2');assert.equal(active[0].party,'Example destination east yard');assert.ok(active[0].raw.includes('\nbatch 2 | east yard'));
  assert.equal(active[1].kind,'payment');assert.equal(active[1].rawDate,'');assert.equal(active[1].paid,'25.00');assert.equal(reconcile(extraction.rows).balanced,true);
  assert.equal(extraction.metadata.columns.find(column=>column.key==='vehicle').label,'VEH. #');
  assert.equal(extraction.metadata.columns.find(column=>column.key==='paid').label,'RECI VED');
});

test('mixed scanned or header-only pages are reported instead of silently treating the whole PDF as extracted',()=>{
  const first=[...printedHeader(),...printedRow({date:'01-10-2026',description:'Delivery',party:'Example destination',vehicle:'TEST-6',weight:'1.000',rate:'100.00',goods:'100.00',balance:'100.00'},680)];
  const extraction=extractLedgerPages([first,[],[...printedHeader(),{text:'Page 3 of 3',x:280,y:20,width:50}]]);
  assert.equal(extraction.pages,3);assert.deepEqual(extraction.metadata.unreadablePages,[2,3]);
  const text=extractLedgerText('DATE | DESCRIPTIONS | TOTAL | PAID | BALANCE\n01-10-2026 | Delivery | 100.00 | | 100.00\f\fDATE | DESCRIPTIONS | TOTAL | PAID | BALANCE');
  assert.equal(text.pages,3);assert.deepEqual(text.metadata.unreadablePages,[2,3]);
});
