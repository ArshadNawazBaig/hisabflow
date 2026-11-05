import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium, webkit, expect } from '@playwright/test';
import { browserLaunchOptions } from './browser-support.mjs';
import { saveSchema } from '../lib/workspace-validation.ts';
import { add, subtract, affectsCash, validatePostedChanges, validateWorkspaceRecords } from '../lib/accounting.ts';
import { companyAccountSummary, shipmentAdvanceSummary } from '../lib/company-account.ts';

// Actual UI and accounting validation, with disposable records on loopback only.
const root=process.cwd(), useWebkit=process.env.HISABFLOW_TEST_BROWSER==='webkit';
const output=path.join(root,useWebkit?'outputs/company-advance-webkit-qa':'outputs/company-advance-qa');
await mkdir(output,{recursive:true});
await build({entryPoints:[path.join(root,'tests/fixtures/workspace-harness.tsx')],outfile:path.join(output,'bundle.js'),bundle:true,platform:'browser',format:'esm',jsx:'automatic',tsconfig:path.join(root,'tsconfig.json'),external:['/fonts/*'],logLevel:'warning'});
const actor='Advance QA owner', owner='isolated-advance-qa';
const empty=()=>({business:'Advance flow QA',currency:'PKR',openingCash:'0.00',companies:[],shipments:[],payments:[],imports:[],audit:[]});
let stored=empty(), revision=0, failNextSave=false, expectedRejection=false;
const rejectedSaves=[];
const json=(response,status,value)=>{response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(JSON.stringify(value));};
const server=createServer(async(request,response)=>{
  const url=new URL(request.url,'http://localhost');
  try {
    if(url.pathname==='/api/workspace'){
      if(request.method==='GET')return json(response,200,{data:stored,revision,user:{id:owner,name:actor,email:'advance-qa@example.invalid',provider:'google'}});
      assert.equal(request.method,'PUT');assert.equal(request.headers['x-workspace-owner'],encodeURIComponent(owner));
      const chunks=[];for await(const chunk of request)chunks.push(chunk);
      if(failNextSave){failNextSave=false;return json(response,503,{error:'Temporary QA save failure. Retry your changes.'});}
      const parsed=saveSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString()));
      if(!parsed.success){if(!expectedRejection)rejectedSaves.push(parsed.error.issues);return json(response,400,{error:'Invalid fields',fields:parsed.error.issues.map(issue=>`${issue.path}: ${issue.message}`)});}
      const body=parsed.data;if(body.revision!==revision)return json(response,409,{error:'Workspace changed.'});
      const errors=[...validateWorkspaceRecords(body.data,stored),...validatePostedChanges(body.data,stored,actor)];
      if(errors.length){if(!expectedRejection)rejectedSaves.push(errors);return json(response,400,{error:'Invalid accounting effects',fields:errors});}
      stored={...body.data,audit:[{id:`AUD-${randomUUID()}`,at:new Date().toISOString(),action:body.action,detail:body.detail,actor},...stored.audit]};
      return json(response,200,{data:stored,revision:++revision});
    }
    if(url.pathname==='/'){
      response.setHeader('Content-Type','text/html; charset=utf-8');response.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>');return;
    }
    const filename=['/bundle.js','/bundle.css'].includes(url.pathname)?path.join(output,url.pathname.slice(1)):/^\/(?:fonts\/[\w.-]+|favicon.svg)$/.test(url.pathname)?path.join(root,'public',url.pathname.slice(1)):null;
    if(!filename){response.writeHead(404);response.end();return;}
    response.setHeader('Content-Type',filename.endsWith('.js')?'application/javascript':filename.endsWith('.css')?'text/css':filename.endsWith('.svg')?'image/svg+xml':'font/ttf');response.end(await readFile(filename));
  }catch(error){console.error('Advance fixture:',error);json(response,500,{error:'QA fixture failed.'});}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await(useWebkit?webkit:chromium).launch(useWebkit?{headless:true}:browserLaunchOptions());
let failurePage;
const cash=()=>stored.payments.filter(affectsCash).reduce((balance,payment)=>payment.direction==='Received'?add(balance,payment.amount):subtract(balance,payment.amount),stored.openingCash);
try{
  for(const viewport of [{width:1440,height:1000},{width:320,height:568}]){
    stored=empty();revision=0;rejectedSaves.length=0;
    const context=await browser.newContext({viewport,timezoneId:'Asia/Karachi',hasTouch:viewport.width===320,isMobile:viewport.width===320});
    if(viewport.width===320)await context.addInitScript(()=>localStorage.setItem('hisab-theme','dark'));
    const page=await context.newPage(),errors=[];failurePage=page;page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin+'/#Companies',{waitUntil:'networkidle'});await page.locator('.hf-workspace-loading').waitFor({state:'hidden'});
    const navigate=async view=>{await page.locator('.side-rail nav').getByRole('button',{name:view,exact:true}).click();};
    const save=async button=>{const pending=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/workspace'&&response.request().method()==='PUT');await button.click();const response=await pending;assert.equal(response.status(),200,await response.text());await page.waitForFunction(()=>!document.querySelector('.save-status.saving'));};
    const choose=async(scope,label,value)=>{await scope.getByRole('combobox',{name:label,exact:true}).click();await page.getByRole('option',{name:value,exact:true}).click();};
    async function company(name){
      await navigate('Companies');await page.getByRole('button',{name:'Add company',exact:true}).click();const modal=page.getByRole('dialog');
      await modal.locator('input[name="name"]').fill(name);await choose(modal,'Relationship *','Customer');await save(modal.getByRole('button',{name:'Save company',exact:true}));return stored.companies.find(company=>company.name===name).id;
    }
    async function openCompany(name){
      await navigate('Companies');
      if(viewport.width<=700)await page.locator('[aria-label="Company cards"] > article').filter({hasText:name}).getByRole('button',{name:'View details',exact:true}).click();
      else await page.locator('.rv-table tbody tr').filter({hasText:name}).first().click();
      const modal=page.getByRole('dialog').last();await modal.getByRole('heading',{name,exact:true}).waitFor();return modal;
    }
    async function recordPayment(name,amount,advance){
      const account=await openCompany(name);await account.getByRole('button',{name:advance?'Record advance':'Record payment',exact:true}).click();
      const modal=page.getByRole('dialog',{name:'Record a payment',exact:true});await modal.waitFor();
      await expect(modal.getByRole('combobox',{name:'Accounting company',exact:true})).toContainText(name);
      await expect(modal.getByRole('combobox',{name:'Money movement *',exact:true})).toContainText('Received');
      if(advance)await expect(modal.getByRole('combobox',{name:'Reviewed accounting treatment *',exact:true})).toContainText('Advance');
      else await choose(modal,'Reviewed accounting treatment *','Customer receipt');
      await modal.locator('input[name="actor"]').fill('QA actual payer');await modal.locator('input[name="amount"]').fill(amount);
      await modal.getByRole('combobox',{name:'My cash / bank account',exact:true}).fill('Business current');
      await modal.locator('input[name="reference"]').fill(advance?'ADVANCE-QA-001':'RECEIPT-QA-001');
      await save(modal.getByRole('button',{name:'Save payment',exact:true}));
    }
    async function sale(name,amount,apply){
      const account=await openCompany(name);await account.getByRole('button',{name:'Record sale',exact:true}).click();
      const modal=page.getByRole('dialog',{name:'Record a delivery',exact:true});await modal.waitFor();
      await expect(modal.getByRole('combobox',{name:'Accounting counterparty *',exact:true})).toContainText(name);
      await modal.locator('input[name="product"]').fill('QA reviewed product');await modal.locator('input[name="amount"]').fill(amount);
      const option=modal.getByRole('checkbox',{name:'Apply customer advance',exact:true});
      if(apply){await option.check();await expect.poll(async()=>add(await modal.getByRole('spinbutton',{name:'Advance to apply',exact:true}).inputValue()||'0','0')).toBe(apply);}
      else if(await option.count())await option.uncheck();
      await save(modal.getByRole('button',{name:'Save delivery',exact:true}));return stored.shipments[0].id;
    }
    const customer=await company('QA advance customer');
    await recordPayment('QA advance customer','100.00',true);
    assert.equal(add(stored.companies.find(item=>item.id===customer).balance,'0'),'0.00','Advance does not rewrite the legacy balance ledger.');
    assert.equal(companyAccountSummary(stored,customer).availableAdvance,'100.00');assert.equal(companyAccountSummary(stored,customer).balance,'100.00');assert.equal(cash(),'100.00');
    const first=await sale('QA advance customer','60.00','60.00');
    assert.equal(companyAccountSummary(stored,customer).availableAdvance,'40.00');assert.equal(companyAccountSummary(stored,customer).balance,'40.00');assert.equal(shipmentAdvanceSummary(stored,first).applied,'60.00');assert.equal(stored.payments.length,1);assert.equal(cash(),'100.00');
    const second=await sale('QA advance customer','70.00','40.00');
    assert.equal(companyAccountSummary(stored,customer).availableAdvance,'0.00');assert.equal(companyAccountSummary(stored,customer).balance,'-30.00');assert.equal(shipmentAdvanceSummary(stored,second).applied,'40.00');assert.equal(shipmentAdvanceSummary(stored,second).outstanding,'30.00');assert.equal(stored.payments.length,1);assert.equal(cash(),'100.00');
    await navigate('Companies');
    const dueRow=viewport.width<=700?page.locator('[aria-label="Company cards"] > article').filter({hasText:'QA advance customer'}):page.locator('.rv-table tbody tr').filter({hasText:'QA advance customer'});
    assert.match(await dueRow.innerText(),/[−-]\s*(?:₨|PKR)?\s*30\.00/,'The company register displays customer dues with a minus sign.');
    let account=await openCompany('QA advance customer');
    await expect(account.getByRole('tab',{name:'Payments',exact:true})).toHaveAttribute('aria-selected','true');
    assert.match(await account.locator('dl[aria-label="Company account summary"] dt').filter({hasText:/^Account balance$/}).locator('..').locator('dd').innerText(),/[−-]\s*30\.00/,'Customer account shows minus when the customer owes.');
    assert.match(await account.innerText(),/ADVANCE-QA-001/,'The actual payment reference is visible in company payment details.');
    await page.screenshot({path:path.join(output,`company-due-${viewport.width}.png`),animations:'disabled'});
    await account.getByRole('button',{name:'Close dialog',exact:true}).click();
    await recordPayment('QA advance customer','30.00',false);
    assert.equal(companyAccountSummary(stored,customer).balance,'0.00');assert.equal(stored.companies.find(item=>item.id===customer).balance,'100.00');assert.equal(stored.payments.length,2);assert.equal(cash(),'130.00');
    await page.reload({waitUntil:'networkidle'});await page.locator('.hf-workspace-loading').waitFor({state:'hidden'});account=await openCompany('QA advance customer');
    assert.match(await account.innerText(),/ADVANCE-QA-001/);assert.match(await account.innerText(),/RECEIPT-QA-001/);assert.equal(companyAccountSummary(stored,customer).balance,'0.00');await page.screenshot({path:path.join(output,`company-payments-${viewport.width}.png`),animations:'disabled'});await account.getByRole('button',{name:'Close dialog',exact:true}).click();

    const unfunded=await company('QA unpaid customer'),unfundedSale=await sale('QA unpaid customer','25.00',null);
    assert.equal(companyAccountSummary(stored,unfunded).balance,'-25.00');account=await openCompany('QA unpaid customer');assert.match(await account.locator('dl[aria-label="Company account summary"] dt').filter({hasText:/^Account balance$/}).locator('..').locator('dd').innerText(),/[−-]\s*25\.00/);await account.getByRole('button',{name:'Close dialog',exact:true}).click();
    await recordPayment('QA unpaid customer','10.00',true);assert.equal(companyAccountSummary(stored,unfunded).balance,'-15.00');
    account=await openCompany('QA unpaid customer');await account.getByRole('tab',{name:'Orders',exact:true}).click();await account.getByRole('button',{name:'Apply advance',exact:true}).first().click();
    const applyModal=page.getByRole('dialog',{name:'Apply advance',exact:true});await applyModal.getByRole('spinbutton',{name:'Advance to apply',exact:true}).fill('10.00');
    const paymentCount=stored.payments.length,beforeCash=cash(),beforeApplications=stored.advanceApplications.length;
    failNextSave=true;const failed=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/workspace'&&response.request().method()==='PUT');
    await applyModal.getByRole('button',{name:'Apply advance',exact:true}).click();assert.equal((await failed).status(),503);
    assert.equal(stored.advanceApplications.length,beforeApplications,'A failed application save leaves durable funds untouched.');
    await expect(applyModal.getByRole('button',{name:'Retry save',exact:true})).toBeVisible();
    await save(applyModal.getByRole('button',{name:'Retry save',exact:true}));await applyModal.waitFor({state:'hidden'});
    assert.equal(stored.advanceApplications.length,beforeApplications+1,'Retry persists one application rather than creating another.');
    assert.equal(shipmentAdvanceSummary(stored,unfundedSale).applied,'10.00');assert.equal(companyAccountSummary(stored,unfunded).availableAdvance,'0.00');assert.equal(companyAccountSummary(stored,unfunded).balance,'-15.00');assert.equal(stored.payments.length,paymentCount);assert.equal(cash(),beforeCash,'Applying existing funds cannot create another cash movement.');
    await page.getByRole('dialog').getByRole('button',{name:'Close dialog',exact:true}).click();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:path.join(output,`company-account-${viewport.width}.png`),fullPage:true,animations:'disabled'});

    const durable=structuredClone(stored),applications=durable.advanceApplications;
    assert.equal(applications.length,3);
    const invalids=[
      next=>{next.advanceApplications[2].amount='11.00';},
      next=>{next.advanceApplications[2].companyId=customer;},
      next=>{next.advanceApplications.push({...next.advanceApplications[2],id:'APP-overused'});},
      next=>{next.advanceApplications[2].date='2999-12-31';},
      next=>{next.advanceApplications[2].amount='invalid';},
      next=>{next.payments.find(payment=>payment.companyId===unfunded).amount='9.00';},
    ];
    for(const tamper of invalids){const incoming=structuredClone(durable);tamper(incoming);expectedRejection=true;try{const response=await context.request.put(origin+'/api/workspace',{headers:{'X-Workspace-Owner':encodeURIComponent(owner)},data:{data:incoming,revision,action:'QA rejected tamper',detail:'Synthetic negative validation check'}});assert.equal(response.status(),400,await response.text());assert.deepEqual(stored,durable,'Rejected requests leave the durable account unchanged.');}finally{expectedRejection=false;}}
    assert.deepEqual(rejectedSaves,[]);assert.deepEqual(errors,[]);await context.close();
  }
  console.log('PASS company advances: company payment details, prefilled advance/receipt/sale actions, exact advance consumption on orders, negative customer dues, existing-order application, no duplicate cash, acknowledged retry without duplication, durable reload, mobile layout, and rejected cross-company/overused/malformed/tampered applications.');
}catch(error){await failurePage?.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});console.error('Advance state:',(await failurePage?.locator('body').innerText())?.slice(-6000));throw error;}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
