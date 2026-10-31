import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';

const origin=process.env.HISAB_QA_ORIGIN || 'http://127.0.0.1:5173';
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const errors=[];
const context=await browser.newContext({viewport:{width:1440,height:1000}});
const page=await context.newPage();
page.on('pageerror',error=>errors.push(error.message));
const privateMode=process.env.IMPORT_PRIVATE_QA==='1';
const sourceCode=await readFile('lib/pdf-extract.ts','utf8');
const sampleText=sourceCode.match(/export const SAMPLE_LEDGER = `([\s\S]*?)`;/)[1];
const statementText=sampleText+'\n'.repeat(Date.now()%10000+1);
const statementHash=createHash('sha256').update(statementText).digest('hex');
const statementName=privateMode?'Transcribed statement.txt':'Example mineral ledger.txt';
await mkdir('outputs',{recursive:true});

function syntheticPdf() {
  const xs=[30,150,400,600,700,800,900,1030,1160,1320];
  const rows=[['DATE','DESCRIPTIONS','PARTY','VEH. #','WEIGHT','RATE','TOTAL','PAID','PAYABLE','TID #'],['12-10-2026','Example delivery','Example Mill','QA-401','2.500','100.00','250.00','','250.00',''],['13-10-2026','Example transfer','','','','','','100.00','150.00','QA-REF'],['Closing balance','','','','','','','','150.00','']];
  const stream=rows.flatMap((cells,index)=>cells.map((value,column)=>value?`BT /F1 9 Tf 1 0 0 1 ${xs[column]} ${500-index*30} Tm (${value.replaceAll('(','\\(').replaceAll(')','\\)')}) Tj ET`:'')).join('\n');
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1500 550] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let pdf='%PDF-1.4\n';const offsets=[0];
  objects.forEach((value,index)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${index+1} 0 obj\n${value}\nendobj\n`;});
  const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n `).join('\n')}\ntrailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

async function saved() {
  if(privateMode) await page.locator('.save-status').filter({hasText:'All changes saved'}).waitFor({timeout:15000});
}
async function mapAndReview(companyId) {
  console.log('Mapping statement');
  await page.getByLabel('Source statement issuer',{exact:true}).fill('Example Statement Issuer');

  await page.getByLabel('Accounting counterparty',{exact:true}).selectOption(companyId);
  await page.getByLabel('Source statement perspective',{exact:true}).selectOption('Supplier statement');
  await page.getByLabel('Meaning of the PARTY column',{exact:true}).selectOption('Delivery recipient or destination');
  await page.getByLabel('Goods direction in your books',{exact:true}).selectOption('Receipt');
  await page.getByLabel('I have confirmed the currency and quantity unit').check();
  await page.getByLabel('History coverage',{exact:true}).selectOption('Partial history');
  await page.getByLabel('Printed source closing balance',{exact:true}).fill('219000.00');
  await page.getByRole('button',{name:'Continue to review'}).click();await saved();
  const count=await page.locator('.import-row').count();assert.equal(count,5);
  for(let index=0;index<count;index++) {
    const row=page.locator('.import-row').nth(index);
    await row.locator('.import-row-summary').click();
    const date=row.getByLabel('Approve effective date',{exact:true});
    if(!(await date.inputValue())) await date.fill('2026-10-14');
    if(await row.getByLabel('Actual payer / beneficiary',{exact:true}).count()) {
      await row.getByLabel('Actual payer / beneficiary',{exact:true}).fill('Example Remitter');
      await row.getByLabel('Allocate to accounting company',{exact:true}).selectOption(companyId);
      await row.getByLabel('Reviewed accounting treatment',{exact:true}).selectOption('Supplier settlement');
    }
    await row.getByRole('button',{name:'Approve reviewed row',exact:true}).click();
    await row.locator('.import-status.approved').waitFor();
  }
  await page.getByRole('button',{name:'Reconcile statement',exact:true}).click();await saved();
  await page.getByText('The closing balance reconciles.',{exact:true}).waitFor();
  assert.match(await page.locator('.import-reconcile-stats').textContent(),/519,000\.00/);
  assert.match(await page.locator('.import-reconcile-stats').textContent(),/300,000\.00/);
  assert.match(await page.locator('.import-reconcile-stats').textContent(),/219,000\.00/);
  assert.equal(await page.locator('.import-source-table tbody tr').count(),5);
  await page.getByRole('button',{name:'Preview accounting effects',exact:true}).click();await saved();
}

try {
  let companyId;
  if(privateMode) {
    await context.request.get(`${origin}/signin-with-chatgpt?return_to=/`);
    const response=await context.request.get(`${origin}/api/workspace`);assert.equal(response.status(),200);
    const current=await response.json();
    const data=current.data || {business:'QA Trading Sandbox',currency:'PKR',openingCash:'0.00',companies:[],shipments:[],payments:[],imports:[],audit:[]};
    companyId=`QA-IMPORT-${Date.now()}`;
    data.companies.push({id:companyId,name:'Example Ledger Counterparty',role:'Both',aliases:[],balance:'0.00',status:'Active'});
    const seed=await context.request.put(`${origin}/api/workspace`,{data:{data,revision:current.revision,action:'Local browser QA fixture',detail:'Synthetic import test counterparty'}});
    assert.equal(seed.status(),200,await seed.text());
  }
  const workspaceLoaded=page.waitForResponse(response=>response.url().endsWith('/api/workspace'));
  await page.goto(`${origin}/#Imports`,{waitUntil:'domcontentloaded'});await workspaceLoaded;
  if(privateMode) {await page.getByRole('button',{name:/Paste extracted rows/}).click();await page.locator('.import-paste textarea').fill(statementText);await page.getByRole('button',{name:'Extract pasted statement',exact:true}).click();}
  else await page.getByRole('button',{name:/Try a sample ledger/}).click();
  await page.getByRole('heading',{name:statementName,exact:true}).waitFor();
  await saved();
  if(!companyId) companyId=await page.getByLabel('Accounting counterparty',{exact:true}).locator('option').filter({hasText:'Crescent Energy'}).getAttribute('value');
  assert.ok(companyId);
  await mapAndReview(companyId);console.log('All source rows reviewed and reconciled');
  await page.getByLabel('I confirm the ledger perspective').check();
  const postButton=page.getByRole('button',{name:'Confirm & post import',exact:true});
  if(privateMode) {
    const enabled=await postButton.isEnabled();assert.equal(enabled,true,enabled?'':await page.locator('.import-blockers').textContent());
    await postButton.click();await saved();console.log('Post request saved');
    await page.getByRole('heading',{name:'A statement you can stand behind.',exact:true}).waitFor();
    const response=await context.request.get(`${origin}/api/workspace`);const result=await response.json();
    const batch=result.data.imports.find(item=>item.hash===statementHash&&item.status==='Posted');assert.ok(batch);
    const shipments=result.data.shipments.filter(item=>item.sourceRef===batch.id);
    const payments=result.data.payments.filter(item=>item.sourceRef===batch.id);
    assert.equal(shipments.length,3);assert.equal(payments.length,2);
    assert.equal(shipments.find(item=>item.status==='Rejected').amount,'6000.00');
    assert.equal(result.data.companies.find(item=>item.id===companyId).balance,'-219000.00');
    assert.ok(payments.every(item=>item.actor==='Example Remitter'&&item.status==='Needs review'&&item.account.startsWith('Unassigned')));
    assert.ok(batch.rows.filter(item=>item.status==='Approved').every(item=>item.reviewer==='Seedy'&&item.reviewedAt));
    const original=await context.request.get(`${origin}/api/files?key=${encodeURIComponent(batch.fileKey)}`);assert.equal(original.status(),200);assert.match(await original.text(),/DATE \| DESCRIPTIONS/);
    await page.screenshot({path:'outputs/import-posted-desktop.png',fullPage:true});
    await page.getByRole('button',{name:'Back to statements',exact:true}).click();
    await page.getByRole('button',{name:/Paste extracted rows/}).click();await page.locator('.import-paste textarea').fill(statementText);await page.getByRole('button',{name:'Extract pasted statement',exact:true}).click();
    await page.getByRole('heading',{name:'A statement you can stand behind.',exact:true}).waitFor();
    const reimport=await context.request.get(`${origin}/api/workspace`);const reimportData=await reimport.json();
    assert.equal(reimportData.data.imports.filter(item=>item.hash===batch.hash).length,1);
    await page.getByRole('button',{name:'Back to statements',exact:true}).click();
  } else {
    assert.equal(await postButton.isDisabled(),true);
    await page.getByText('Retain the uploaded source file and its hash before posting.',{exact:true}).waitFor();
    await page.screenshot({path:'outputs/import-review-demo-desktop.png',fullPage:true});
    await page.getByRole('button',{name:'All statements',exact:true}).click();
  }
  await page.locator('input[type=file]').setInputFiles({name:`Synthetic QA ledger ${Date.now()}.pdf`,mimeType:'application/pdf',buffer:syntheticPdf()});
  await page.locator('.import-document-heading h2').filter({hasText:'Synthetic QA ledger'}).waitFor({timeout:20000});
  assert.match(await page.locator('.import-document-heading p').textContent(),/2 transaction rows/);
  await page.screenshot({path:`outputs/import-pdf-${privateMode?'private':'demo'}-desktop.png`,fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:`outputs/import-pdf-${privateMode?'private':'demo'}-mobile.png`,fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({mode:privateMode?'signed-private':'unsigned-demo',sampleReview:'passed',sourceReconciliation:'passed',safePosting:privateMode?'posted atomically and verified durable':'blocked without retained original',pdfExtraction:'passed',mobileOverflow:'none',runtimeErrors:errors.length}));
} catch(error) {await page.screenshot({path:'outputs/import-browser-failure.png',fullPage:true});console.log('failure-state',await page.locator('body').innerText());throw error;} finally { await context.close();await browser.close(); }
