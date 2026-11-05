import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { browserLaunchOptions } from './browser-support.mjs';

// Independent, loopback-only behavior coverage for the shared render window.
const root = process.cwd(), output = path.join(root, 'outputs/infinite-hook-qa');
await mkdir(output, { recursive: true });
await build({
  stdin: { contents: `
    import { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { useInfiniteList, InfiniteListFooter } from './components/hisab/infinite-list';
    function Harness() {
      const [dataset, setDataset] = useState('A');
      const [open, setOpen] = useState(false);
      const items = Array.from({length:13}, (_,index)=>({id:dataset+'-'+index,label:dataset+' record '+(index+1)}));
      const list = useInfiniteList(items, 'main:'+dataset);
      // Intentionally populated before its sentinel is mounted.
      const modal = useInfiniteList(items, 'modal:'+dataset);
      return <><button onClick={()=>setDataset(value=>value==='A'?'B':'A')}>Change dataset</button>
        <button onClick={()=>setOpen(value=>!value)}>Toggle modal list</button>
        <section id="main"><ul>{list.visibleItems.map(item=><li key={item.id}>{item.label}</li>)}</ul><InfiniteListFooter list={list} label="records"/></section>
        {open&&<section className="hf-modal" id="modal"><div className="scroll-panel"><ul>{modal.visibleItems.map(item=><li key={item.id}>{item.label}</li>)}</ul><InfiniteListFooter list={modal} label="modal records"/></div></section>}
      </>;
    }
    createRoot(document.getElementById('root')).render(<Harness/>);`, resolveDir: root, sourcefile: 'infinite-hook-entry.tsx', loader: 'tsx' },
  outfile: path.join(output, 'bundle.js'), bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', logLevel: 'warning',
});
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/') {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"><style>:root{--paper:#fff;--surface-subtle:#f4f6f1;--border-subtle:#dce3d7;--text-primary:#263021;--text-muted:#65715d}body{font:14px Arial;margin:20px}ul{padding:0;list-style:none}#main li{padding:8px;border-bottom:1px solid #ddd}.scroll-panel{height:180px;overflow:auto;border:1px solid #bbb;margin-top:20px}#modal li{height:60px;padding:8px;box-sizing:border-box}button{padding:10px;cursor:pointer}</style></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>'); return;
  }
  if (!['/bundle.js', '/bundle.css'].includes(pathname)) { response.writeHead(404); response.end(); return; }
  response.setHeader('Content-Type', pathname.endsWith('.js') ? 'application/javascript' : 'text/css');
  response.end(await readFile(path.join(output, pathname.slice(1))));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(browserLaunchOptions());
let failurePage;
try {
  const context = await browser.newContext({ viewport: { width: 1000, height: 900 }, reducedMotion: 'reduce' });
  await context.addInitScript(() => {
    const requestFrame = window.requestAnimationFrame.bind(window), cancelFrame = window.cancelAnimationFrame.bind(window);
    let next = 1000000000;
    const queue = new Map();
    window.__infiniteFrames = { hold: false, flush() { const callbacks = [...queue.values()]; queue.clear(); callbacks.forEach(callback => callback(performance.now())); }, get pending() { return queue.size; } };
    window.requestAnimationFrame = callback => { if (!window.__infiniteFrames.hold) return requestFrame(callback); const id = next++; queue.set(id, callback); return id; };
    window.cancelAnimationFrame = id => { if (!queue.delete(id)) cancelFrame(id); };
  });
  const page = await context.newPage(), errors = []; failurePage = page;
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin, { waitUntil: 'networkidle' });
  assert.equal(await page.locator('#main li').count(), 5);
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#main li').count(), 5, 'An initially visible sentinel must not drain the list before interaction.');

  await page.evaluate(() => { window.__infiniteFrames.hold = true; document.querySelector('#main button').click(); });
  await page.locator('#main [data-testid="infinite-footer"][aria-busy="true"]').waitFor();
  assert.equal(await page.locator('#main [data-testid="skeleton-item"]:visible').count(), 5);
  assert.equal(await page.locator('#main .hf-skeleton').first().evaluate(node => getComputedStyle(node).animationName), 'none', 'Reduced-motion skeletons stay static.');
  await page.evaluate(() => { window.__pendingWheelSeen = false; window.addEventListener('wheel', () => { window.__pendingWheelSeen = true; }, { once: true }); });
  await page.mouse.move(300, 300); await page.mouse.wheel(0, 9000);
  await page.waitForFunction(() => window.__pendingWheelSeen, null, { polling: 10 });
  await page.evaluate(() => window.__infiniteFrames.flush());
  assert.equal(await page.locator('#main li').count(), 5, 'The pending skeleton gets its own render boundary.');
  await page.evaluate(() => { window.__infiniteFrames.flush(); window.__infiniteFrames.hold = false; });
  await page.waitForFunction(() => document.querySelectorAll('#main li').length === 10);
  // Pending wheel intent must not survive for a later observer notification.
  await page.locator('#main [data-testid="infinite-sentinel"]').evaluate(node => { node.style.display = 'none'; });
  await page.waitForTimeout(50);
  await page.locator('#main [data-testid="infinite-sentinel"]').evaluate(node => { node.style.display = ''; });
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#main li').count(), 10, 'Appending once does not reconnect the observer and eagerly drain the rest.');
  await page.locator('#main').getByRole('button', { name: 'Load more records', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('#main li').length === 13);
  assert.equal(await page.locator('#main').getByRole('button').count(), 0);
  assert.match(await page.locator('#main [role="status"]').textContent(), /All 13 records loaded/);

  await page.getByRole('button', { name: 'Change dataset', exact: true }).click();
  assert.equal(await page.locator('#main li').count(), 5);
  await page.evaluate(() => { window.__infiniteFrames.hold = true; document.querySelector('#main button').click(); });
  await page.locator('#main [aria-busy="true"]').waitFor();
  await page.evaluate(() => document.querySelector('button').click());
  await page.waitForFunction(() => document.querySelector('#main li')?.textContent === 'A record 1');
  assert.equal(await page.locator('#main li').count(), 5);
  assert.equal(await page.evaluate(() => window.__infiniteFrames.pending), 0, 'Changing filters cancels the old pending frame.');
  await page.evaluate(() => { window.__infiniteFrames.hold = false; window.__infiniteFrames.flush(); });

  await page.getByRole('button', { name: 'Toggle modal list', exact: true }).click();
  assert.equal(await page.locator('#modal li').count(), 5);
  await page.locator('#modal .scroll-panel').evaluate(node => { node.scrollTop = node.scrollHeight; });
  await page.waitForFunction(() => document.querySelectorAll('#modal li').length === 10);
  assert.equal(await page.locator('#main li').count(), 5, 'A modal scroll must not load records behind it.');
  assert.equal(await page.evaluate(() => window.scrollY), 0);
  await page.locator('#modal .scroll-panel').evaluate(node => { node.scrollTop = node.scrollHeight; });
  await page.waitForFunction(() => document.querySelectorAll('#modal li').length === 13);
  await page.getByRole('button', { name: 'Toggle modal list', exact: true }).click();
  await page.mouse.move(300, 300); await page.mouse.wheel(0, 200);
  await page.waitForFunction(() => document.querySelectorAll('#main li').length === 10);
  assert.deepEqual(errors, []); await context.close();

  for (const mode of ['missing', 'throwing']) {
    const fallbackContext = await browser.newContext({ viewport: { width: 1000, height: 900 } });
    await fallbackContext.addInitScript(mode => {
      window.IntersectionObserver = mode === 'missing' ? undefined : class { constructor() { throw new Error('Unavailable observer fixture'); } };
    }, mode);
    const fallback = await fallbackContext.newPage(), fallbackErrors = []; failurePage = fallback;
    fallback.on('pageerror', error => fallbackErrors.push(error.message));
    await fallback.goto(origin, { waitUntil: 'networkidle' });
    assert.equal(await fallback.locator('#main li').count(), 5);
    await fallback.locator('#main').getByRole('button', { name: 'Load more records', exact: true }).click();
    await fallback.waitForFunction(() => document.querySelectorAll('#main li').length === 10);
    assert.deepEqual(fallbackErrors, []); await fallbackContext.close();
  }
  const wheelContext = await browser.newContext({ viewport: { width: 1000, height: 320 } });
  const wheelPage = await wheelContext.newPage(); failurePage = wheelPage;
  await wheelPage.goto(origin, { waitUntil: 'networkidle' });
  assert.equal(await wheelPage.locator('#main li').count(), 5);
  await wheelPage.mouse.move(400, 150); await wheelPage.mouse.wheel(0, 9000);
  await wheelPage.waitForFunction(() => document.querySelectorAll('#main li').length === 10);
  await wheelPage.waitForTimeout(150);
  assert.equal(await wheelPage.locator('#main li').count(), 10, 'One oversized wheel gesture adds exactly five without queuing another batch.');
  await wheelContext.close();
  console.log('PASS infinite hook: exact 5/10/13, single-gesture batches, no queued pending scroll, skeleton/reduced motion, filter cancellation, conditional modal/root isolation, and missing/failed-observer fallback.');
} catch (error) {
  await failurePage?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); throw error;
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
