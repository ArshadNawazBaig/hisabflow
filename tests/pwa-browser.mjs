import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium, webkit, expect } from '@playwright/test';
import { browserLaunchOptions } from './browser-support.mjs';

// No sign-in, external requests, or customer records: the actual service worker
// and components run against this temporary server and synthetic workspace.
const useWebkit=process.env.HISABFLOW_TEST_BROWSER==='webkit';
const root=process.cwd(),output=path.join(root,useWebkit?'outputs/pwa-webkit-qa':'outputs/pwa-qa');
await mkdir(output,{recursive:true});
await build({entryPoints:[path.join(root,'tests/fixtures/pwa-harness.tsx')],outfile:path.join(output,'bundle.js'),bundle:true,platform:'browser',format:'esm',jsx:'automatic',tsconfig:path.join(root,'tsconfig.json'),define:{'process.env.NODE_ENV':'"production"'},external:['/fonts/*'],logLevel:'warning'});
const manifest=JSON.parse(await readFile(path.join(root,'public/manifest.webmanifest'),'utf8'));
assert.equal(manifest.name,'HisabFlow');assert.equal(manifest.short_name,'HisabFlow');assert.equal(manifest.display,'standalone');
assert.equal(manifest.scope,'/');assert.equal(manifest.start_url,'/');assert.ok(manifest.id);
assert.ok(manifest.icons.some(icon=>icon.sizes==='192x192'&&icon.type==='image/png'));
assert.ok(manifest.icons.some(icon=>icon.sizes==='512x512'&&icon.type==='image/png'));
assert.ok(manifest.icons.some(icon=>icon.purpose?.split(' ').includes('maskable')));
for(const icon of manifest.icons.filter(icon=>icon.type==='image/png')){
  const bytes=await readFile(path.join(root,'public',icon.src));
  const dimensions=icon.sizes.split('x').map(Number);
  assert.equal(bytes.readUInt32BE(16),dimensions[0]);assert.equal(bytes.readUInt32BE(20),dimensions[1]);
}
const date='2026-11-01',workspace={business:'Private PWA fixture',currency:'PKR',openingCash:'0.00',companies:[{id:'CO-PWA',name:'Private synthetic customer',role:'Customer',aliases:[],balance:'25.00',status:'Active'}],shipments:[],payments:[],imports:[],audit:[{id:'AUD-PWA',at:`${date}T12:00:00Z`,action:'Synthetic fixture only',detail:'No customer records',actor:'QA owner'}]};
const requests=[],writes=[];
let workerRevision=0;
const json=(response,status,value)=>{response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'private, no-store'});response.end(JSON.stringify(value));};
const server=createServer(async(request,response)=>{
  const url=new URL(request.url,'http://localhost'),pathname=url.pathname;
  requests.push({path:pathname,method:request.method});
  if(pathname==='/api/workspace'){
    if(request.method!=='GET'){writes.push(pathname);json(response,503,{error:'Read-only fixture.'});return;}
    json(response,200,{data:workspace,revision:1,user:{id:'QA-PWA',name:'QA owner',email:'qa@example.invalid',provider:'google'}});return;
  }
  if(pathname.startsWith('/api/')||pathname.startsWith('/auth/')){json(response,200,{private:'PRIVATE_RESPONSE_MARKER'});return;}
  if(pathname==='/login'){response.writeHead(200,{'Content-Type':'text/html','Cache-Control':'private, no-store'});response.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><h1>Signed-out fixture</h1><p>PRIVATE_PAGE_MARKER</p>');return;}
  if(pathname==='/_next/static/chunks/public-probe-ABCD1234.js'||pathname==='/_next/static/chunks/private-probe-DEADBEEF.js'){
    response.writeHead(200,{'Content-Type':'application/javascript','Cache-Control':pathname.includes('private')?'private, no-store':'public, max-age=31536000, immutable'});response.end(pathname.includes('private')?'/* PRIVATE_RESPONSE_MARKER */':'/* public asset fixture */');return;
  }
  if(pathname==='/'){
    response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'private, no-store'});
    response.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="manifest" href="/manifest.webmanifest"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>');return;
  }
  // Mirror Cloudflare's canonical HTML URL so worker installation cannot rely on redirects.
  if(pathname==='/offline.html'){response.writeHead(307,{Location:'/offline'});response.end();return;}
  const filename=pathname==='/offline'?path.join(root,'public/offline.html'):['/bundle.js','/bundle.css'].includes(pathname)?path.join(output,pathname.slice(1)):/^\/(?:sw\.js|offline\.html|manifest\.webmanifest|favicon\.svg|icons\/[\w.-]+\.png|fonts\/[\w.-]+\.ttf)$/.test(pathname)?path.join(root,'public',pathname.slice(1)):null;
  if(!filename){response.writeHead(404);response.end();return;}
  try{
    let content=await readFile(filename);
    if(pathname==='/sw.js'&&workerRevision)content=Buffer.concat([content,Buffer.from(`\n/* isolated test revision ${workerRevision} */\n`)]);
    response.writeHead(200,{'Content-Type':pathname.endsWith('.js')?'application/javascript':pathname.endsWith('.css')?'text/css':(pathname==='/offline'||pathname.endsWith('.html'))?'text/html; charset=utf-8':pathname.endsWith('.webmanifest')?'application/manifest+json':pathname.endsWith('.png')?'image/png':pathname.endsWith('.svg')?'image/svg+xml':'font/ttf','Cache-Control':pathname==='/sw.js'?'no-cache':'public, max-age=3600',...(pathname==='/sw.js'?{'Service-Worker-Allowed':'/'}:{})});response.end(content);
  }catch{response.writeHead(404);response.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`,browser=await (useWebkit?webkit:chromium).launch(useWebkit?{headless:true}:browserLaunchOptions());
let failurePage;
const errorMessages=[];
const watch=page=>{failurePage=page;page.setDefaultTimeout(10000);page.on('pageerror',error=>errorMessages.push(error.message));};
const cacheEntries=page=>page.evaluate(async()=>{const result=[];for(const name of await caches.keys())for(const request of await (await caches.open(name)).keys())result.push(new URL(request.url).pathname);return result;});
const installButton=page=>page.getByRole('button',{name:/Install (?:app|HisabFlow)/i}).last();
async function mockPrompt(page,outcome){
  await page.evaluate(outcome=>{
    window.__pwaPromptCalls=0;
    const event=new Event('beforeinstallprompt',{cancelable:true});
    Object.defineProperties(event,{prompt:{value:async()=>{window.__pwaPromptCalls++;}},userChoice:{value:Promise.resolve({outcome,platform:'web'})}});
    dispatchEvent(event);
  },outcome);
}
try{
  const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
  const legacyOffline=await context.request.get(origin+'/offline.html',{maxRedirects:0});assert.equal(legacyOffline.status(),307);assert.equal(legacyOffline.headers().location,'/offline');
  const page=await context.newPage();watch(page);
  await page.goto(origin,{waitUntil:'networkidle'});
  await page.locator('.hf-workspace-loading').waitFor({state:'hidden'});
  await page.waitForFunction(()=>Boolean(navigator.serviceWorker?.controller),null,{timeout:15000});
  assert.ok(await page.evaluate(()=>navigator.serviceWorker.controller?.scriptURL.endsWith('/sw.js')));
  await context.setOffline(true);await page.getByRole('status').filter({hasText:'You’re offline'}).waitFor();
  await context.setOffline(false);await page.getByRole('status').filter({hasText:'You’re offline'}).waitFor({state:'hidden'});
  const documents=[];page.on('request',request=>{if(request.isNavigationRequest()&&request.frame()===page.mainFrame())documents.push(request.url());});
  for(const view of ['Companies','Deliveries','Payments','Imports','Reports','Overview'])await page.locator('.side-rail nav').getByRole('button',{name:view,exact:true}).click();
  assert.deepEqual(documents,[],'Workspace navigation stays within the single document.');
  await page.evaluate(async()=>{await fetch('/api/files?key=private-fixture');await fetch('/auth/private-probe');await fetch('/_next/static/chunks/public-probe-ABCD1234.js');await fetch('/_next/static/chunks/private-probe-DEADBEEF.js');});
  await expect.poll(async()=>(await cacheEntries(page)).includes('/_next/static/chunks/public-probe-ABCD1234.js')).toBe(true);
  const cached=await cacheEntries(page);
  assert.ok(cached.includes('/offline'));assert.ok(!cached.includes('/offline.html'));
  assert.ok(!cached.some(value=>value==='/'||/^\/(?:api|auth)(?:\/|$)/.test(value)||['/login','/signup','/signin','/_next/static/chunks/private-probe-DEADBEEF.js'].includes(value)),'Private responses and documents never enter Cache Storage.');
  // A real worker update waits for the user and cannot discard unsaved edits.
  await page.goto(origin+'/?install',{waitUntil:'networkidle'});
  workerRevision++;
  await page.evaluate(async()=>{const registration=await navigator.serviceWorker.ready;await registration.update();});
  const updateButton=page.getByRole('button',{name:'Update',exact:true});
  await updateButton.waitFor();assert.ok(page.url().includes('?install'));
  await page.getByRole('checkbox',{name:'Unsaved fixture changes',exact:true}).check();await expect(updateButton).toBeDisabled();
  await page.getByRole('checkbox',{name:'Unsaved fixture changes',exact:true}).uncheck();await expect(updateButton).toBeEnabled();
  const updated=page.waitForEvent('load');await updateButton.click();await updated;await page.getByRole('heading',{name:'Install fixture',exact:true}).waitFor();
  await expect(page.getByText('A new version is ready',{exact:true})).toHaveCount(0);
  await page.goto(origin+'/login',{waitUntil:'networkidle'});
  assert.equal((await cacheEntries(page)).includes('/login'),false);
  await context.setOffline(true);
  await page.goto(origin+'/#Reports',{waitUntil:'domcontentloaded'});
  assert.match(await page.locator('body').innerText(),/offline|connection|internet/i);
  assert.doesNotMatch(await page.locator('body').innerText(),/PRIVATE_PAGE_MARKER|PRIVATE_RESPONSE_MARKER|Private synthetic customer/);
  assert.equal(await page.evaluate(()=>fetch('/api/workspace').then(()=>false,()=>true)),true,'Offline API calls fail instead of receiving stale records or fallback HTML.');
  const staticText=await page.evaluate(()=>fetch('/_next/static/chunks/public-probe-ABCD1234.js').then(response=>response.text()));
  assert.equal(staticText,'/* public asset fixture */');
  await page.screenshot({path:path.join(output,'offline-mobile.png'),animations:'disabled'});
  await page.setViewportSize({width:320,height:568});await page.emulateMedia({colorScheme:'light'});await page.screenshot({path:path.join(output,'offline-320-light.png'),animations:'disabled'});
  await page.emulateMedia({colorScheme:'dark'});await page.screenshot({path:path.join(output,'offline-320-dark.png'),animations:'disabled'});
  await context.setOffline(false);await page.goto(origin,{waitUntil:'networkidle'});await page.locator('.app-frame').waitFor();
  await context.close();

  for(const outcome of ['dismissed','accepted']){
    const installContext=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'}),installPage=await installContext.newPage();watch(installPage);
    await installPage.goto(origin+'/?install',{waitUntil:'networkidle'});
    await mockPrompt(installPage,outcome);await installButton(installPage).click();
    assert.equal(await installPage.evaluate(()=>window.__pwaPromptCalls),1);
    if(outcome==='dismissed'){await installButton(installPage).click();await installPage.getByRole('dialog',{name:'Install HisabFlow',exact:true}).waitFor();assert.equal(await installPage.evaluate(()=>window.__pwaPromptCalls),1,'A consumed install prompt is never reused.');await installPage.getByRole('button',{name:'Close dialog',exact:true}).click();}
    await installPage.evaluate(()=>dispatchEvent(new Event('appinstalled')));
    await expect(installButton(installPage)).toHaveCount(0);
    await installContext.close();
  }
  const iosContext=await browser.newContext({viewport:{width:320,height:568},hasTouch:true,isMobile:true,serviceWorkers:'block',userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'}),iosPage=await iosContext.newPage();watch(iosPage);
  await iosPage.goto(origin+'/?install',{waitUntil:'networkidle'});await installButton(iosPage).click();
  const instructions=iosPage.getByRole('dialog',{name:'Install HisabFlow',exact:true});await instructions.waitFor();
  assert.match(await instructions.innerText(),/Share/);assert.match(await instructions.innerText(),/Add to Home Screen/i);
  assert.equal(await iosPage.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await iosPage.evaluate(()=>document.getAnimations().filter(animation=>animation.effect?.getComputedTiming().iterations!==Infinity).forEach(animation=>animation.finish()));
  const before=await instructions.locator('.hf-modal-footer').boundingBox();await instructions.locator('.hf-modal-body').evaluate(node=>node.scrollTop=node.scrollHeight);const after=await instructions.locator('.hf-modal-footer').boundingBox();assert.ok(Math.abs(before.y-after.y)<1,'Install instructions keep their action footer fixed while onlythebody scrolls.');
  for(const button of await instructions.getByRole('button').all()){const box=await button.boundingBox();assert.ok(box.width>=44&&box.height>=44,'Install actions have44px touch targets.');}
  await instructions.locator('.hf-modal-body').evaluate(node=>node.scrollTop=0);
  await iosPage.screenshot({path:path.join(output,'ios-install-mobile.png'),animations:'disabled'});await iosContext.close();

  const standaloneContext=await browser.newContext({serviceWorkers:'block'});
  await standaloneContext.addInitScript(()=>{const original=matchMedia.bind(window);window.matchMedia=query=>query==='(display-mode: standalone)'?Object.defineProperty(original(query),'matches',{value:true}):original(query);});
  const standalonePage=await standaloneContext.newPage();watch(standalonePage);await standalonePage.goto(origin+'/?install',{waitUntil:'networkidle'});await expect(installButton(standalonePage)).toHaveCount(0);await standaloneContext.close();
  assert.deepEqual(writes,[]);assert.deepEqual(errorMessages,[]);
  console.log('PASS PWA: standalone manifest/icons, registered worker, same-document navigation, static-only caching, uncached private/API/auth responses, safe offline launch/reconnect, user-controlled guarded updates, native prompt outcomes, iPhone instructions, and installed-state hiding.');
}catch(error){await failurePage?.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});throw error;}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
