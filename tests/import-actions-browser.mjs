import { browserLaunchOptions } from './browser-support.mjs';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// Real application components, isolated queued saves, no customer data or auth bypass.
const root = process.cwd(), output = path.join(root, 'outputs/import-actions-qa');
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
const statementName = 'QA draft statement.txt';
const statementRow = page => page.locator('.import-history tbody tr:visible, .import-history [data-testid=import-card]:visible').filter({ hasText: statementName });
const rowDelete = page => statementRow(page).getByRole('button', { name: `Delete ${statementName}`, exact: true });
async function openImports(page) {
  page.setDefaultTimeout(8000);
  await page.goto(origin + '/#Imports', { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Statement library', exact: true }).waitFor();
}
async function fixedLayout(dialog) {
  await dialog.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => {}))));
  const before = await dialog.evaluate(node => {
    const rect = selector => { const r = node.querySelector(selector).getBoundingClientRect(); return [r.top, r.bottom]; };
    return { header: rect('.hf-modal-header'), footer: rect('.hf-modal-footer'), body: rect('.hf-modal-body') };
  });
  await dialog.locator('.hf-modal-body').evaluate(node => { node.scrollTop = node.scrollHeight; });
  const after = await dialog.evaluate(node => {
    const rect = selector => { const r = node.querySelector(selector).getBoundingClientRect(); return [r.top, r.bottom]; };
    return { header: rect('.hf-modal-header'), footer: rect('.hf-modal-footer'), scroll: node.scrollTop, height: innerHeight, bodyOverflow: document.body.style.overflow };
  });
  assert.deepEqual(after.header, before.header, 'Only the modal body scrolls; its header stays visible.');
  assert.deepEqual(after.footer, before.footer, 'Only the modal body scrolls; its actions stay visible.');
  assert.ok(before.body[1] > before.body[0]); assert.ok(after.header[0] >= 0 && after.footer[1] <= after.height + 1);
  assert.equal(after.scroll, 0); assert.equal(after.bodyOverflow, 'hidden');
  await dialog.locator('.hf-modal-body').evaluate(node => { node.scrollTop = 0; });
}
async function unchangedFinancialRecords(page, before) {
  const after = await page.evaluate(() => window.__companyActionsQA.snapshot());
  assert.deepEqual(after.companies, before.companies); assert.deepEqual(after.shipments, before.shipments); assert.deepEqual(after.payments, before.payments);
  return after;
}

try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 320, height: 568 }]) {
    const context = await browser.newContext({ viewport, timezoneId: 'Asia/Karachi' });
    if (viewport.width === 320) await context.addInitScript(() => localStorage.setItem('hisab-theme', 'dark'));
    const page = await context.newPage(), errors = []; failurePage = page;
    page.on('pageerror', error => errors.push(error.message));
    await openImports(page);
    assert.equal(await page.locator('details.import-manual').count(), 0, 'Text import is a deliberate action instead of a native collapse bar.');
    await page.getByRole('button', { name: 'Import text or CSV', exact: true }).click();
    const importer = page.getByRole('dialog', { name: 'Import text or CSV', exact: true });
    await fixedLayout(importer);
    await importer.getByRole('tab', { name: 'Paste text', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await importer.getByRole('tab', { name: 'Upload file', exact: true }).getAttribute('aria-selected'), 'true', 'Importer methods support keyboard tab navigation.');
    await page.keyboard.press('Home');
    assert.equal(await importer.getByRole('tab', { name: 'Paste text', exact: true }).getAttribute('aria-selected'), 'true');
    const pasted = importer.getByLabel('Statement text', { exact: true });
    await pasted.fill('DATE | DESCRIPTIONS | TOTAL | PAYABLE\n2026-11-01 | QA review | 10.00 | 10.00');
    assert.equal(await importer.getByRole('button', { name: 'Extract pasted statement', exact: true }).isEnabled(), true);
    await importer.getByRole('tab', { name: 'Upload file', exact: true }).click();
    await importer.getByLabel('CSV or text statement', { exact: true }).setInputFiles({ name: 'QA reviewed.csv', mimeType: 'text/csv', buffer: Buffer.from('DATE,DESCRIPTIONS,TOTAL,PAYABLE\n2026-11-01,QA review,10.00,10.00') });
    assert.equal(await importer.getByRole('button', { name: 'Extract selected file', exact: true }).isEnabled(), true);
    await fixedLayout(importer);
    await importer.getByRole('tab', { name: 'Paste text', exact: true }).click();
    assert.match(await pasted.inputValue(), /QA review/, 'Switching importer methods keeps the unsubmitted text.');
    await importer.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await page.evaluate(() => window.__companyActionsQA.requests.length), 0, 'Opening or cancelling an import does not save anything.');

    const before = await page.evaluate(() => window.__companyActionsQA.snapshot());
    await rowDelete(page).click();
    let dialog = page.getByRole('dialog', { name: 'Delete statement', exact: true });
    await fixedLayout(dialog);
    assert.match(await dialog.innerText(), /QA draft statement\.txt/);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => window.__companyActionsQA.requests.length), 0);
    assert.equal(await statementRow(page).count(), 1, 'Cancel keeps the statement in its table.');

    await rowDelete(page).click();
    dialog = page.getByRole('dialog', { name: 'Delete statement', exact: true });
    await dialog.getByRole('button', { name: 'Delete statement', exact: true }).click();
    await page.waitForFunction(() => window.__companyActionsQA.pendingCount === 1);
    assert.equal(await dialog.isVisible(), true, 'Confirmation remains open until storage acknowledges deletion.');
    assert.equal(await page.locator('.toast').filter({ hasText: /deleted/i }).count(), 0);
    assert.equal(await page.evaluate(() => window.__companyActionsQA.snapshot().imports.length), 1, 'The durable statement remains until the request succeeds.');
    await page.evaluate(() => window.__companyActionsQA.releaseSave());
    await dialog.waitFor({ state: 'hidden' });
    await page.locator('.toast').filter({ hasText: /deleted/i }).waitFor();
    assert.equal(await statementRow(page).count(), 0);
    const after = await unchangedFinancialRecords(page, before);
    assert.equal(after.imports.length, 0);
    assert.match(after.audit[0].action, /deleted/i); assert.match(after.audit[0].detail, /QA draft statement\.txt/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Import actions fit narrow screens.');
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(output, `deleted-${viewport.width}.png`), animations: 'disabled' });
    await context.close();
  }

  const retryContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const retryPage = await retryContext.newPage(), errors = []; failurePage = retryPage;
  retryPage.on('pageerror', error => errors.push(error.message));
  await openImports(retryPage);
  const beforeRetry = await retryPage.evaluate(() => window.__companyActionsQA.snapshot());
  await rowDelete(retryPage).click();
  const dialog = retryPage.getByRole('dialog', { name: 'Delete statement', exact: true });
  await dialog.getByRole('button', { name: 'Delete statement', exact: true }).click();
  await retryPage.waitForFunction(() => window.__companyActionsQA.pendingCount === 1);
  await retryPage.evaluate(() => window.__companyActionsQA.releaseSave(503));
  await dialog.getByRole('button', { name: 'Retry save', exact: true }).waitFor();
  assert.equal(await dialog.isVisible(), true); assert.equal(await retryPage.locator('.toast').filter({ hasText: /deleted/i }).count(), 0);
  assert.equal(await retryPage.evaluate(() => window.__companyActionsQA.snapshot().imports.length), 1);
  await dialog.getByRole('button', { name: 'Retry save', exact: true }).click();
  await retryPage.waitForFunction(() => window.__companyActionsQA.pendingCount === 1 && window.__companyActionsQA.requests.length === 2);
  await retryPage.evaluate(() => window.__companyActionsQA.releaseSave());
  await dialog.waitFor({ state: 'hidden' });
  await retryPage.locator('.toast').filter({ hasText: /deleted/i }).waitFor();
  assert.equal((await unchangedFinancialRecords(retryPage, beforeRetry)).imports.length, 0);
  assert.deepEqual(errors, []); await retryContext.close();
  console.log('PASS statement row deletion: cancellation, acknowledged save, retry after failure, preserved financial records/audit, deliberate text/CSV importer tabs, fixed modal controls, and 320px dark layout.');
} catch (error) {
  await failurePage?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  console.error('Isolated browser state:', (await failurePage?.locator('body').innerText())?.slice(-5000));
  throw error;
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
