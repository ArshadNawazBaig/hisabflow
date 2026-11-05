import { browserLaunchOptions } from './browser-support.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

function syntheticPdf() {
  const xs=[30,150,400,600,700,800,900,1030,1160,1320];
  const rows=[
    ['DATE','DESCRIPTIONS','PARTY','VEH. #','WEIGHT','RATE','TOTAL','PAID','PAYABLE','TID #'],
    ['12-10-2026','Example delivery','Example Mill','QA-401','2.500','100.00','250.00','','250.00',''],
    ['13-10-2026','Example transfer','','','','','','100.00','150.00','QA-REF'],
    ['Closing balance','','','','','','','','150.00',''],
  ];
  const text=(value,x,y,size=9)=>`BT /F1 ${size} Tf 1 0 0 1 ${x} ${y} Tm (${value.replaceAll('\\','\\\\').replaceAll('(','\\(').replaceAll(')','\\)')}) Tj ET`;
  const stream=[text('LEDGER OF EXAMPLE TRADING',30,550,12),...rows.flatMap((cells,row)=>cells.flatMap((value,column)=>value?[text(value,xs[column],500-row*30)]:[]))].join('\n');
  const objects=[
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1500 600] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf='%PDF-1.4\n';
  const offsets=[0];
  objects.forEach((object,index)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${index+1} 0 obj\n${object}\nendobj\n`;});
  const xref=Buffer.byteLength(pdf);
  pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n `).join('\n')}\ntrailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

// Isolated loopback entry exercises the production extractor without touching app auth or data.
const root=process.cwd();
const bundle=await build({
  stdin:{contents:"import { extractPdf } from './lib/pdf-extract'; import { reconcile } from './lib/accounting'; globalThis.extractPdf=extractPdf; globalThis.reconcile=reconcile;",resolveDir:root,sourcefile:'pdf-browser-entry.ts',loader:'ts'},
  bundle:true,platform:'browser',format:'esm',write:false,logLevel:'warning',
});
const assets=new Map([
  ['/', ['text/html','<!doctype html><html><head><link rel="icon" href="data:,"></head><body><script type="module" src="/bundle.js"></script></body></html>']],
  ['/bundle.js',['application/javascript',bundle.outputFiles[0].contents]],
  ['/pdf.worker.min.mjs',['application/javascript',await readFile(path.join(root,'public/pdf.worker.min.mjs'))]],
  ['/fixture.pdf',['application/pdf',syntheticPdf()]],
]);
const server=createServer((request,response)=>{
  const asset=assets.get(new URL(request.url,'http://localhost').pathname);
  if(!asset){response.writeHead(404);response.end();return;}
  response.writeHead(200,{'Content-Type':asset[0]});response.end(asset[1]);
});
let browser;
try {
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch(browserLaunchOptions());
  for(const removeIterator of [false,true]) {
    const context=await browser.newContext();
    try {
      if(removeIterator) await context.addInitScript(()=>{delete ReadableStream.prototype[Symbol.asyncIterator];});
      const page=await context.newPage(),errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.goto(origin);
      await page.waitForFunction(()=>typeof globalThis.extractPdf==='function');
      if(removeIterator) assert.equal(await page.evaluate(()=>typeof ReadableStream.prototype[Symbol.asyncIterator]),'undefined');
      const {extraction,check}=await page.evaluate(async()=>{
        const bytes=await(await fetch('/fixture.pdf')).arrayBuffer();
        const extraction=await globalThis.extractPdf(new File([bytes],'example-ledger.pdf',{type:'application/pdf'}));
        return {extraction,check:globalThis.reconcile(extraction.rows)};
      });
      const active=extraction.rows.filter(row=>row.kind!=='excluded');
      assert.equal(active.length,2);assert.equal(check.goodsCount,1);assert.equal(check.paymentCount,1);
      assert.equal(check.goods,'250.00');assert.equal(check.paid,'100.00');assert.equal(check.closing,'150.00');assert.equal(check.balanced,true);
      assert.deepEqual(check.transitions.map(row=>[row.source,row.computed,row.matches]),[['250.00','250.00',true],['150.00','150.00',true]]);
      assert.deepEqual(active.map(row=>row.rawDate),['12-10-2026','13-10-2026']);
      assert.deepEqual(active.map(row=>row.proposedDate),['2026-10-12','2026-10-13']);
      assert.ok(active.every(row=>row.effectiveDate===''&&row.status==='Needs review'&&row.page===1));
      assert.equal(active[0].weight,'2.500');assert.equal(active[1].reference,'QA-REF');
      assert.equal(extraction.metadata.issuerGuess,'EXAMPLE TRADING');assert.equal(extraction.metadata.closingBalance.value,'150.00');
      assert.deepEqual(extraction.metadata.unreadablePages,[]);assert.deepEqual(errors,[]);
      console.log(`PASS actual browser PDF extraction: ${removeIterator?'ReadableStream async iterator removed':'normal Chromium'}, 2 rows, exact balances, raw dates, no uncaught errors.`);
    } finally {await context.close();}
  }
} finally {
  try {await browser?.close();}
  finally {await new Promise(resolve=>server.close(resolve));}
}
