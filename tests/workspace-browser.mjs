import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium, webkit } from '@playwright/test';
import { browserLaunchOptions } from './browser-support.mjs';
import { saveSchema } from '../lib/workspace-validation.ts';
import { validatePostedChanges, validateWorkspaceRecords, confirmedMargin } from '../lib/accounting.ts';

function syntheticPdf({ company, goods, paid, closing, paymentDescription, vehicle }) {
  const xs = [30, 150, 430, 620, 720, 820, 920, 1050, 1170, 1330];
  const rows = [
    ['DATE', 'DESCRIPTIONS', 'PARTY', 'VEH. #', 'WEIGHT', 'RATE', 'TOTAL', 'PAID', 'PAYABLE', 'TID #'],
    ['02-11-2026', 'QA PDF material delivery', 'QA PDF destination', vehicle, '2.500', String(Number(goods) / 2.5), goods, '', goods, 'QA-PDF-GOODS'],
    ['03-11-2026', paymentDescription, '', '', '', '', '', paid, closing, '0000123/QA'],
    ['Closing balance', '', '', '', '', '', '', '', closing, ''],
  ];
  const text = (value, x, y, size = 9) => `BT /F1 ${size} Tf 1 0 0 1 ${x} ${y} Tm (${value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')}) Tj ET`;
  const stream = [text(`LEDGER OF ${company}`, 30, 550, 12), ...rows.flatMap((cells, row) => cells.flatMap((value, column) => value ? [text(value, xs[column], 500 - row * 30)] : []))].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1500 600] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

// A loopback-only in-memory backend. Exercise the full UI with real accounting
// validation, without signing in, touching customer records, or changing auth.
const mobile=process.env.HISABFLOW_TEST_MOBILE==='1',useWebkit=process.env.HISABFLOW_TEST_BROWSER==='webkit';
const root = process.cwd(), output = path.join(root, useWebkit?'outputs/workspace-webkit-qa':mobile?'outputs/workspace-mobile-qa':'outputs/workspace-qa');
await mkdir(output, { recursive: true });
await build({ entryPoints: [path.join(root, 'tests/fixtures/workspace-harness.tsx')], outfile: path.join(output, 'bundle.js'), bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', tsconfig: path.join(root, 'tsconfig.json'), external: ['/fonts/*'], logLevel: 'warning' });
let stored = null, revision = 0;
const files = new Map(), rejectedSaves = [];
const actor = 'QA workspace owner';
const json = (response, status, value) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/api/workspace') {
      if (request.method === 'GET') return json(response, 200, { data: stored, revision, user: { id: 'isolated-qa', name: actor, email: 'qa@example.invalid', provider: 'google' } });
      assert.equal(request.headers['x-workspace-owner'], encodeURIComponent('isolated-qa'), 'Every save stays pinned to the loaded account.');
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const parsed = saveSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString()));
      if (!parsed.success) { rejectedSaves.push(parsed.error.issues); return json(response, 400, { error: 'Invalid fields', fields: parsed.error.issues.map(issue => `${issue.path}: ${issue.message}`) }); }
      const body = parsed.data;
      if (body.revision !== revision) return json(response, 409, { error: 'Workspace changed.' });
      const failures = [...validateWorkspaceRecords(body.data, stored), ...validatePostedChanges(body.data, stored, actor)];
      if (failures.length) { rejectedSaves.push(failures); return json(response, 400, { error: 'Invalid accounting effects', fields: failures }); }
      for (const batch of body.data.imports.filter(item => item.status === 'Posted' && !stored?.imports.some(previous => previous.id === item.id && previous.status === 'Posted'))) {
        assert.equal(files.get(batch.fileKey)?.hash, batch.hash, 'Posting requires the retained original.');
      }
      stored = { ...body.data, audit: [{ id: `AUD-${randomUUID()}`, at: new Date().toISOString(), action: body.action, detail: body.detail, actor }, ...(stored?.audit || [])] };
      return json(response, 200, { data: stored, revision: ++revision });
    }
    if (url.pathname === '/api/files') {
      if (request.method === 'POST') {
        assert.equal(request.headers['x-workspace-owner'], encodeURIComponent('isolated-qa'), 'Uploads stay pinned to the loaded account.');
        const incoming = new Request(url, { method: 'POST', headers: request.headers, body: Readable.toWeb(request), duplex: 'half' });
        const file = (await incoming.formData()).get('file');
        const content = Buffer.from(await file.arrayBuffer());
        const hash = createHash('sha256').update(content).digest('hex');
        const key = `owners/isolated-qa/${hash}/${encodeURIComponent(file.name)}`;
        files.set(key, { hash, content, type: file.type });
        return json(response, 200, { key, hash });
      }
      const file = files.get(url.searchParams.get('key'));
      if (!file) return json(response, 404, { error: 'File not found.' });
      response.writeHead(200, { 'Content-Type': file.type }); response.end(file.content); return;
    }
    if (url.pathname === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>'); return;
    }
    const filename = ['/bundle.js', '/bundle.css'].includes(url.pathname) ? path.join(output, url.pathname.slice(1)) : /^\/(?:fonts\/[\w.-]+|favicon.svg|pdf.worker.min.mjs)$/.test(url.pathname) ? path.join(root, 'public', url.pathname.slice(1)) : null;
    if (!filename) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', /\.m?js$/.test(filename) ? 'application/javascript' : filename.endsWith('.css') ? 'text/css' : filename.endsWith('.svg') ? 'image/svg+xml' : 'font/ttf');
    response.end(await readFile(filename));
  } catch (error) { console.error('Isolated QA server:', error.message); json(response, 500, { error: 'QA request failed.' }); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await (useWebkit?webkit:chromium).launch(useWebkit?{headless:true}:browserLaunchOptions());
const context = await browser.newContext({ viewport: mobile?{width:390,height:844}:{width:1440,height:1000},isMobile:mobile,hasTouch:mobile, timezoneId: 'Asia/Karachi', acceptDownloads: true });
const page = await context.newPage(), errors = [];
page.on('pageerror', error => errors.push(error.message));
page.setDefaultTimeout(10000);
const navigation = () => page.locator('.side-rail nav');
async function navigate(name) { await navigation().getByRole('button', { name, exact: true }).click(); }
async function choose(scope, label, option) {
  await scope.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}
async function save(button) {
  const response = page.waitForResponse(item => new URL(item.url()).pathname === '/api/workspace' && item.request().method() === 'PUT');
  await button.click(); const result = await response;
  assert.equal(result.status(), 200, await result.text());
  await page.waitForFunction(() => !document.querySelector('.save-status.saving'));
}
async function company(name, role) {
  await navigate('Companies'); await page.getByRole('button', { name: 'Add company', exact: true }).click();
  const modal = page.getByRole('dialog');
  await modal.locator('input[name="name"]').fill(name);
  await choose(modal, 'Relationship *', role);
  await save(modal.getByRole('button', { name: 'Save company', exact: true }));
  return stored.companies.find(item => item.name === name).id;
}
async function delivery(direction, companyName, rate) {
  await navigate('Deliveries'); await page.getByRole('button', { name: 'Add delivery', exact: true }).click();
  const modal = page.getByRole('dialog');
  await choose(modal, 'Direction *', direction);
  await choose(modal, 'Accounting counterparty *', `${companyName} · ${direction === 'Receipt' ? 'Supplier' : 'Customer'}`);
  await modal.locator('input[name="deliveryParty"]').fill('QA destination');
  await modal.locator('input[name="vehicle"]').fill('QA-401');
  await modal.locator('input[name="product"]').fill('QA material');
  await modal.locator('input[name="weight"]').fill('1.255');
  await modal.locator('input[name="rate"]').fill(rate);
  assert.equal(await modal.locator('input[name="amount"]').inputValue(), direction === 'Receipt' ? '100.40' : '125.63');
  assert.equal(await modal.locator('input[name="deliveryParty"]').inputValue(),'QA destination','Delivery party survives changes to the rest of the form.');
  await save(modal.getByRole('button', { name: 'Save delivery', exact: true }));
  assert.equal(stored.shipments[0].deliveryParty,'QA destination','Saved delivery preserves its reviewed delivery party.');
}
async function payment(direction, companyName, amount, treatment) {
  await navigate('Payments'); await page.getByRole('button', { name: 'Record payment', exact: true }).click();
  const modal = page.getByRole('dialog');
  await choose(modal, 'Money movement *', direction);
  await choose(modal, 'Accounting company', companyName);
  await modal.locator('input[name="actor"]').fill('QA third-party actor');
  await modal.locator('input[name="amount"]').fill(amount);
  await modal.locator('input[name="account"]').fill('Business current');
  await modal.locator('input[name="reference"]').fill('QA-TID/TEXT');
  await choose(modal, 'Reviewed accounting treatment *', treatment);
  if (treatment === 'Supplier-agreed deduction') await modal.locator('input[name="evidence"]').fill('QA supplier approval');
  await save(modal.getByRole('button', { name: 'Save payment', exact: true }));
}
async function download(button) {
  const pending = page.waitForEvent('download'); await button.click(); const file = await pending;
  const stream = await file.createReadStream(), chunks = []; for await (const chunk of stream) chunks.push(chunk);
  return { name: file.suggestedFilename(), text: Buffer.concat(chunks).toString() };
}
try {
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Make room for your business.' }).waitFor();
  await page.locator('input[name="business"]').fill('QA Trading');
  await save(page.getByRole('button', { name: 'Create my workspace', exact: true }));
  assert.equal(stored.business, 'QA Trading');
  assert.deepEqual(stored.companies, []);
  const supplier = await company('QA supplier', 'Supplier');
  const customer = await company('QA customer', 'Customer');
  await delivery('Receipt', 'QA supplier', '80.00');
  await delivery('Dispatch', 'QA customer', '100.10');
  assert.equal(stored.companies.find(item => item.id === supplier).balance, '-100.40');
  assert.equal(stored.companies.find(item => item.id === customer).balance, '125.63');
  await page.getByRole('button', { name: /Review matches/ }).click();
  const relationship = page.getByRole('dialog');
  await relationship.getByRole('checkbox').check();
  await save(relationship.getByRole('button', { name: 'Confirm relationship', exact: true }));
  assert.equal(confirmedMargin(stored).amount, '25.23');
  await relationship.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await payment('Received', 'QA customer', '25.63', 'Customer receipt');
  await payment('Paid', 'QA supplier', '50.00', 'Supplier settlement');
  await payment('Paid', 'QA supplier', '10.00', 'Supplier-agreed deduction');
  assert.equal(stored.companies.find(item => item.id === customer).balance, '100.00');
  assert.equal(stored.companies.find(item => item.id === supplier).balance, '-40.40');
  await navigate('Reports');
  const cash = await download(page.getByRole('button', { name: 'Export report', exact: true }));
  assert.match(cash.text, /25.63/); assert.match(cash.text, /50.00/); assert.doesNotMatch(cash.text, /"10.00"/);
  for (const tab of ['Company balances', 'Truck-wise deliveries', 'Trading margin', 'Audit trail']) {
    await page.getByRole('button', { name: tab, exact: true }).click();
    const exported = await download(page.getByRole('button', { name: 'Export report', exact: true }));
    assert.ok(exported.text.length > 100, `${tab} exports records.`);
  }
  await navigate('Overview');
  await page.getByRole('button', { name: 'Search workspace', exact: true }).click();
  await page.locator('.search-modal input').fill('QA customer');
  await page.locator('.search-results button').filter({ hasText: 'QA customer' }).click();
  await page.getByRole('heading', { name: 'Companies', exact: true }).waitFor();
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(stored.shipments.length, 2); assert.equal(stored.payments.length, 3);
  await navigate('Companies');
  assert.match(await page.locator('tr').filter({ hasText: 'QA customer' }).textContent(), /100.00/);
  await navigate('Imports');
  await page.getByRole('button', { name: 'Import text or CSV', exact: true }).click();
  const transcription = 'DATE,DESCRIPTIONS,PARTY,VEH. #,WEIGHT,RATE,TOTAL,PAID,PAYABLE,TID #\n2026-11-01,"QA imported goods, ""reviewed""\nfirst load","QA destination, East",QA-402,1.000,100.00,100.00,,100.00,QA-IMPORT\nClosing balance,,,,,,,,100.00,';
  await page.locator('.import-paste textarea').fill(transcription);
  await save(page.getByRole('button', { name: 'Extract pasted statement', exact: true }));
  assert.equal(stored.imports.length, 1); assert.equal(stored.imports[0].rows.filter(row => row.kind === 'goods').length, 1);
  const extractedCsv = stored.imports[0].rows.find(row => row.kind === 'goods');
  assert.equal(extractedCsv.description, 'QA imported goods, "reviewed"\nfirst load');
  assert.equal(extractedCsv.party, 'QA destination, East'); assert.equal(extractedCsv.proposedDate, '2026-11-01');
  assert.ok(files.has(stored.imports[0].fileKey));
  await save(page.getByRole('button', { name: 'All statements', exact: true }));
  await page.getByRole('button', { name: 'Continue review', exact: true }).click();
  await page.getByRole('heading', { name: 'Transcribed statement.txt', exact: true }).waitFor();
  await save(page.getByRole('button', { name: 'All statements', exact: true }));
  await page.getByRole('button', { name: 'Import text or CSV', exact: true }).click();
  await page.locator('.import-paste textarea').fill(transcription);
  await page.getByRole('button', { name: 'Extract pasted statement', exact: true }).click();
  await page.getByRole('heading', { name: 'Transcribed statement.txt', exact: true }).waitFor();
  assert.equal(stored.imports.length, 1, 'The same source must reuse its saved import.');
  await page.getByLabel('Source statement issuer', { exact: true }).fill('QA supplier');
  await choose(page, 'Accounting counterparty', 'QA supplier');
  await choose(page, 'Source statement perspective', 'Supplier statement');
  await choose(page, 'Meaning of the PARTY column', 'Delivery recipient or destination');
  await choose(page, 'Goods direction in your books', 'Receipt — purchases from counterparty');
  await choose(page, 'History coverage', 'Partial history');
  await page.getByRole('checkbox', { name: /I have confirmed the currency and quantity unit/ }).check();
  await page.getByLabel('Printed source closing balance', { exact: true }).fill('100.00');
  await save(page.getByRole('button', { name: 'Continue to review', exact: true }));
  await page.locator('.import-row-summary').click();
  await page.getByRole('button', { name: 'Approve reviewed row', exact: true }).click();
  await save(page.getByRole('button', { name: 'Reconcile statement', exact: true }));
  await page.getByText('The closing balance reconciles.', { exact: true }).waitFor();
  await save(page.getByRole('button', { name: 'Preview accounting effects', exact: true }));
  await page.getByRole('checkbox', { name: /I confirm the ledger perspective/ }).check();
  await save(page.getByRole('button', { name: 'Confirm & post import', exact: true }));
  await page.getByRole('heading', { name: 'Statement imported', exact: true }).waitFor();
  assert.equal(stored.imports[0].status, 'Posted'); assert.equal(stored.shipments.length, 3);
  assert.equal(stored.companies.find(item => item.id === supplier).balance, '-140.40');
  await page.getByRole('button', { name: 'Back to statements', exact: true }).click();

  const supplierPdf = { name: 'QA PDF supplier.pdf', mimeType: 'application/pdf', buffer: syntheticPdf({ company: 'QA PDF supplier', goods: '250.00', paid: '100.00', closing: '150.00', paymentDescription: 'F/T to QA PDF supplier UBL account', vehicle: 'QA-PDF-1' }) };
  const customerPdf = { name: 'QA PDF customer.pdf', mimeType: 'application/pdf', buffer: syntheticPdf({ company: 'QA PDF customer', goods: '400.00', paid: '50.00', closing: '350.00', paymentDescription: 'Received from QA PDF customer', vehicle: 'QA-PDF-2' }) };
  const exceptionPdf = { name: 'QA PDF exceptions.pdf', mimeType: 'application/pdf', buffer: syntheticPdf({ company: 'QA PDF exceptions', goods: '250.00', paid: '100.00', closing: '150.00', paymentDescription: 'Freight paid to QA transporter', vehicle: 'QA-PDF-3' }) };
  const selectedPdf = file => page.locator('.pdf-file').filter({ has: page.getByRole('heading', { name: file.name, exact: true }) });
  await page.getByLabel('Choose PDF statements', { exact: true }).setInputFiles([supplierPdf, customerPdf, exceptionPdf, { ...supplierPdf, name: 'Same PDF renamed.pdf' }]);
  await page.waitForFunction(() => document.querySelectorAll('.pdf-preview').length === 3 && !document.querySelector('.pdf-progress'));
  assert.equal(await page.locator('.pdf-file').count(), 4);
  assert.match(await page.locator('.pdf-file').filter({ hasText: 'Same PDF renamed.pdf' }).innerText(), /already in this upload/);
  for (const [file, relationship, perspective] of [[supplierPdf, 'Supplier', 'Supplier statement'], [customerPdf, 'Customer', 'Customer statement'], [exceptionPdf, 'Supplier', 'Supplier statement']]) {
    const article = selectedPdf(file);
    assert.equal(await article.getByRole('textbox').inputValue(), file.name.replace('.pdf', ''));
    await choose(article, `Relationship for ${file.name}`, relationship);
    await choose(article, `Source perspective for ${file.name}`, perspective);
    await article.getByText('Original PDF retained', { exact: false }).waitFor();
    await article.getByText('Preview extracted records (2)', { exact: true }).click();
    assert.equal(await article.locator(mobile?'.pdf-record-cards > article':'.pdf-records-table tbody tr').count(), 2);
    const retained = await context.request.get(new URL(await article.getByRole('link', { name: 'Original PDF', exact: true }).getAttribute('href'), origin).href);
    assert.equal(retained.status(), 200); assert.deepEqual(await retained.body(), file.buffer);
  }
  await selectedPdf(supplierPdf).getByText('Ready to import', { exact: true }).waitFor();
  await selectedPdf(customerPdf).getByText('Ready to import', { exact: true }).waitFor();
  assert.match(await selectedPdf(exceptionPdf).locator('.pdf-file-heading').innerText(), /Needs review/);
  assert.match(await selectedPdf(supplierPdf).locator('.pdf-record-payment').last().innerText(), /Supplier settlement/);
  assert.match(await selectedPdf(customerPdf).locator('.pdf-record-payment').last().innerText(), /Customer receipt/);
  await page.locator('.pdf-confirm-label input').check();
  await save(page.getByRole('button', { name: 'Import statements', exact: true }));
  await page.getByRole('heading', { name: 'Import saved', exact: true }).waitFor();
  assert.match(await page.locator('.pdf-saved').innerText(), /2 statements posted.*1 draft to review.*3 companies added/s);
  assert.equal(stored.imports.length, 4); assert.equal(stored.shipments.length, 5); assert.equal(stored.payments.length, 5);
  assert.equal(stored.companies.length, 5); assert.equal(files.size, 4, 'Same-upload duplicates do not retain another original.');
  for (const [name, status, balance] of [['QA PDF supplier', 'Posted', '-150.00'], ['QA PDF customer', 'Posted', '350.00'], ['QA PDF exceptions', 'Draft', '0.00']]) {
    const batch = stored.imports.find(item => item.name === `${name}.pdf`), company = stored.companies.find(item => item.name === name);
    assert.equal(batch.status, status); assert.equal(company.balance, balance);
    assert.equal(batch.mapping.counterpartyId, company.id); assert.equal(batch.sourcePages, 1);
    assert.equal(files.get(batch.fileKey).hash, batch.hash); assert.deepEqual(batch.sourceMetadata.unreadablePages, []);
    assert.equal(stored.shipments.filter(item => item.sourceRef === batch.id).length, status === 'Posted' ? 1 : 0);
    assert.equal(stored.payments.filter(item => item.sourceRef === batch.id).length, status === 'Posted' ? 1 : 0);
  }
  assert.equal(stored.payments.find(item => item.actor === 'QA PDF customer').reference, '0000123/QA');
  const importedRevision = revision, importedSnapshot = structuredClone(stored);
  await page.getByLabel('Choose PDF statements', { exact: true }).setInputFiles([supplierPdf, customerPdf]);
  await page.waitForFunction(() => document.querySelectorAll('.pdf-duplicate').length === 2 && !document.querySelector('.pdf-progress'));
  assert.match(await selectedPdf(supplierPdf).innerText(), /already imported/);
  assert.match(await selectedPdf(customerPdf).innerText(), /already imported/);
  assert.equal(revision, importedRevision); assert.deepEqual(stored, importedSnapshot);
  assert.equal(files.size, 4, 'Posted-PDF reuploads reuse their retained originals.');
  await selectedPdf(supplierPdf).getByRole('button', { name: 'View existing import', exact: true }).click();
  await page.getByRole('heading', { name: 'Statement imported', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Back to statements', exact: true }).click();

  const protectedRevision = revision, protectedSnapshot = structuredClone(stored);
  await page.locator(mobile?'[aria-label="Statement imports"]:visible > article':'.import-history tbody tr').filter({ hasText: supplierPdf.name }).getByRole('button', { name: `Delete ${supplierPdf.name}`, exact: true }).click();
  const protectedStatement = page.getByRole('dialog', { name: 'Delete statement', exact: true });
  assert.equal(await protectedStatement.getByRole('button', { name: 'Delete statement', exact: true }).isDisabled(), true, 'Posted source evidence cannot be deleted from the row action.');
  assert.match(await protectedStatement.innerText(), /posted statements cannot be deleted/i);
  await protectedStatement.getByRole('button', { name: 'Close', exact: true }).click();
  assert.equal(revision, protectedRevision); assert.deepEqual(stored, protectedSnapshot);

  const beforeFileUpload = structuredClone(stored);
  const sourceCsv = { name: 'QA uploaded transcription.csv', mimeType: 'text/csv', buffer: Buffer.from('DATE,DESCRIPTIONS,PARTY,VEH. #,WEIGHT,RATE,TOTAL,PAID,PAYABLE,TID #\n2026-11-03,"Uploaded, reviewed CSV",QA destination,QA-CSV-FILE,1.000,50.00,50.00,,50.00,CSV-FILE-REF\n"Closing balance",,,,,,,,50.00,') };
  await page.getByRole('button', { name: 'Import text or CSV', exact: true }).click();
  let textImporter = page.getByRole('dialog', { name: 'Import text or CSV', exact: true });
  await textImporter.getByRole('tab', { name: 'Upload file', exact: true }).click();
  await textImporter.getByLabel('CSV or text statement', { exact: true }).setInputFiles(sourceCsv);
  await save(textImporter.getByRole('button', { name: 'Extract selected file', exact: true }));
  await page.getByRole('heading', { name: sourceCsv.name, exact: true }).waitFor();
  assert.equal(await textImporter.count(), 0, 'Successful extraction closes the importer and opens its saved review.');
  const fileBatch = stored.imports.find(item => item.name === sourceCsv.name);
  assert.ok(fileBatch); assert.equal(fileBatch.status, 'Draft');
  assert.equal(fileBatch.rows.find(row => row.kind === 'goods').description, 'Uploaded, reviewed CSV');
  assert.deepEqual(files.get(fileBatch.fileKey).content, sourceCsv.buffer, 'File import retains the exact supplied CSV.');
  assert.deepEqual(stored.shipments, beforeFileUpload.shipments); assert.deepEqual(stored.payments, beforeFileUpload.payments); assert.deepEqual(stored.companies, beforeFileUpload.companies);
  await save(page.getByRole('button', { name: 'All statements', exact: true }));
  const fileRevision = revision, fileCount = stored.imports.length, retainedFileCount = files.size;
  await page.getByRole('button', { name: 'Import text or CSV', exact: true }).click();
  textImporter = page.getByRole('dialog', { name: 'Import text or CSV', exact: true });
  await textImporter.getByRole('tab', { name: 'Upload file', exact: true }).click();
  await textImporter.getByLabel('CSV or text statement', { exact: true }).setInputFiles(sourceCsv);
  await textImporter.getByRole('button', { name: 'Extract selected file', exact: true }).click();
  await page.getByRole('heading', { name: sourceCsv.name, exact: true }).waitFor();
  assert.equal(stored.imports.length, fileCount); assert.equal(files.size, retainedFileCount); assert.equal(revision, fileRevision, 'Reusing the same uploaded CSV does not save duplicate records.');
  await save(page.getByRole('button', { name: 'All statements', exact: true }));
  const beforeDraftDeletion = structuredClone(stored);
  await page.locator(mobile?'[aria-label="Statement imports"]:visible > article':'.import-history tbody tr').filter({ hasText: sourceCsv.name }).getByRole('button', { name: `Delete ${sourceCsv.name}`, exact: true }).click();
  await save(page.getByRole('dialog', { name: 'Delete statement', exact: true }).getByRole('button', { name: 'Delete statement', exact: true }));
  await page.getByRole('dialog', { name: 'Delete statement', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(stored.imports.some(item => item.id === fileBatch.id), false);
  assert.deepEqual(stored.companies, beforeDraftDeletion.companies); assert.deepEqual(stored.shipments, beforeDraftDeletion.shipments); assert.deepEqual(stored.payments, beforeDraftDeletion.payments);
  const keptSource = await context.request.get(`${origin}/api/files?key=${encodeURIComponent(fileBatch.fileKey)}`);
  assert.equal(keptSource.status(), 200); assert.deepEqual(await keptSource.body(), sourceCsv.buffer, 'Draft deletion keeps its retained original without changing the accounting records.');
  if(mobile)await page.getByRole('button',{name:'Workspace menu',exact:true}).click();
  await page.getByRole('button', { name: 'Dark appearance', exact: true }).click();
  await page.setViewportSize({ width: 320, height: 844 });
  for (const view of ['Overview', 'Companies', 'Deliveries', 'Payments', 'Imports', 'Reports']) {
    await navigate(view);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${view} must fit a 320px screen.`);
  }
  await page.screenshot({ path: path.join(output, 'mobile-dark.png'), fullPage: true });
  assert.deepEqual(rejectedSaves, []); assert.deepEqual(errors, []);
  console.log(`PASS ${mobile?'mobile':'desktop'} full workspace:`+' empty onboarding, supplier/customer creation, decimal purchases/sales, reviewed matching and margin, receipts/settlements/noncash deductions, five CSV reports, search, reload, quoted multiline CSV extraction and reviewed posting, multi-PDF supplier/customer posting with zero-effect exception drafts, exact CSV file retention/reuse, protected posted statements, draft deletion preserving originals/accounting, same-upload and posted-source deduplication, and six 320px dark views.');
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  console.error('Browser state:', (await page.locator('body').innerText()).slice(-5000));
  throw error;
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
