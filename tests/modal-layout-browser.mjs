import { browserLaunchOptions } from './browser-support.mjs';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// Exercise real application dialogs against the isolated company fixture only.
const root = process.cwd(), output = path.join(root, 'outputs/modal-layout-qa');
await mkdir(output, { recursive: true });
await build({ entryPoints: [path.join(root, 'tests/fixtures/company-actions-harness.tsx')], outfile: path.join(output, 'bundle.js'), bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', tsconfig: path.join(root, 'tsconfig.json'), external: ['/fonts/*'], logLevel: 'warning' });
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/') {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>'); return;
  }
  const filename = ['/bundle.js', '/bundle.css'].includes(pathname) ? path.join(output, pathname.slice(1)) : pathname === '/favicon.svg' || /^\/fonts\/[\w.-]+$/.test(pathname) ? path.join(root, 'public', pathname.slice(1)) : null;
  if (!filename) { response.writeHead(404); response.end(); return; }
  try {
    response.setHeader('Content-Type', pathname.endsWith('.js') ? 'application/javascript' : pathname.endsWith('.css') ? 'text/css' : pathname.endsWith('.svg') ? 'image/svg+xml' : 'font/ttf');
    response.end(await readFile(filename));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(browserLaunchOptions());
let failurePage;

async function settle(dialog) {
  await dialog.waitFor();
  await dialog.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => {}))));
}
async function checkFixed(page, label, footerRequired = true) {
  const dialog = page.getByRole('dialog').filter({ has: page.locator('.hf-modal-body') });
  await settle(dialog);
  const body = dialog.locator('.hf-modal-body');
  const before = await dialog.evaluate(node => {
    const rect = selector => { const element = node.querySelector(selector); if (!element) return null; const r = element.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; };
    return { header: rect('.hf-modal-header'), footer: rect('.hf-modal-footer'), body: rect('.hf-modal-body'), scrollY, scrollTop: node.scrollTop, maxScroll: node.querySelector('.hf-modal-body').scrollHeight - node.querySelector('.hf-modal-body').clientHeight, bodyOverflow: getComputedStyle(document.body).overflow };
  });
  assert.ok(before.header, `${label}: fixed header exists.`);
  if (footerRequired) assert.ok(before.footer, `${label}: actions stay in a separate footer.`);
  assert.ok(before.body.bottom > before.body.top, `${label}: the body keeps usable height.`);
  assert.ok(before.header.top >= -1 && before.header.bottom <= page.viewportSize().height + 1, `${label}: header fits the viewport.`);
  assert.equal(before.bodyOverflow, 'hidden', `${label}: background scrolling is locked.`);
  await body.evaluate(node => { node.scrollTop = node.scrollHeight; });
  const after = await dialog.evaluate(node => {
    const rect = selector => { const element = node.querySelector(selector); if (!element) return null; const r = element.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; };
    return { header: rect('.hf-modal-header'), footer: rect('.hf-modal-footer'), body: rect('.hf-modal-body'), scrollY, scrollTop: node.scrollTop, bodyScroll: node.querySelector('.hf-modal-body').scrollTop };
  });
  assert.ok(Math.abs(after.header.top - before.header.top) < 1, `${label}: scrolling content must not move the header.`);
  assert.ok(Math.abs(after.header.bottom - before.header.bottom) < 1, `${label}: header height remains stable.`);
  if (before.footer) {
    assert.ok(Math.abs(after.footer.top - before.footer.top) < 1, `${label}: scrolling content must not move the footer.`);
    assert.ok(after.footer.bottom <= page.viewportSize().height + 1, `${label}: footer remains reachable.`);
    assert.ok(after.footer.top >= after.body.bottom - 1, `${label}: body does not cover footer actions.`);
  }
  assert.equal(after.scrollTop, 0, `${label}: the outer dialog never scrolls.`);
  assert.equal(after.scrollY, before.scrollY, `${label}: page remains in place.`);
  if (before.maxScroll > 2) assert.ok(after.bodyScroll > 0, `${label}: long body content scrolls.`);
  await body.evaluate(node => { node.scrollTop = 0; });
  return dialog;
}
async function close(page) {
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.notEqual(await page.evaluate(() => document.body.style.overflow), 'hidden');
}
async function popupVisible(page, selector) {
  const popup = page.locator(selector).last(); await popup.waitFor();
  const result = await popup.evaluate(node => {
    const r = node.getBoundingClientRect(), x = Math.max(1, Math.min(innerWidth - 1, r.x + r.width / 2)), y = Math.max(1, Math.min(innerHeight - 1, r.y + Math.min(r.height / 2, 50)));
    const hit = document.elementFromPoint(x, y);
    return { inViewport: r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1, receivesPointer: !!hit && node.contains(hit) };
  });
  assert.equal(result.inViewport, true, `${selector}: popup fits the viewport.`);
  assert.equal(result.receivesPointer, true, `${selector}: popup is not clipped by the scrolling body.`);
}
try {
  for (const viewport of [{ width: 1024, height: 600 }, { width: 320, height: 568 }]) {
    const context = await browser.newContext({ viewport, timezoneId: 'Asia/Karachi' });
    const page = await context.newPage(), errors = []; failurePage = page;
    page.setDefaultTimeout(8000); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin, { waitUntil: 'networkidle' });
    const navigate = async name => page.locator('.side-rail nav').getByRole('button', { name, exact: true }).click();
    await navigate('Companies');
    await page.getByRole('button', { name: 'Add company', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'A new connection', exact: true });
    await settle(editor);
    await page.keyboard.press('Control+k');
    const nestedSearch = page.getByRole('dialog', { name: 'Search workspace', exact: true });
    await settle(nestedSearch);
    assert.equal(await page.getByRole('dialog').count(), 2, 'Workspace search may open above an editor.');
    await page.keyboard.press('Escape');
    await nestedSearch.waitFor({ state: 'hidden' });
    assert.equal(await editor.isVisible(), true, 'Escape closes only the topmost search dialog.');
    assert.equal(await page.evaluate(() => document.body.style.overflow), 'hidden', 'Closing nested search retains the editor scroll lock.');
    await close(page);
    await page.getByRole('button', { name: 'Add company', exact: true }).click();
    await settle(editor);
    await page.keyboard.press('Control+k');
    await settle(nestedSearch);
    await nestedSearch.getByRole('button', { name: 'Payments', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.notEqual(await page.evaluate(() => document.body.style.overflow), 'hidden', 'Search navigation unmounts both dialogs and releases the background scroll lock.');
    await navigate('Companies');
    await page.getByRole('button', { name: 'Add company', exact: true }).click();
    let dialog = await checkFixed(page, 'Company editor');
    if (viewport.width <= 700) {
      // Mobile browsers can keep the layout viewport full-height while the
      // onscreen keyboard shrinks and pans the visual viewport.
      await page.evaluate(() => {
        const visual = window.visualViewport;
        Object.defineProperties(visual, {
          height: { configurable:true, get:()=>320 },
          offsetTop: { configurable:true, get:()=>40 },
        });
        visual.dispatchEvent(new Event('resize'));
      });
      await page.waitForFunction(() => document.querySelector('.modal-backdrop').style.getPropertyValue('--hf-modal-viewport-height') === '320px');
      const keyboardLayout = await dialog.evaluate(node => {
        const outer = node.getBoundingClientRect(), body = node.querySelector('.hf-modal-body').getBoundingClientRect(), footer = node.querySelector('.hf-modal-footer').getBoundingClientRect();
        return { top:outer.top, bottom:outer.bottom, bodyHeight:body.height, footerBottom:footer.bottom };
      });
      assert.ok(keyboardLayout.top >= 39 && keyboardLayout.bottom <= 361 && keyboardLayout.bodyHeight > 0 && keyboardLayout.footerBottom <= 361, 'The keyboard visual viewport keeps the dialog and fixed actions reachable.');
      await page.evaluate(() => {
        delete window.visualViewport.height;
        delete window.visualViewport.offsetTop;
        window.visualViewport.dispatchEvent(new Event('resize'));
      });
      await page.waitForFunction(() => Number.parseFloat(document.querySelector('.modal-backdrop').style.getPropertyValue('--hf-modal-viewport-height')) === window.visualViewport.height);
    }
    const save = dialog.getByRole('button', { name: 'Save company', exact: true });
    assert.equal(await save.evaluate(button => !!button.form && button.form.contains(button) && !!button.form.querySelector('.hf-modal-body input[name="name"]')), true, 'The fixed submit button retains its native form association.');
    await save.click();
    assert.equal(await page.evaluate(() => window.__companyActionsQA.requests.length), 0, 'The footer respects required-field validation.');
    await dialog.locator('input[name="name"]').fill(`Modal QA ${viewport.width}`);
    await dialog.getByRole('combobox', { name: 'Relationship *', exact: true }).click();
    await popupVisible(page, '.hf-select-popup');
    await page.getByRole('option', { name: 'Customer', exact: true }).click();
    await save.click();
    await page.waitForFunction(() => window.__companyActionsQA.pendingCount === 1);
    await page.evaluate(() => window.__companyActionsQA.releaseSave());
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.locator('.rv-table tbody tr:visible,.rv-record-card:visible').getByText(`Modal QA ${viewport.width}`, { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Actions for Ledger QA Co', exact: true }).click();
    await page.getByRole('menuitem', { name: 'View', exact: true }).click();
    await checkFixed(page, 'Company detail', false); await close(page);
    await page.getByRole('button', { name: 'Actions for Unused QA Co', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    await checkFixed(page, 'Delete confirmation'); await close(page);

    await navigate('Deliveries');
    await page.getByRole('button', { name: /Review matches/ }).click();
    await checkFixed(page, 'Shipment relationship review', false); await close(page);
    await page.getByRole('button', { name: 'Add delivery', exact: true }).click();
    dialog = await checkFixed(page, 'Delivery editor');
    await dialog.getByRole('combobox', { name: 'Accounting counterparty *', exact: true }).click();
    await popupVisible(page, '.hf-select-popup');
    await page.getByRole('option', { name: 'Ledger QA Co · Customer', exact: true }).click();
    await dialog.getByRole('button', { name: 'Shipment date *', exact: true }).click();
    await popupVisible(page, '.hf-calendar-popup');
    await page.keyboard.press('Escape');
    assert.equal(await dialog.isVisible(), true, 'Escape closes the calendar before its dialog.');
    await checkFixed(page, 'Delivery editor after popup');
    await close(page);
    if(viewport.width<=700)await page.locator('.rv-record-card[data-record-id="SHP-QA"]').getByRole('button',{name:'View details',exact:true}).click();else await page.locator('.rv-table tbody tr').filter({ hasText: 'QA-001' }).click();
    dialog = await checkFixed(page, 'Delivery detail');
    await dialog.getByRole('button', { name: 'Allocate purchase costs', exact: true }).click();
    await checkFixed(page, 'Purchase cost allocation'); await close(page);

    await navigate('Payments');
    await page.getByRole('button', { name: 'Record payment', exact: true }).click();
    dialog = await checkFixed(page, 'Payment editor');
    await dialog.getByRole('button', { name: 'Effective date *', exact: true }).click();
    await popupVisible(page, '.hf-calendar-popup');
    await page.keyboard.press('Escape');
    await close(page);
    if(viewport.width<=700)await page.locator('.rv-record-card[data-record-id="PAY-QA"]').getByRole('button',{name:'View details',exact:true}).click();else await page.locator('.rv-table tbody tr').filter({ hasText: 'PAY-QA' }).click();
    await checkFixed(page, 'Payment detail'); await close(page);

    await page.locator('.business-selector').click();
    await page.locator('.account-popover').getByRole('button', { name: 'Workspace settings', exact: true }).click();
    await checkFixed(page, 'Workspace settings'); await close(page);
    await page.locator('.business-selector').click();
    await page.getByRole('button', { name: 'Getting started', exact: true }).click();
    await checkFixed(page, 'Getting started'); await close(page);

    await page.keyboard.press('Control+k');
    dialog = await checkFixed(page, 'Workspace search', false);
    await dialog.locator('input').fill('QA');
    await checkFixed(page, 'Search results', false); await close(page);
    await navigate('Overview');
    await page.getByRole('combobox', { name: 'Activity date range', exact: true }).click();
    await page.getByRole('option', { name: 'All time', exact: true }).click();
    if(viewport.width<=700)await page.locator('.hf-activity-card').first().getByRole('button',{name:/View /}).click();else await page.locator('.activity-table tbody tr').first().click();
    await checkFixed(page, 'Transaction detail'); await close(page);
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await context.close();
  }
  console.log('PASS modal layouts: fixed headers/footers, body-only scrolling, short desktop and 320px mobile viewports, native footer validation/submission, unclipped select/calendar popups, nested-search Escape/navigation recovery, and background scroll locking across company, delivery, payment, costing, settings, help, search, and activity dialogs.');
} catch (error) {
  await failurePage?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  console.error('Modal QA state:', (await failurePage?.locator('body').innerText())?.slice(-3500));
  throw error;
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
