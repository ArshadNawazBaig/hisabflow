import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium, webkit, expect } from '@playwright/test';
import { browserLaunchOptions } from './browser-support.mjs';
import { saveSchema } from '../lib/workspace-validation.ts';
import { add, subtract, multiply, affectsCash, confirmedMargin, validatePostedChanges, validateWorkspaceRecords } from '../lib/accounting.ts';
import { shipmentAdvanceSummary } from '../lib/company-account.ts';
import { today } from '../lib/types.ts';

// Full application UI and server accounting rules, with disposable loopback data.
// This never signs in or sends requests to a customer workspace.
const root = process.cwd(), useWebkit = process.env.HISABFLOW_TEST_BROWSER === 'webkit';
const output = path.join(root, useWebkit ? 'outputs/purchase-costs-webkit-qa' : 'outputs/purchase-costs-qa');
await mkdir(output, { recursive: true });
await build({ entryPoints: [path.join(root, 'tests/fixtures/workspace-harness.tsx')], outfile: path.join(output, 'bundle.js'), bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', tsconfig: path.join(root, 'tsconfig.json'), external: ['/fonts/*'], logLevel: 'warning' });

const actor = 'Purchase costs QA owner', owner = 'isolated-purchase-costs-qa';
const company = (id, role) => ({ id, name: `QA ${id}`, role, aliases: [], balance: '0.00', status: 'Active' });
const shipment = changes => ({ id: 'sale-current', direction: 'Dispatch', companyId: 'customer', deliveryParty: 'QA customer warehouse', date: today(), vehicle: 'QA-SALE-1', product: 'QA copper', grade: 'A', weight: '4.000', unit: 't', rate: '250.00', amount: '1000.00', status: 'Delivered', settlement: 'Unsettled', ...changes });
const advance = () => ({ id: 'advance-not-a-purchase', direction: 'Received', date: today(), companyId: 'customer', actor: 'QA actual payer', amount: '1000.00', account: 'Business current', bankLabel: '', reference: 'QA-CUSTOMER-ADVANCE', treatment: 'Advance', status: 'Allocated', balanceApplied: false });
const workspace = () => ({ business: 'Purchase costs QA', currency: 'PKR', openingCash: '0.00', companies: [company('customer', 'Customer')], shipments: [shipment({})], payments: [advance()], imports: [], audit: [] });
function balances(data) {
  data.companies = data.companies.map(item => ({ ...item, balance: data.shipments.filter(row => row.companyId === item.id).reduce((balance, row) => row.direction === 'Dispatch' ? add(balance, row.amount) : subtract(balance, row.amount), '0.00') }));
  return data;
}
function sourceFixture(includePartial = true) {
  const data = workspace();
  data.companies.push(company('supplier', 'Supplier'));
  const receipt = changes => shipment({ direction: 'Receipt', companyId: 'supplier', vehicle: 'QA-PURCHASE', ...changes });
  data.shipments = [
    shipment({ weight: '2.000', amount: '500.00' }),
    receipt({ id: 'source-product', product: 'QA sand', rate: '100.00', amount: '400.00' }),
    receipt({ id: 'source-unit', unit: 'kg', rate: '100.00', amount: '400.00' }),
    receipt({ id: 'source-grade', grade: 'B', rate: '100.00', amount: '400.00' }),
    receipt({ id: 'source-unknown', weight: '', rate: '', amount: '80.00' }),
    receipt({ id: 'source-used', rate: '100.00', amount: '400.00' }),
    // These are the labels produced by imported statements. They represent
    // exactly the same quantity unit as t; no conversion is being inferred.
    receipt({ id: 'source-partial', product: '  QA   copper  ', grade: ' a ', weight: '6.000', unit: 'Metric tonnes', rate: '110.00', amount: '660.00' }),
    shipment({ id: 'sale-used', vehicle: 'QA-SALE-USED', costAllocations: [{ shipmentId: 'source-used', weight: '4.000', amount: '400.00' }], costAllocationConfirmed: true, costAllocationEvidence: 'QA original reviewed purchase relationship' }),
    shipment({ id: 'sale-partial', vehicle: 'QA-SALE-PARTIAL', costAllocations: [{ shipmentId: 'source-partial', weight: '4.000', amount: '440.00' }], costAllocationConfirmed: true, costAllocationEvidence: 'QA previous allocation leaves two tonnes available' }),
  ];
  if (!includePartial) data.shipments = data.shipments.filter(item => !['source-partial', 'sale-partial'].includes(item.id));
  return balances(data);
}

let stored = balances(workspace()), revision = 0, failNextSave = false, holdNextSave = false, heldSave = null, expectedRejection = false;
const rejectedSaves = [], acceptedActions = [];
const json = (response, status, value) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  try {
    if (url.pathname === '/api/workspace') {
      if (request.method === 'GET') return json(response, 200, { data: stored, revision, user: { id: owner, name: actor, email: 'purchase-costs-qa@example.invalid', provider: 'google' } });
      assert.equal(request.method, 'PUT');
      assert.equal(request.headers['x-workspace-owner'], encodeURIComponent(owner));
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      if (failNextSave) { failNextSave = false; return json(response, 503, { error: 'Temporary QA save failure. Retry your changes.' }); }
      const parsed = saveSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString()));
      if (!parsed.success) {
        if (!expectedRejection) rejectedSaves.push(parsed.error.issues);
        return json(response, 400, { error: 'Invalid fields', fields: parsed.error.issues.map(issue => `${issue.path}: ${issue.message}`) });
      }
      const body = parsed.data;
      if (body.revision !== revision) return json(response, 409, { error: 'Workspace changed.' });
      const failures = [...validateWorkspaceRecords(body.data, stored), ...validatePostedChanges(body.data, stored, actor)];
      if (failures.length) {
        if (!expectedRejection) rejectedSaves.push(failures);
        return json(response, 400, { error: 'Invalid accounting effects', fields: failures });
      }
      if (holdNextSave) {
        holdNextSave = false;
        await new Promise(resolve => { heldSave = resolve; });
        heldSave = null;
      }
      stored = { ...body.data, audit: [{ id: `AUD-${randomUUID()}`, at: new Date().toISOString(), action: body.action, detail: body.detail, actor }, ...stored.audit] };
      acceptedActions.push(body.action);
      return json(response, 200, { data: stored, revision: ++revision });
    }
    if (url.pathname === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>'); return;
    }
    const filename = ['/bundle.js', '/bundle.css'].includes(url.pathname) ? path.join(output, url.pathname.slice(1)) : /^\/(?:fonts\/[\w.-]+|favicon.svg)$/.test(url.pathname) ? path.join(root, 'public', url.pathname.slice(1)) : null;
    if (!filename) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', filename.endsWith('.js') ? 'application/javascript' : filename.endsWith('.css') ? 'text/css' : filename.endsWith('.svg') ? 'image/svg+xml' : 'font/ttf');
    response.end(await readFile(filename));
  } catch (error) { console.error('Purchase costs fixture:', error); json(response, 500, { error: 'QA fixture failed.' }); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await (useWebkit ? webkit : chromium).launch(useWebkit ? { headless: true } : browserLaunchOptions());
let failurePage;
const cash = () => stored.payments.filter(affectsCash).reduce((balance, payment) => payment.direction === 'Received' ? add(balance, payment.amount) : subtract(balance, payment.amount), stored.openingCash);
const responseForSave = page => {
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/workspace' && response.request().method() === 'PUT', { timeout: 20000 });
  // A locator failure can occur before the matching response. Keep that promise
  // handled so the outer failure path can capture the actual UI and screenshot.
  void pending.catch(() => {});
  return pending;
};

try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 320, height: 568 }]) {
    stored = balances(workspace()); revision = 0; rejectedSaves.length = 0; acceptedActions.length = 0;
    assert.deepEqual(validateWorkspaceRecords(stored), []);
    const context = await browser.newContext({ viewport, timezoneId: 'Asia/Karachi', hasTouch: viewport.width === 320, isMobile: viewport.width === 320 });
    if (viewport.width === 320) await context.addInitScript(() => localStorage.setItem('hisab-theme', 'dark'));
    const page = await context.newPage(), errors = []; failurePage = page;
    page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
    const save = async button => {
      const pending = responseForSave(page); await button.click(); const response = await pending;
      assert.equal(response.status(), 200, await response.text());
      await page.waitForFunction(() => !document.querySelector('.save-status.saving'));
    };
    const load = async data => {
      if (data) { stored = data; revision = 0; acceptedActions.length = 0; }
      await page.goto(origin + '/?scenario=' + randomUUID() + '#Deliveries', { waitUntil: 'networkidle' });
      await page.locator('.hf-workspace-loading').waitFor({ state: 'hidden' });
    };
    const openSale = async (id = 'sale-current') => {
      await page.getByPlaceholder('Search vehicle, company, or shipment...').fill(id);
      if (viewport.width === 320) await page.locator('[aria-label="Delivery cards"] > article').filter({ hasText: id }).getByRole('button', { name: 'View details', exact: true }).click();
      else await page.locator('.rv-table tbody tr').filter({ hasText: id }).first().click();
      const detail = page.getByRole('dialog', { name: id, exact: true }); await detail.waitFor(); return detail;
    };
    const openCosts = async id => {
      const detail = await openSale(id);
      await detail.getByRole('button', { name: /^(?:Allocate|Review) purchase costs$/ }).click();
      const costs = page.getByRole('dialog', { name: 'Allocate purchase costs', exact: true }); await costs.waitFor(); return costs;
    };
    const reviewCheckbox = modal => modal.getByRole('checkbox', { name: 'I have reviewed the actual purchase/sale relationships and confirmed the accounting directions.', exact: true });
    const evidenceInput = modal => modal.getByRole('textbox', { name: 'Relationship evidence / review notes', exact: true });
    async function checkFooterAction(modal, name) {
      const action = modal.locator('.hf-modal-footer').getByRole('button', { name, exact: true });
      await expect(action).toBeEnabled();
      const visible = await action.evaluate(node => {
        const rect = node.getBoundingClientRect(), hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return rect.top >= 0 && rect.left >= 0 && rect.bottom <= innerHeight && rect.right <= innerWidth && !!hit && node.contains(hit);
      });
      assert.equal(visible, true, `${name} is immediately reachable in the fixed footer.`);
    }
    async function checkSourceFocus(modal) {
      const control = modal.getByRole('combobox', { name: 'Purchase source 1', exact: true });
      await expect(control).toBeFocused();
      const visible = await control.evaluate(node => {
        const rect = node.getBoundingClientRect(), body = node.closest('.hf-modal-body').getBoundingClientRect();
        return rect.top >= body.top && rect.bottom <= body.bottom && rect.left >= 0 && rect.right <= innerWidth;
      });
      assert.equal(visible, true, 'Selecting a purchase receipt scrolls and focuses its source control inside the visible body.');
    }
    async function selectSource(modal, id, quantity) {
      await modal.getByRole('button', { name: 'Select purchase receipt', exact: true }).click();
      await checkSourceFocus(modal);
      await modal.getByRole('combobox', { name: 'Purchase source 1', exact: true }).click();
      const option = page.getByRole('option').filter({ hasText: id });
      await option.click();
      await modal.getByRole('spinbutton', { name: 'Allocated quantity for purchase source 1', exact: true }).fill(quantity);
    }
    async function checkLayout(modal, name) {
      await modal.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => {}))));
      const before = await modal.evaluate(node => {
        const header = node.querySelector('.hf-modal-header').getBoundingClientRect(), footer = node.querySelector('.hf-modal-footer').getBoundingClientRect();
        return { header: header.top, footer: footer.top, footerBottom: footer.bottom, width: node.scrollWidth, clientWidth: node.clientWidth };
      });
      await modal.locator('.hf-modal-body').evaluate(node => { node.scrollTop = node.scrollHeight; });
      const after = await modal.evaluate(node => ({ header: node.querySelector('.hf-modal-header').getBoundingClientRect().top, footer: node.querySelector('.hf-modal-footer').getBoundingClientRect().top }));
      assert.ok(Math.abs(before.header - after.header) < 1, `${name}: only the body scrolls, with the header fixed.`);
      assert.ok(Math.abs(before.footer - after.footer) < 1, `${name}: footer actions stay fixed.`);
      assert.ok(before.footerBottom <= viewport.height + 1, `${name}: footer is reachable.`);
      assert.ok(before.width <= before.clientWidth + 1, `${name}: the dialog has no horizontal overflow.`);
      await modal.locator('.hf-modal-body').evaluate(node => { node.scrollTop = 0; });
    }

    await load();
    let costs = await openCosts();
    await expect(costs.getByRole('heading', { name: 'No purchases recorded', exact: true })).toBeVisible();
    await expect(costs.getByRole('button', { name: 'Record purchase receipt', exact: true })).toBeEnabled();
    await expect(costs.getByRole('button', { name: 'Confirm purchase costs', exact: true })).toHaveCount(0);
    await expect(costs.getByRole('button', { name: 'Save allocation draft', exact: true })).toHaveCount(0);
    await checkFooterAction(costs, 'Record purchase receipt');
    assert.equal(stored.payments.length, 1);
    assert.equal(stored.shipments.filter(item => item.direction === 'Receipt').length, 0, 'A customer advance is not a supplier goods receipt.');
    assert.deepEqual(confirmedMargin(stored), { amount: '0.00', unresolved: 1 });
    const evidence = 'QA supplier invoice and warehouse receipt reviewed against this sale.';
    await evidenceInput(costs).fill(evidence);
    await checkLayout(costs, 'Empty purchase costing');
    await page.screenshot({ path: path.join(output, `empty-costs-${viewport.width}.png`), animations: 'disabled' });

    await costs.getByRole('button', { name: 'Record purchase receipt', exact: true }).click();
    let receipt = page.getByRole('dialog', { name: 'Record a delivery', exact: true }); await receipt.waitFor();
    await expect(receipt.getByRole('combobox', { name: 'Direction *', exact: true })).toContainText('Receipt');
    assert.equal(await receipt.locator('input[name="product"]').inputValue(), 'QA copper');
    assert.equal(await receipt.locator('input[name="grade"]').inputValue(), 'A');
    await expect(receipt.getByRole('combobox', { name: 'Unit', exact: true })).toContainText('Metric tonnes');
    assert.equal(await receipt.locator('input[name="weight"]').inputValue(), '', 'A sale quantity must not fabricate a purchase quantity.');
    assert.equal(await receipt.locator('input[name="rate"]').inputValue(), '', 'A sale rate must not fabricate a purchase rate.');
    await expect(receipt.getByRole('button', { name: 'Add supplier', exact: true })).toBeVisible();
    await receipt.getByRole('button', { name: 'Close dialog', exact: true }).click();
    costs = page.getByRole('dialog', { name: 'Allocate purchase costs', exact: true }); await costs.waitFor();
    assert.equal(await evidenceInput(costs).inputValue(), evidence, 'Canceling purchase entry preserves allocation notes.');
    if (await reviewCheckbox(costs).count()) await expect(reviewCheckbox(costs)).not.toBeChecked();

    await costs.getByRole('button', { name: 'Record purchase receipt', exact: true }).click();
    receipt = page.getByRole('dialog', { name: 'Record a delivery', exact: true });
    await receipt.getByRole('button', { name: 'Add supplier', exact: true }).click();
    const supplier = page.getByRole('dialog', { name: 'Add supplier', exact: true });
    await supplier.locator('input[name="name"]').fill('QA new actual supplier');
    await save(supplier.getByRole('button', { name: 'Add supplier', exact: true }));
    await supplier.waitFor({ state: 'hidden' });
    await expect(receipt.getByRole('combobox', { name: 'Accounting counterparty *', exact: true })).toContainText('QA new actual supplier');
    await receipt.locator('input[name="weight"]').fill('4.000');
    await receipt.locator('input[name="rate"]').fill('100.00');
    await receipt.locator('input[name="relatedDocument"]').fill('QA-SUPPLIER-INVOICE');
    await receipt.locator('input[name="sourceRef"]').fill('QA original supplier receipt');
    assert.equal(await receipt.locator('input[name="amount"]').inputValue(), '400.00');
    await checkLayout(receipt, 'Record purchase receipt');
    const invalidFields = await receipt.locator('form').evaluate(form => Array.from(form.elements).filter(element => element.willValidate && !element.validity.valid).map(element => ({ name: element.name, message: element.validationMessage })));
    assert.deepEqual(invalidFields, [], 'Ordinary reviewed purchase quantities and rates pass native form validation.');
    failNextSave = true;
    let pending = responseForSave(page); await receipt.getByRole('button', { name: 'Save delivery', exact: true }).click();
    assert.equal((await pending).status(), 503);
    assert.equal(stored.shipments.length, 1, 'A failed receipt save does not create a durable purchase.');
    await expect(receipt.getByRole('button', { name: 'Retry save', exact: true })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Allocate purchase costs', exact: true })).toHaveCount(0);
    holdNextSave = true; pending = responseForSave(page);
    await receipt.getByRole('button', { name: 'Retry save', exact: true }).click();
    await expect.poll(() => heldSave !== null).toBe(true);
    await expect(receipt).toBeVisible();
    const pendingClose = receipt.getByRole('button', { name: 'Close dialog', exact: true });
    if (await pendingClose.isEnabled()) await pendingClose.click();
    await expect(receipt).toBeVisible();
    assert.equal(stored.shipments.length, 1, 'Receipt entry waits for the server acknowledgment.');
    heldSave(); assert.equal((await pending).status(), 200);
    await receipt.waitFor({ state: 'hidden' });
    costs = page.getByRole('dialog', { name: 'Allocate purchase costs', exact: true }); await costs.waitFor();
    assert.equal(await evidenceInput(costs).inputValue(), evidence, 'Successful receipt entry resumes the original allocation notes.');
    if (await reviewCheckbox(costs).count()) await expect(reviewCheckbox(costs)).not.toBeChecked();
    const source = stored.shipments.find(item => item.direction === 'Receipt');
    assert.equal(stored.shipments.length, 2, 'Retry saves the same receipt exactly once.');
    assert.equal(stored.shipments.filter(item => item.direction === 'Receipt').length, 1);
    assert.equal(source.product, 'QA copper'); assert.equal(source.unit, 't'); assert.equal(source.grade, 'A');
    assert.equal(source.rate, '100.00'); assert.equal(source.amount, '400.00'); assert.equal(source.relatedDocument, 'QA-SUPPLIER-INVOICE');
    assert.equal(stored.payments.length, 1); assert.equal(cash(), '1000.00');
    assert.deepEqual(confirmedMargin(stored), { amount: '0.00', unresolved: 1 }, 'Recording a purchase does not infer an approved sale relationship.');
    await selectSource(costs, source.id, '4.000');
    await expect(costs.getByRole('button', { name: 'Confirm purchase costs', exact: true })).toBeDisabled();
    await reviewCheckbox(costs).check();
    await expect(reviewCheckbox(costs)).toBeChecked();
    const confirmCosts = costs.getByRole('button', { name: 'Confirm purchase costs', exact: true });
    await expect(confirmCosts).toBeEnabled();
    holdNextSave = true; pending = responseForSave(page);
    await confirmCosts.click();
    await expect.poll(() => heldSave !== null).toBe(true);
    await expect(costs).toBeVisible();
    assert.deepEqual(confirmedMargin(stored), { amount: '0.00', unresolved: 1 });
    heldSave(); assert.equal((await pending).status(), 200); await costs.waitFor({ state: 'hidden' });
    const savedSale = stored.shipments.find(item => item.id === 'sale-current');
    assert.deepEqual(savedSale.costAllocations, [{ shipmentId: source.id, weight: '4.000', amount: '400.00' }]);
    assert.equal(savedSale.costAllocationConfirmed, true); assert.equal(savedSale.costAllocationEvidence, evidence);
    assert.deepEqual(confirmedMargin(stored), { amount: '600.00', unresolved: 0 });
    assert.equal(shipmentAdvanceSummary(stored, 'sale-current').applied, '0.00', 'Purchase-cost review cannot apply customer funds.');
    assert.equal(stored.payments.length, 1); assert.equal(cash(), '1000.00');
    await page.reload({ waitUntil: 'networkidle' });
    costs = await openCosts();
    assert.equal(await evidenceInput(costs).inputValue(), evidence);
    assert.equal(await costs.getByRole('spinbutton', { name: 'Allocated quantity for purchase source 1', exact: true }).inputValue(), '4.000');
    await page.screenshot({ path: path.join(output, `confirmed-costs-${viewport.width}.png`), animations: 'disabled' });
    await costs.getByRole('button', { name: 'Close dialog', exact: true }).click();

    const unavailableData = sourceFixture(false); assert.deepEqual(validateWorkspaceRecords(unavailableData), []);
    await load(unavailableData); costs = await openCosts();
    await expect(costs.getByRole('heading', { name: 'No compatible purchase receipts', exact: true })).toBeVisible();
    await expect(costs.getByRole('button', { name: 'Record purchase receipt', exact: true })).toBeEnabled();
    await checkFooterAction(costs, 'Record purchase receipt');
    const diagnostics = costs.getByRole('region', { name: 'Unavailable purchase receipts', exact: true });
    for (const reason of ['Different product', 'Different unit', 'Different grade', 'Missing or invalid purchase quantity', 'Missing or invalid purchase rate', 'Quantity already allocated']) await expect(diagnostics.getByText(reason, { exact: true })).toBeVisible();
    await checkLayout(costs, 'Unavailable purchase receipts');
    await page.screenshot({ path: path.join(output, `unavailable-costs-${viewport.width}.png`), animations: 'disabled' });
    await costs.getByRole('button', { name: 'Close dialog', exact: true }).click();
    const sourcesData = sourceFixture(); assert.deepEqual(validateWorkspaceRecords(sourcesData), []);
    await load(sourcesData); costs = await openCosts();
    await checkFooterAction(costs, 'Select purchase receipt');
    await costs.getByRole('button', { name: 'Select purchase receipt', exact: true }).click();
    await checkSourceFocus(costs);
    await costs.getByRole('combobox', { name: 'Purchase source 1', exact: true }).click();
    await expect(page.getByRole('option').filter({ hasText: 'source-used' })).toHaveCount(0);
    await expect(page.getByRole('option').filter({ hasText: 'advance-not-a-purchase' })).toHaveCount(0);
    await page.getByRole('option').filter({ hasText: 'source-partial' }).click();
    await expect(costs.getByText(/Available:.*2\.000/)).toBeVisible();
    let quantity = costs.getByRole('spinbutton', { name: 'Allocated quantity for purchase source 1', exact: true });
    await expect(quantity).toHaveAttribute('max', '2.000000');
    await quantity.fill('1.000'); await evidenceInput(costs).fill('QA partly selected source preserved.'); await reviewCheckbox(costs).check();
    await costs.getByRole('button', { name: 'Record purchase receipt', exact: true }).click();
    receipt = page.getByRole('dialog', { name: 'Record a delivery', exact: true }); await receipt.waitFor();
    await receipt.getByRole('button', { name: 'Close dialog', exact: true }).click();
    costs = page.getByRole('dialog', { name: 'Allocate purchase costs', exact: true }); await costs.waitFor();
    quantity = costs.getByRole('spinbutton', { name: 'Allocated quantity for purchase source 1', exact: true });
    assert.equal(await quantity.inputValue(), '1.000');
    await expect(costs.getByRole('combobox', { name: 'Purchase source 1', exact: true })).toContainText('source-partial');
    assert.equal(await evidenceInput(costs).inputValue(), 'QA partly selected source preserved.');
    await quantity.fill('2.001'); await evidenceInput(costs).fill('QA capacity check'); await reviewCheckbox(costs).check();
    const beforeOveruse = revision;
    await expect(costs.getByRole('button', { name: 'Save allocation draft', exact: true })).toBeDisabled();
    await expect(costs.getByText(/has only 2\.000 .*available after other allocations/)).toBeVisible();
    assert.equal(revision, beforeOveruse, 'An overused source is rejected before a save request.');
    await quantity.fill('1.000');
    await expect(costs.getByRole('button', { name: 'Confirm purchase costs', exact: true })).toBeDisabled();
    await save(costs.getByRole('button', { name: 'Save allocation draft', exact: true })); await costs.waitFor({ state: 'hidden' });
    assert.equal(stored.shipments.find(item => item.id === 'sale-current').costAllocationConfirmed, false);
    assert.deepEqual(confirmedMargin(stored), { amount: '1160.00', unresolved: 1 }, 'A partially covered sale stays unresolved.');
    costs = await openCosts();
    await costs.getByRole('spinbutton', { name: 'Allocated quantity for purchase source 1', exact: true }).fill('2.000');
    await evidenceInput(costs).fill('QA remaining imported receipt quantity reviewed.'); await reviewCheckbox(costs).check();
    await save(costs.getByRole('button', { name: 'Confirm purchase costs', exact: true })); await costs.waitFor({ state: 'hidden' });
    assert.deepEqual(confirmedMargin(stored), { amount: '1440.00', unresolved: 0 }, 'Unit aliases and label spacing preserve the actual remaining purchase cost.');
    const durable = structuredClone(stored);
    const invalids = [
      next => { const sale = next.shipments.find(item => item.id === 'sale-current'); sale.costAllocations[0].weight = '2.001'; sale.costAllocations[0].amount = multiply('2.001', '110.00'); },
      next => { const sale = next.shipments.find(item => item.id === 'sale-current'); sale.costAllocations[0] = { shipmentId: 'source-used', weight: '2.000', amount: '200.00' }; },
      next => { const sale = next.shipments.find(item => item.id === 'sale-current'); sale.costAllocations[0].shipmentId = 'advance-not-a-purchase'; },
      next => { next.shipments.find(item => item.id === 'sale-current').costAllocations[0].amount = '1.00'; },
    ];
    for (const tamper of invalids) {
      const incoming = structuredClone(durable); tamper(incoming); expectedRejection = true;
      try {
        const response = await context.request.put(origin + '/api/workspace', { headers: { 'X-Workspace-Owner': encodeURIComponent(owner) }, data: { data: incoming, revision, action: 'QA rejected cost tamper', detail: 'Synthetic negative validation check' } });
        assert.equal(response.status(), 400, await response.text()); assert.deepEqual(stored, durable, 'Rejected allocations leave durable records unchanged.');
      } finally { expectedRejection = false; }
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(rejectedSaves, []); assert.deepEqual(errors, []); await context.close();
  }
  console.log('PASS purchase costs: sale-only recovery, inline supplier, deliberate receipt quantity/rate, preserved allocation draft, acknowledged receipt and confirmation saves, retry without duplication, actionable incompatibility reasons, remaining source capacity, imported unit aliases, unresolved partial coverage, and server rejection of fabricated or overused costs; desktop and mobile.');
} catch (error) {
  await failurePage?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  console.error('Purchase costs controls:', await failurePage?.getByRole('dialog').evaluateAll(dialogs => dialogs.map(dialog => ({
    name: dialog.getAttribute('aria-label'), footer: dialog.querySelector('.hf-modal-footer')?.textContent,
    active: document.activeElement?.getAttribute('aria-label') || document.activeElement?.tagName,
    fields: Array.from(dialog.querySelectorAll('input,textarea,[role="combobox"]')).map(node => ({ label: node.getAttribute('aria-label') || node.getAttribute('name'), value: node.value ?? node.textContent, checked: node.checked, disabled: node.disabled })),
  }))).catch(() => []));
  console.error('Purchase costs state:', (await failurePage?.locator('body').innerText())?.slice(-7000)); throw error;
} finally {
  heldSave?.(); await browser.close(); await new Promise(resolve => server.close(resolve));
}
