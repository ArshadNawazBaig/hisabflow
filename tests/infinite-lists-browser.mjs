import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import { browserLaunchOptions } from './browser-support.mjs';

// Synthetic snapshots are delivered only to this ephemeral loopback test app.
const root = process.cwd(), output = path.join(root, 'outputs/infinite-lists-qa');
await mkdir(output, { recursive: true });
await build({ entryPoints: [path.join(root, 'tests/fixtures/workspace-harness.tsx')], outfile: path.join(output, 'bundle.js'), bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', tsconfig: path.join(root, 'tsconfig.json'), external: ['/fonts/*'], logLevel: 'warning' });
await build({ entryPoints: [path.join(root,'tests/fixtures/skeleton-hydration.tsx')], outfile: path.join(output,'hydrate.js'), bundle:true, platform:'browser', format:'esm', jsx:'automatic', tsconfig:path.join(root,'tsconfig.json'), external:['/fonts/*'], logLevel:'warning' });
await build({ stdin:{ contents:'import { renderToString } from "react-dom/server"; import { createElement } from "react"; import { WorkspaceSkeleton } from "./components/hisab/workspace-skeleton"; export const markup=renderToString(createElement(WorkspaceSkeleton,{view:"Overview"}));', resolveDir:root, loader:'tsx' }, outfile:path.join(output,'skeleton-server.mjs'), bundle:true, platform:'node', format:'esm', packages:'external', loader:{'.css':'empty'}, logLevel:'warning' });
const { markup: initialMarkup } = await import(pathToFileURL(path.join(output,'skeleton-server.mjs')).href);
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if(pathname==='/hydration'){response.setHeader('Content-Type','text/html; charset=utf-8');response.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/hydrate.css"></head><body><div id="root">${initialMarkup}</div><script type="module" src="/hydrate.js"></script></body></html>`);return;}
  if (pathname === '/') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>'); return; }
  const filename = ['/bundle.js', '/bundle.css', '/hydrate.js', '/hydrate.css'].includes(pathname) ? path.join(output, pathname.slice(1)) : /^\/(?:fonts\/[\w.-]+|favicon.svg)$/.test(pathname) ? path.join(root, 'public', pathname.slice(1)) : null;
  if (!filename) { response.writeHead(404); response.end(); return; }
  try { response.setHeader('Content-Type', pathname.endsWith('.js') ? 'application/javascript' : pathname.endsWith('.css') ? 'text/css' : pathname.endsWith('.svg') ? 'image/svg+xml' : 'font/ttf'); response.end(await readFile(filename)); } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(browserLaunchOptions());
let failurePage;

function workspace() {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const records = Array.from({ length: 13 }, (_, index) => String(index + 1).padStart(2, '0'));
  return {
    business: 'Infinite list QA', currency: 'PKR', openingCash: '0.00',
    companies: records.map(id => ({ id: `CO-${id}`, name: `QA Customer ${id}`, role: 'Customer', aliases: [], balance: '50.00', status: 'Active' })),
    shipments: records.map(id => ({ id: `SHP-${id}`, direction: 'Dispatch', companyId: `CO-${id}`, deliveryParty: `Destination ${id}`, date, vehicle: `QA-${id}`, product: 'QA material', weight: '1.000', unit: 't', rate: '100.00', amount: '100.00', status: 'Delivered', settlement: 'Unsettled' })),
    payments: records.map(id => ({ id: `PAY-${id}`, direction: 'Received', date, companyId: `CO-${id}`, actor: `QA Remitter ${id}`, amount: '50.00', account: 'Business current', bankLabel: 'QA bank', reference: `REF-${id}`, treatment: 'Customer receipt', status: 'Allocated', balanceApplied: true })),
    imports: records.map(id => ({ id: `IMP-${id}`, name: `QA Statement ${id}.csv`, hash: id.repeat(32), createdAt: `${date}T10:00:00Z`, status: 'Draft', step: 1,
      mapping: { business: 'Infinite list QA', issuer: `QA Customer ${id}`, counterpartyId: `CO-${id}`, perspective: 'Customer statement', partyMeaning: 'Delivery recipient or destination', currency: 'PKR', unit: 'Metric tonnes', unitsConfirmed: true, history: 'Partial history', mode: 'Transactions', cutoff: '', direction: 'Dispatch', openingBalance: '0.00', expectedClosing: '130.00' },
      rows: records.map((row, index) => ({ id: `ROW-${id}-${row}`, page: 1, sequence: index + 1, rawDate: date, proposedDate: date, effectiveDate: date, description: `QA source goods ${row}`, party: `Destination ${row}`, vehicle: `QA-${row}`, weight: '1.000', rate: '10.00', goods: '10.00', paid: '', balance: `${(index + 1) * 10}.00`, reference: `ROW-${row}`, kind: 'goods', status: 'Needs review', issues: [], raw: `${date} | QA source goods ${row} | 1.000 | 10.00` })) })),
    audit: records.map(id => ({ id: `AUD-${id}`, at: `${date}T10:00:00Z`, action: `QA reviewed action ${id}`, detail: `QA reviewed details ${id}`, actor: 'QA owner' })),
  };
}

async function open(page, view = 'Companies', { fail = false, noObserver = false } = {}) {
  let release, started;
  const pending = new Promise(resolve => { release = resolve; });
  const requested = new Promise(resolve => { started = resolve; });
  if (noObserver) await page.addInitScript(() => { window.IntersectionObserver = undefined; });
  const data = workspace(), writes = [];
  await page.route('**/api/workspace', async route => {
    if (route.request().method() !== 'GET') { writes.push(route.request().postDataJSON()); await route.fulfill({ status: 500, json: { error: 'This read-only fixture never saves.' } }); return; }
    started(); await pending;
    await route.fulfill({ status: fail ? 503 : 200, json: fail ? { error: 'QA load failure.' } : { data, revision: 1, user: { id: 'QA-OWNER', name: 'QA owner', email: 'qa@example.invalid', provider: 'google' } } });
  });
  await page.goto(`${origin}/#${view}`, { waitUntil: 'domcontentloaded' });
  await requested;
  await page.locator('.hf-workspace-loading').waitFor();
  assert.equal(await page.locator('.hf-workspace-loading').getAttribute('aria-busy'), 'true');
  assert.equal(await page.locator('.hf-workspace-loading [data-testid=skeleton-item]:visible').count(), 5, 'Initial layout reserves five visible placeholders.');
  assert.equal(await page.getByText('QA Customer 01', { exact: true }).count(), 0, 'Pending load never substitutes records.');
  release();
  if (fail) await page.getByRole('heading', { name: 'Your workspace could not load.', exact: true }).waitFor();
  else {await page.locator('.hf-workspace-loading').waitFor({ state: 'hidden' });await page.evaluate(()=>document.fonts.ready);}
  return { data, writes };
}

async function nextBatch(page, footer, records, expected) {
  const geometry=await footer.getByTestId('infinite-sentinel').evaluate(node=>{
    const r=node.getBoundingClientRect(),root=node.closest('.hf-modal-body'),region=root?.getBoundingClientRect();
    return {delta:Math.max(120,r.top-(region?.bottom??innerHeight)+100),x:region?region.x+region.width/2:innerWidth/2,y:region?region.y+Math.min(region.height/2,100):Math.min(innerHeight/2,200)};
  });
  await page.mouse.move(geometry.x,geometry.y);
  await page.mouse.wheel(0,geometry.delta);
  await expect(records).toHaveCount(expected).catch(async error=>{console.error('Batch geometry',await footer.evaluate(node=>({footer:node.getBoundingClientRect().toJSON(),sentinel:node.querySelector('[data-testid=infinite-sentinel]').getBoundingClientRect().toJSON(),scrollY,viewport:innerHeight,parents:Array.from((function*(n){while(n){yield n;n=n.parentElement}})(node.parentElement)).map(n=>({tag:n.tagName,className:n.className,overflowY:getComputedStyle(n).overflowY,scrollTop:n.scrollTop}))})));throw error;});
}
async function batches(page, records, footer, count = 13) {
  await expect(records).toHaveCount(5);
  for (let expected = 10; expected < count + 5; expected += 5) await nextBatch(page, footer, records, Math.min(expected, count));
  assert.equal(await footer.getByRole('button', { name: /Load more/ }).count(), 0);
  assert.match(await footer.innerText(), new RegExp(`All ${count} .* loaded`));
  const identities = await records.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-record-id') || node.textContent));
  assert.equal(new Set(identities).size, count, 'Repeated end scrolling must not duplicate records.');
}
const navigate = async (page, view) => { await page.locator('.side-rail nav').getByRole('button', { name: view, exact: true }).click(); await page.evaluate(() => {window.scrollTo(0,0);return new Promise(resolve=>requestAnimationFrame(()=>resolve()));}); };

try {
  const hydrationContext=await browser.newContext({viewport:{width:390,height:844}}),hydrationPage=await hydrationContext.newPage();failurePage=hydrationPage;
  await hydrationPage.goto(`${origin}/hydration#Imports`,{waitUntil:'networkidle'});
  await hydrationPage.locator('.hf-loading-upload').waitFor();
  assert.deepEqual(await hydrationPage.evaluate(()=>window.__skeletonHydrationErrors),[],'Direct hash links hydrate without a loading-layout mismatch.');
  await hydrationContext.close();
  for (const viewport of [{ width: 1440, height: 720 }, { width: 390, height: 844 }, { width: 320, height: 568 }, { width:844,height:390 }, { width:390,height:320 }]) {
    const touch=viewport.width===844||viewport.height===320;
    const context = await browser.newContext({ viewport, hasTouch:touch, isMobile:touch, timezoneId: 'Asia/Karachi' });
    if (viewport.width === 320) await context.addInitScript(() => localStorage.setItem('hisab-theme', 'dark'));
    const page = await context.newPage(), errors = []; failurePage = page;
    page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
    const { writes } = await open(page);
    const mobile = viewport.width <= 700 || touch;
    if(mobile){
      const navigation=page.locator('.side-rail nav');
      await expect(navigation.locator('.rail-nav-label:visible')).toHaveCount(6);
      for(const target of await navigation.locator('button:visible').all()){const rect=await target.boundingBox();assert.ok(rect.width>=44&&rect.height>=44,'Mobile navigation has usable touch targets.');}
      await page.getByRole('button',{name:'Workspace menu',exact:true}).click();
      const account=page.locator('#workspace-account-menu');
      const theme=account.getByRole('button',{name:viewport.width===320?'Light appearance':'Dark appearance',exact:true});
      await theme.click();
      await page.getByRole('button',{name:'Workspace menu',exact:true}).click();
      await account.getByRole('button',{name:'Getting started',exact:true}).click();
      const help=page.getByRole('dialog',{name:'Getting started',exact:true});
      await help.getByRole('button',{name:'Close dialog',exact:true}).click();
      if(viewport.height===320){await page.getByRole('button',{name:'Workspace menu',exact:true}).click();await account.getByRole('button',{name:'Workspace settings',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Close dialog',exact:true}).click();}
    }
    for (const [view, label] of [['Companies', 'Company cards'], ['Deliveries', 'Delivery cards'], ['Payments', 'Payment cards'], ['Imports', 'Statement imports']]) {
      await navigate(page, view);
      const records = mobile ? page.locator(`[aria-label="${label}"]:visible > article`) : page.locator('table:visible tbody tr');
      await batches(page, records, page.getByTestId('infinite-footer'));
      if (mobile) assert.equal(await page.locator('table:visible').count(), 0, `${view} uses mobile cards.`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${view} fits ${viewport.width}px.`);
    }
    await navigate(page, 'Companies');
    await page.getByLabel('Search companies or aliases...', { exact: true }).fill('QA Customer 13');
    const companyRecords = mobile ? page.locator('[aria-label="Company cards"]:visible > article') : page.locator('table:visible tbody tr');
    await expect(companyRecords).toHaveCount(1);
    await page.getByLabel('Search companies or aliases...', { exact: true }).fill('');
    await expect(companyRecords).toHaveCount(5);
    if (mobile) { await companyRecords.first().getByRole('button', { name: 'View details', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: 'Close dialog', exact: true }).click(); }
    await navigate(page, 'Reports');
    for (const tab of ['Cash flow', 'Company balances', 'Truck-wise deliveries', 'Trading margin', 'Audit trail']) {
      await page.getByRole('button', { name: tab, exact: true }).click(); await page.evaluate(() => window.scrollTo(0, 0));
      const records = tab === 'Audit trail' ? page.locator('.rv-audit-list > article') : mobile ? page.locator('.rv-record-cards:visible > article') : page.locator('table:visible tbody tr');
      await batches(page, records, page.getByTestId('infinite-footer'));
      if (mobile) assert.equal(await page.locator('table:visible').count(), 0, `${tab} uses mobile cards.`);
    }
    await navigate(page, 'Overview');
    const activityRecords = mobile ? page.locator('.hf-activity-card:visible') : page.locator('.activity-table:visible tbody tr');
    await batches(page, activityRecords, page.getByTestId('infinite-footer'), 26);
    if (mobile) assert.equal(await page.locator('table:visible').count(), 0);
    await page.screenshot({ path: path.join(output, `overview-${viewport.width}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Search workspace', exact: true }).click();
    const searchDialog=page.getByRole('dialog',{name:'Search workspace',exact:true});
    await searchDialog.locator('input').fill('QA');
    await batches(page,searchDialog.locator('.search-results > button'),searchDialog.getByTestId('infinite-footer'),39);
    await searchDialog.getByRole('button',{name:'Close dialog',exact:true}).click();
    assert.deepEqual(writes, []); assert.deepEqual(errors, []);
    await context.close();
  }

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const page = await context.newPage(); failurePage = page;
  await open(page, 'Companies', { noObserver: true });
  const cards = page.locator('[aria-label="Company cards"]:visible > article'), footer = page.getByTestId('infinite-footer');
  await expect(cards).toHaveCount(5);
  // Hold render callbacks, not a simulated network timeout, to inspect the real
  // pending batch skeleton and then release the work normally.
  await page.evaluate(() => {
    const original = window.requestAnimationFrame, callbacks = [];
    window.requestAnimationFrame = callback => { callbacks.push(callback); return callbacks.length; };
    window.__releaseBatchFrames = () => { window.requestAnimationFrame = original; callbacks.forEach(callback => original(callback)); };
    document.querySelector('.hf-load-more').click();
  });
  await page.waitForFunction(() => document.querySelector('.hf-infinite-footer')?.getAttribute('aria-busy') === 'true', null, { polling: 10 });
  assert.equal(await footer.locator('[data-testid=skeleton-item]:visible').count(), 5);
  const animation = await footer.locator('.hf-skeleton').first().evaluate(node => getComputedStyle(node).animationName);
  assert.equal(animation, 'none', 'Reduced motion disables loading shimmer.');
  await page.evaluate(() => window.__releaseBatchFrames());
  await expect(cards).toHaveCount(10);
  await context.close();

  const errorContext = await browser.newContext({ viewport: { width: 390, height: 844 } }), errorPage = await errorContext.newPage(); failurePage = errorPage;
  await open(errorPage, 'Imports', { fail: true });
  assert.equal(await errorPage.locator('.hf-workspace-loading').count(), 0);
  await errorPage.getByRole('button', { name: 'Retry connection', exact: true }).waitFor();
  assert.equal(await errorPage.getByText('QA Customer 01', { exact: true }).count(), 0);
  await errorContext.close();
  console.log('PASS mobile cards and infinite lists: initial skeletons, exact five-item scroll batches across six views/all reports, filter resets, deduplication, end states, no mobile tables/overflow, preserved card actions, pending skeletons, fallback loading, reduced motion, and load-error recovery.');
} catch (error) {
  await failurePage?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  console.error('Infinite-list state:', (await failurePage?.locator('body').innerText())?.slice(-5000)); throw error;
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
