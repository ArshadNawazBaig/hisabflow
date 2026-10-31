import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// Ephemeral loopback QA only; never changes auth guards or writes to the real database.
const root = process.cwd(), output = path.join(root, 'outputs/company-actions-qa');
await mkdir(output, { recursive: true });
await build({ entryPoints: [path.join(root, 'tests/fixtures/company-actions-harness.tsx')], outfile: path.join(output, 'bundle.js'), bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', tsconfig: path.join(root, 'tsconfig.json'), external: ['/fonts/*'], logLevel: 'warning' });
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/') {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>');
    return;
  }
  const file = pathname === '/bundle.js' || pathname === '/bundle.css' ? path.join(output, pathname.slice(1)) : pathname === '/favicon.svg' || /^\/fonts\/[\w.-]+$/.test(pathname) ? path.join(root, 'public', pathname.slice(1)) : null;
  if (!file) { response.writeHead(404); response.end(); return; }
  try {
    response.setHeader('Content-Type', pathname.endsWith('.js') ? 'application/javascript' : pathname.endsWith('.css') ? 'text/css' : pathname.endsWith('.svg') ? 'image/svg+xml' : 'font/ttf');
    response.end(await readFile(file));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
let failurePage;

async function openCompanies(page, mobile = false) {
  await page.goto(base, { waitUntil: 'networkidle' });
  await (mobile ? page.locator('.side-rail nav') : page.locator('.top-navigation')).getByRole('button', { name: 'Companies', exact: true }).click();
  await page.getByRole('columnheader', { name: 'Actions', exact: true }).waitFor();
}
const actionTrigger = (page, name) => page.getByRole('button', { name: `Actions for ${name}`, exact: true });
async function chooseAction(page, name, action) {
  await actionTrigger(page, name).click();
  assert.equal(await page.getByRole('dialog').count(), 0, 'Opening row actions must not open company details.');
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}
async function assertFocusReturned(page, name) {
  try {
    await page.waitForFunction(label => document.activeElement?.getAttribute('aria-label') === `Actions for ${label}`, name);
  } catch (error) {
    console.error('Focus did not return:', name, await page.evaluate(() => ({ tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label') })));
    throw error;
  }
}

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Karachi' });
  const page = await context.newPage(), errors = [];
  failurePage = page;
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  await openCompanies(page);
  assert.equal(await page.locator('.rv-table tbody tr').count(), 4);

  const unused = 'Unused QA Co', trigger = actionTrigger(page, unused);
  await trigger.focus(); await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: 'View', exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0);
  await page.keyboard.press('Escape');
  await page.getByRole('menuitem', { name: 'View', exact: true }).waitFor({ state: 'hidden' });
  await assertFocusReturned(page, unused);

  await chooseAction(page, unused, 'View');
  let dialog = page.getByRole('dialog', { name: unused, exact: true });
  await dialog.waitFor();
  assert.equal(await page.getByRole('dialog').count(), 1);
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await assertFocusReturned(page, unused);

  await chooseAction(page, unused, 'Edit');
  dialog = page.getByRole('dialog', { name: 'Edit company', exact: true });
  await dialog.waitFor();
  assert.equal(await dialog.locator('input[name="name"]').inputValue(), unused);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await assertFocusReturned(page, unused);

  await chooseAction(page, unused, 'View');
  await page.getByRole('dialog', { name: unused, exact: true }).getByRole('button', { name: 'Edit company', exact: true }).click();
  await page.getByRole('dialog', { name: 'Edit company', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
  await assertFocusReturned(page, unused);

  const unusedRow = page.locator('.rv-table tbody tr').filter({ has: page.getByText(unused, { exact: true }) });
  await unusedRow.focus(); await page.keyboard.press('Enter');
  await page.getByRole('dialog', { name: unused, exact: true }).getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.tagName === 'TR');

  await chooseAction(page, unused, 'Delete');
  dialog = page.getByRole('dialog', { name: 'Delete company', exact: true });
  await dialog.waitFor();
  assert.match(await dialog.textContent(), /Unused QA Co/);
  assert.equal(await dialog.getByRole('button', { name: 'Delete company', exact: true }).isEnabled(), true);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await assertFocusReturned(page, unused);
  assert.equal(await page.evaluate(() => window.__companyActionsQA.requests.length), 0);

  for (const [name, reason] of [['Balance QA Co', /balance/i], ['Draft QA Co', /statement|import|source/i], ['Ledger QA Co', /delivery|payment|history/i]]) {
    await chooseAction(page, name, 'Delete');
    dialog = page.getByRole('dialog', { name: 'Delete company', exact: true });
    await dialog.waitFor();
    assert.equal(await dialog.getByRole('button', { name: 'Delete company', exact: true }).isDisabled(), true);
    assert.match(await dialog.textContent(), reason);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await assertFocusReturned(page, name);
  }
  assert.equal(await page.evaluate(() => window.__companyActionsQA.requests.length), 0);

  const before = await page.evaluate(() => window.__companyActionsQA.snapshot());
  await chooseAction(page, unused, 'Delete');
  dialog = page.getByRole('dialog', { name: 'Delete company', exact: true });
  await dialog.getByRole('button', { name: 'Delete company', exact: true }).click();
  await page.waitForFunction(() => window.__companyActionsQA.pendingCount === 1);
  assert.equal(await dialog.isVisible(), true);
  await dialog.getByText('Deleting company…', { exact: true }).waitFor();
  assert.equal(await page.locator('.toast').filter({ hasText: /deleted/i }).count(), 0);
  assert.equal(await page.evaluate(() => window.__companyActionsQA.snapshot().companies.some(company => company.id === 'CO-UNUSED')), true, 'The mocked persisted state changes only after acknowledgment.');
  await page.evaluate(() => window.__companyActionsQA.releaseSave());
  await dialog.waitFor({ state: 'hidden' });
  await page.locator('.toast').filter({ hasText: 'Unused QA Co deleted' }).waitFor();
  await page.waitForFunction(() => document.activeElement === document.querySelector('.rv-section-heading h3'));
  assert.equal(await actionTrigger(page, unused).count(), 0);
  const after = await page.evaluate(() => window.__companyActionsQA.snapshot());
  assert.equal(after.companies.length, 3);
  assert.deepEqual(after.shipments, before.shipments); assert.deepEqual(after.payments, before.payments); assert.deepEqual(after.imports, before.imports);
  assert.equal(after.audit[0].action, 'Company deleted');
  assert.match(after.audit[0].detail, /Unused QA Co/);
  await page.screenshot({ path: 'outputs/company-actions-deleted-desktop.png', animations: 'disabled' });
  assert.deepEqual(errors, []);
  await context.close();

  const retryContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), retryPage = await retryContext.newPage(), retryErrors = [];
  failurePage = retryPage; retryPage.setDefaultTimeout(8000);
  retryPage.on('pageerror', error => retryErrors.push(error.message));
  await openCompanies(retryPage);
  await chooseAction(retryPage, unused, 'Delete');
  const retryDialog = retryPage.getByRole('dialog', { name: 'Delete company', exact: true });
  await retryDialog.getByRole('button', { name: 'Delete company', exact: true }).click();
  await retryPage.waitForFunction(() => window.__companyActionsQA.pendingCount === 1);
  await retryPage.evaluate(() => window.__companyActionsQA.releaseSave(503));
  await retryDialog.getByRole('button', { name: 'Retry save', exact: true }).waitFor();
  assert.equal(await retryDialog.isVisible(), true);
  assert.match(await retryDialog.textContent(), /not been saved/i);
  assert.equal(await retryPage.locator('.toast').filter({ hasText: /deleted/i }).count(), 0);
  assert.equal(await actionTrigger(retryPage, unused).count(), 1);
  await retryDialog.getByRole('button', { name: 'Retry save', exact: true }).click();
  await retryPage.waitForFunction(() => window.__companyActionsQA.pendingCount === 1 && window.__companyActionsQA.requests.length === 2);
  await retryPage.evaluate(() => window.__companyActionsQA.releaseSave());
  await retryDialog.waitFor({ state: 'hidden' });
  await retryPage.locator('.toast').filter({ hasText: 'Unused QA Co deleted' }).waitFor();
  await retryPage.waitForFunction(() => document.activeElement === document.querySelector('.rv-section-heading h3'));
  assert.equal(await actionTrigger(retryPage, unused).count(), 0);
  assert.deepEqual(retryErrors, []);
  await retryContext.close();

  const mobileContext = await browser.newContext({ viewport: { width: 320, height: 844 }, isMobile: true, hasTouch: true });
  await mobileContext.addInitScript(() => localStorage.setItem('hisab-theme', 'dark'));
  const mobile = await mobileContext.newPage(), mobileErrors = [];
  failurePage = mobile; mobile.setDefaultTimeout(8000);
  mobile.on('pageerror', error => mobileErrors.push(error.message));
  await openCompanies(mobile, true);
  await actionTrigger(mobile, unused).click();
  await mobile.getByRole('menuitem', { name: 'Delete', exact: true }).waitFor();
  const bounds = await mobile.locator('.hf-record-actions-menu').boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 320 && bounds.y + bounds.height <= 844);
  assert.equal(await mobile.getByRole('dialog').count(), 0);
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await mobile.screenshot({ path: 'outputs/company-actions-menu-mobile-dark.png', animations: 'disabled' });
  await mobile.keyboard.press('Escape'); await assertFocusReturned(mobile, unused);
  assert.deepEqual(mobileErrors, []);
  await mobileContext.close();
  console.log('PASS company row actions: accessible menus, focus return, View/Edit, delete cancellation/restrictions, acknowledged deletion, failed-save retry, preserved history, and 320px dark popup bounds.');
} catch (error) {
  await failurePage?.screenshot({ path: 'outputs/company-actions-failure.png', animations: 'disabled' }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
