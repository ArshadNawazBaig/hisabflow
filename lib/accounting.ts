import type { ImportBatch, Payment, Shipment, SourceRow, Workspace } from './types';

/** Decimal arithmetic uses integer minor units. Never coerce money through floating point. */
function scaled(value: string, places = 2): bigint {
  const text = String(value ?? '').trim().replace(/,/g, '');
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) throw new Error(`Invalid decimal: ${text || '(empty)'}`);
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = text.replace(/^-/, '').split('.');
  const retained = fraction.slice(0, places).padEnd(places, '0');
  let result = BigInt(whole) * BigInt(10) ** BigInt(places) + BigInt(retained || '0');
  if (fraction.length > places && Number(fraction[places]) >= 5) result += BigInt(1);
  return negative ? -result : result;
}
function decimal(value: bigint, places = 2): string {
  const negative = value < BigInt(0);
  const digits = (negative ? -value : value).toString().padStart(places + 1, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -places)}.${digits.slice(-places)}`;
}
export function add(a: string, b: string): string { return decimal(scaled(a) + scaled(b)); }
export function subtract(a: string, b: string): string { return decimal(scaled(a) - scaled(b)); }
export function multiply(weight: string, rate: string): string {
  // Preserve six places for quantities; round the final amount once, to minor units.
  const result = scaled(weight, 6) * scaled(rate, 6);
  const divisor = BigInt(10) ** BigInt(10);
  const negative = result < BigInt(0);
  const abs = negative ? -result : result;
  const rounded = (abs + divisor / BigInt(2)) / divisor;
  return decimal(negative ? -rounded : rounded);
}
export function compare(a: string, b: string): number {
  const delta = scaled(a) - scaled(b);
  return delta === BigInt(0) ? 0 : delta > BigInt(0) ? 1 : -1;
}
export function quantityAdd(a: string, b: string): string { return decimal(scaled(a || '0', 6) + scaled(b || '0', 6), 6); }
export function quantitySubtract(a: string, b: string): string { return decimal(scaled(a || '0', 6) - scaled(b || '0', 6), 6); }
export function quantityCompare(a: string, b: string): number {
  const delta = scaled(a || '0', 6) - scaled(b || '0', 6);
  return delta === BigInt(0) ? 0 : delta > BigInt(0) ? 1 : -1;
}
export function validMoney(value: unknown, allowNegative = false): value is string {
  return typeof value === 'string' && (allowNegative ? /^-?\d{1,15}(?:\.\d{1,2})?$/ : /^\d{1,15}(?:\.\d{1,2})?$/).test(value);
}
export type Reconciliation = {
  goods: string; paid: string; closing: string; goodsCount: number; paymentCount: number;
  transitions: { id: string; computed: string; source: string; matches: boolean }[]; balanced: boolean;
};
export function reconcile(rows: SourceRow[], opening = '0'): Reconciliation {
  let goods = '0.00', paid = '0.00', closing = add(opening || '0', '0');
  let goodsCount = 0, paymentCount = 0;
  const transitions: Reconciliation['transitions'] = [];
  // Never sort: source row order is part of the evidence.
  for (const row of rows) {
    if (row.kind === 'excluded' || row.status === 'Excluded') continue;
    const rowGoods = row.goods || '0', rowPaid = row.paid || '0';
    if (compare(rowGoods, '0') !== 0) { goodsCount++; goods = add(goods, rowGoods); }
    if (compare(rowPaid, '0') !== 0) { paymentCount++; paid = add(paid, rowPaid); }
    closing = subtract(add(closing, rowGoods), rowPaid);
    let matches = false;
    try { matches = !!row.balance && compare(closing, row.balance) === 0; } catch { /* remains unresolved */ }
    transitions.push({ id: row.id, computed: closing, source: row.balance, matches });
  }
  return { goods, paid, closing, goodsCount, paymentCount, transitions, balanced: transitions.length > 0 && transitions.every(t => t.matches) };
}

function approvedDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function fingerprint(row: SourceRow): string {
  // Amount alone and transaction reference alone are intentionally insufficient.
  return [row.effectiveDate, row.description.trim().toLowerCase(), row.party.trim().toLowerCase(), row.vehicle.trim().toLowerCase(), row.weight, row.goods || '0', row.paid || '0', row.reference].join('|');
}
function positive(value: string): boolean {
  try { return compare(value || '0', '0') > 0; } catch { return false; }
}
export function validateImport(batch: ImportBatch, workspace: Workspace): string[] {
  const errors: string[] = [], m = batch.mapping;
  const company = workspace.companies.find(c => c.id === m.counterpartyId);
  if (!m.business || m.business !== workspace.business) errors.push('Select the business receiving these records.');
  if (!m.issuer.trim()) errors.push('Identify the source statement issuer.');
  if (!company) errors.push('Select an existing accounting counterparty.');
  if (!m.perspective) errors.push('Confirm the source statement perspective.');
  if (!m.partyMeaning.trim()) errors.push('Explain the meaning of the PARTY column.');
  if (!m.currency || m.currency !== workspace.currency) errors.push('Confirm the business currency; cross-currency imports require conversion review.');
  if (!m.unit || !m.unitsConfirmed) errors.push('Confirm both currency and weight unit before posting.');
  if (!m.history) errors.push('Confirm whether this is complete or partial history.');
  if (!m.direction) errors.push('Confirm whether goods are receipts or dispatches in your books.');
  if (company && m.direction === 'Receipt' && company.role === 'Customer') errors.push('Goods receipts require a supplier or a company with both roles.');
  if (company && m.direction === 'Dispatch' && company.role === 'Supplier') errors.push('Goods dispatches require a customer or a company with both roles.');
  if (!batch.hash || !batch.fileKey) errors.push('Retain the uploaded source file and its hash before posting.');
  if (workspace.imports.some(b => b.id !== batch.id && b.status === 'Posted' && b.hash === batch.hash)) errors.push('This source file has already been imported.');
  if (batch.status === 'Posted' || workspace.imports.some(b => b.id === batch.id && b.status === 'Posted')) errors.push('This import batch is already posted.');
  if (!validMoney(m.openingBalance, true)) errors.push('Enter a valid source opening balance.');
  if (!validMoney(m.expectedClosing, true)) errors.push('Enter the printed closing source balance.');
  const active = batch.rows.filter(r => r.kind !== 'excluded' && r.status !== 'Excluded');
  if (!active.length) errors.push('No transaction rows are ready to import.');
  const prior = workspace.imports.filter(b => b.status === 'Posted' && b.mapping.counterpartyId === m.counterpartyId);
  const priorRows = new Set(prior.flatMap(b => b.rows.filter(r => r.kind !== 'excluded').map(fingerprint)));
  const openingCutoffs = prior.filter(b => b.mapping.mode === 'Opening balance' && approvedDate(b.mapping.cutoff)).map(b => b.mapping.cutoff);
  if (m.mode === 'Transactions' && active.some(row => approvedDate(row.effectiveDate) && openingCutoffs.some(cutoff => row.effectiveDate <= cutoff))) errors.push('These transactions overlap an already posted opening-balance cutoff. Import only subsequent activity.');
  if (m.mode === 'Opening balance') {
    if (!approvedDate(m.cutoff)) errors.push('Choose an agreed opening balance cutoff date.');
    if (prior.length || workspace.shipments.some(s => s.companyId === m.counterpartyId) || workspace.payments.some(p => p.companyId === m.counterpartyId)) errors.push('An opening balance cannot be added over existing counterparty history.');
  }
  for (const row of active) {
    const label = `Row ${row.sequence}`;
    if (row.status !== 'Approved' || !row.reviewer || !row.reviewedAt || !Number.isFinite(Date.parse(row.reviewedAt))) errors.push(`${label}: finish and sign off the review.`);
    if (!approvedDate(row.effectiveDate)) errors.push(`${label}: approve a valid effective date.`);
    if (!validMoney(row.goods || '0') || !validMoney(row.paid || '0') || !validMoney(row.balance, true)) errors.push(`${label}: source amounts and running balance must be valid decimals.`);
    if (!row.raw || !row.page || !row.sequence) errors.push(`${label}: source page, row and raw evidence are required.`);
    if (priorRows.has(fingerprint(row))) errors.push(`${label}: potential overlap with a posted statement; resolve it before importing.`);
    if (positive(row.paid)) {
      if (!row.treatment) errors.push(`${label}: review the payment accounting treatment.`);
      if (!row.actor?.trim()) errors.push(`${label}: identify the actual payer or beneficiary.`);
      if (!row.companyId || !workspace.companies.some(c => c.id === row.companyId)) errors.push(`${label}: deliberately allocate the payment to an accounting counterparty.`);
      if (row.companyId && row.companyId !== m.counterpartyId && !row.description.trim()) errors.push(`${label}: explain the allocation to a different counterparty.`);
      if (!row.description.trim()) errors.push(`${label}: add the reason and supporting description.`);
      const allocatedCompany = workspace.companies.find(c => c.id === row.companyId);
      if (row.treatment === 'Customer receipt' && (m.direction !== 'Dispatch' || allocatedCompany?.role === 'Supplier')) errors.push(`${label}: customer receipt treatment requires an incoming receipt allocated to a customer.`);
      if (['Supplier settlement','Supplier-agreed deduction'].includes(row.treatment || '') && (m.direction !== 'Receipt' || allocatedCompany?.role === 'Customer')) errors.push(`${label}: supplier settlement treatment requires an outgoing payment allocated to a supplier.`);
    }
    if (row.weight && row.rate && positive(row.goods)) {
      try { if (compare(multiply(row.weight, row.rate), row.goods) !== 0) errors.push(`${label}: weight × rate does not match the source goods amount.`); }
      catch { errors.push(`${label}: weight or rate is not a valid decimal.`); }
    }
  }
  try {
    const result = reconcile(batch.rows, m.openingBalance);
    if (!result.balanced) errors.push('Every running balance must reconcile in original source order.');
    if (validMoney(m.expectedClosing, true) && compare(result.closing, m.expectedClosing) !== 0) errors.push('Computed closing balance differs from the printed closing balance.');
  } catch { errors.push('Resolve invalid source numbers before reconciliation.'); }
  return [...new Set(errors)];
}

export function postImport(batch: ImportBatch, workspace: Workspace, reviewer: string): Workspace {
  const errors = validateImport(batch, workspace);
  if (errors.length) throw new Error(errors.join('\n'));
  const next: Workspace = structuredClone(workspace);
  const m = batch.mapping, result = reconcile(batch.rows, m.openingBalance);
  const postedIds: string[] = [], now = new Date().toISOString();
  if (m.mode === 'Opening balance') {
    next.companies = next.companies.map(c => c.id === m.counterpartyId ? { ...c, balance: m.direction === 'Receipt' ? subtract('0', result.closing) : result.closing } : c);
    postedIds.push(`OPEN-${batch.id}`);
  } else {
    for (const row of batch.rows) {
      if (row.kind === 'excluded' || row.status === 'Excluded') continue;
      if (compare(row.goods || '0', '0') > 0) {
        const id = `IMP-${batch.id}-${row.id}-G`;
        const shipment: Shipment = {
          id, direction: m.direction as 'Receipt' | 'Dispatch', companyId: m.counterpartyId,
          deliveryParty: row.party, date: row.effectiveDate, vehicle: row.vehicle,
          product: 'Imported goods', weight: row.weight, unit: m.unit, rate: row.rate, amount: row.goods,
          // Rejection is a delivery flag. Source amount remains positive and no stock reversal is invented.
          status: /reject/i.test(`${row.description} ${row.party} ${row.reference}`) ? 'Rejected' : 'Pending',
          settlement: 'Unresolved', sourceRef: batch.id, sourcePage: row.page, sourceRow: row.sequence,
          notes: row.description, attachment: batch.fileKey,
        };
        next.shipments.push(shipment); postedIds.push(id);
        next.companies = next.companies.map(c => c.id === m.counterpartyId ? { ...c, balance: m.direction === 'Receipt' ? subtract(c.balance, row.goods) : add(c.balance, row.goods) } : c);
      }
      if (compare(row.paid || '0', '0') > 0) {
        const id = `IMP-${batch.id}-${row.id}-P`;
        const treatment = row.treatment!;
        const payment: Payment = {
          id, direction: m.direction === 'Receipt' ? 'Paid' : 'Received', date: row.effectiveDate,
          companyId: row.companyId!, actor: row.actor!, onBehalfOf: m.counterpartyId,
          amount: row.paid, account: 'Unassigned — review own account',
          bankLabel: /\b(UBL|MBL|Askari)\b/i.exec(row.description)?.[0] || '',
          reference: row.reference, treatment, status: 'Needs review', notes: row.description, sourceRef: batch.id, evidence: batch.fileKey,
          balanceApplied: ['Supplier settlement', 'Customer receipt', 'Payment on behalf', 'Supplier-agreed deduction'].includes(treatment),
        };
        next.payments.push(payment); postedIds.push(id);
        // Cash account is deliberately not inferred from the statement bank label.
        // Only approved settlement classifications affect the deliberately selected counterparty.
        if (['Supplier settlement', 'Customer receipt', 'Payment on behalf', 'Supplier-agreed deduction'].includes(treatment)) {
          next.companies = next.companies.map(c => c.id === row.companyId ? { ...c, balance: payment.direction === 'Paid' ? add(c.balance, row.paid) : subtract(c.balance, row.paid) } : c);
        }
      }
    }
  }
  const posted: ImportBatch = { ...structuredClone(batch), status: 'Posted', postedAt: now, postedRecordIds: postedIds, step: 6 };
  next.imports = [...next.imports.filter(b => b.id !== batch.id), posted];
  next.audit.unshift({ id: `AUD-${crypto.randomUUID()}`, at: now, action: 'Import posted', detail: `${batch.name}: ${postedIds.length} linked records; ${m.mode.toLowerCase()}. Source balance ${result.closing} ${m.currency}.`, actor: reviewer, sourceRef: batch.id });
  return next;
}

export function confirmedMargin(data: Workspace): { amount: string; unresolved: number } {
  let amount = '0.00', unresolved = 0;
  const review = reviewCostAllocations(data);
  for (const sale of data.shipments.filter(s => s.direction === 'Dispatch')) {
    if (sale.costAllocations?.length || sale.costAllocationConfirmed) {
      if (!sale.costAllocationConfirmed || review.invalidSales.has(sale.id) || !review.costs.has(sale.id)) { unresolved++; continue; }
      amount = add(amount, subtract(sale.amount, review.costs.get(sale.id)!));
      continue;
    }
    const cost = data.shipments.find(s => s.id === sale.matchedId && s.direction === 'Receipt');
    if (!sale.matchConfirmed || !cost || !cost.matchConfirmed || cost.matchedId !== sale.id || review.invalidSales.has(sale.id)) { unresolved++; continue; }
    amount = add(amount, subtract(sale.amount, cost.amount));
  }
  return { amount, unresolved };
}

function reviewCostAllocations(data: Workspace): { errors: string[]; invalidSales: Set<string>; costs: Map<string,string> } {
  const errors: string[] = [], invalidSales = new Set<string>(), costs = new Map<string,string>();
  const usage = new Map<string, { quantity: bigint; consumers: Set<string> }>();
  const issue = (saleId: string, text: string) => { invalidSales.add(saleId); errors.push(`${saleId}: ${text}`); };
  const register = (sourceId: string, weight: string, saleId: string) => {
    try {
      const item = usage.get(sourceId) ?? { quantity: BigInt(0), consumers: new Set<string>() };
      item.quantity += scaled(weight, 6); item.consumers.add(saleId); usage.set(sourceId, item);
    } catch { issue(saleId, 'cost allocation quantity is not a valid decimal.'); }
  };
  for (const sale of data.shipments) {
    const allocations = sale.costAllocations ?? [];
    if (allocations.length || sale.costAllocationConfirmed) {
      if (sale.direction !== 'Dispatch') { issue(sale.id, 'cost allocations belong to a dispatch, not a goods receipt.'); continue; }
      if (sale.matchConfirmed) issue(sale.id, 'unlink the confirmed one-to-one match before allocating multiple purchase sources.');
      if (!allocations.length) issue(sale.id, 'a confirmed allocation needs reviewed purchase sources.');
      if (!/^\d{1,12}(?:\.\d{1,6})?$/.test(sale.weight) || quantityCompare(sale.weight, '0') <= 0) issue(sale.id, 'review a positive dispatch quantity before allocating purchase costs.');
      let totalWeight = '0.000000', totalCost = '0.00';
      const sources = new Set<string>();
      for (const allocation of allocations) {
        if (sources.has(allocation.shipmentId)) issue(sale.id, 'combine repeated allocations from the same purchase source.');
        sources.add(allocation.shipmentId);
        const source = data.shipments.find(s => s.id === allocation.shipmentId && s.direction === 'Receipt');
        if (!source) { issue(sale.id, 'every allocated cost must reference an existing goods receipt.'); continue; }
        const quantityValid = /^\d{1,12}(?:\.\d{1,6})?$/.test(allocation.weight) && quantityCompare(allocation.weight, '0') > 0;
        if (!quantityValid) { issue(sale.id, 'allocation quantities must be positive decimals with up to six decimal places.'); continue; }
        totalWeight = quantityAdd(totalWeight, allocation.weight);
        register(source.id, allocation.weight, sale.id);
        if (!source.unit.trim() || source.unit.trim().toLowerCase() !== sale.unit.trim().toLowerCase()) issue(sale.id, 'allocated purchase sources must use the same approved unit as the dispatch.');
        if (!source.product.trim() || source.product.trim().toLowerCase() !== sale.product.trim().toLowerCase()) issue(sale.id, 'allocated purchase sources must contain the same product as the dispatch.');
        if (source.grade && sale.grade && source.grade.trim().toLowerCase() !== sale.grade.trim().toLowerCase()) issue(sale.id, 'allocated grades differ and require a reviewed adjustment.');
        try {
          if (!validMoney(allocation.amount) || compare(multiply(allocation.weight, source.rate), allocation.amount) !== 0) issue(sale.id, 'allocated cost must equal the reviewed source rate multiplied by allocated quantity.');
          if (validMoney(allocation.amount)) totalCost = add(totalCost, allocation.amount);
        } catch { issue(sale.id, 'the purchase source needs a valid reviewed cost rate.'); }
      }
      try {
        const coverage = quantityCompare(totalWeight, sale.weight);
        if (coverage > 0) issue(sale.id, 'allocated purchase quantities exceed the dispatch quantity.');
        if (sale.costAllocationConfirmed && coverage !== 0) issue(sale.id, 'cover the complete dispatch quantity before confirming its trading margin.');
      } catch { issue(sale.id, 'the dispatch quantity must be reviewed before cost confirmation.'); }
      if (sale.costAllocationConfirmed && !sale.costAllocationEvidence?.trim()) issue(sale.id, 'retain evidence for the reviewed purchase allocations and accounting directions.');
      costs.set(sale.id, totalCost);
    }
    if (sale.direction === 'Dispatch' && sale.matchConfirmed && sale.matchedId) {
      const source = data.shipments.find(s => s.id === sale.matchedId && s.direction === 'Receipt');
      if (source?.matchConfirmed && source.matchedId === sale.id) {
        try { if (!!source.weight !== !!sale.weight || (source.weight && sale.weight && quantityCompare(source.weight, sale.weight) !== 0)) issue(sale.id, 'one-to-one match quantities differ; allocate the purchase costs explicitly.'); }
        catch { issue(sale.id, 'one-to-one match quantities remain unresolved.'); }
        if (source.unit && sale.unit && source.unit.trim().toLowerCase() !== sale.unit.trim().toLowerCase()) issue(sale.id, 'one-to-one match units differ.');
        if (source.product && sale.product && source.product.trim().toLowerCase() !== sale.product.trim().toLowerCase()) issue(sale.id, 'one-to-one match products differ.');
        if (sale.weight) register(source.id, sale.weight, sale.id);
      }
    }
  }
  for (const [sourceId, used] of usage) {
    const source = data.shipments.find(s => s.id === sourceId)!;
    try {
      if (!source.weight || used.quantity > scaled(source.weight, 6)) for (const saleId of used.consumers) issue(saleId, `purchase source ${sourceId} has insufficient unallocated quantity.`);
    } catch { for (const saleId of used.consumers) issue(saleId, `purchase source ${sourceId} has an unresolved quantity.`); }
  }
  return { errors: [...new Set(errors)], invalidSales, costs };
}

const settlements = ['Supplier settlement', 'Customer receipt', 'Payment on behalf', 'Supplier-agreed deduction'];
function settlesCompany(payment: Payment): boolean {
  return settlements.includes(payment.treatment) && (payment.balanceApplied === true || (payment.balanceApplied === undefined && payment.status === 'Allocated'));
}
export function affectsCash(payment: Payment): boolean {
  return payment.status === 'Allocated' && !!payment.account.trim() &&
    !/^(?:unassigned|unresolved|unknown|non[-\s]?cash|none)(?:\b|\s|$)/i.test(payment.account.trim()) &&
    payment.treatment !== 'Supplier-agreed deduction';
}

/** Validate manual financial records as well as changes derived from source imports. */
export function validateWorkspaceRecords(incoming: Workspace, previous: Workspace | null = null): string[] {
  const errors: string[] = [];
  if (previous && previous.currency !== incoming.currency && (previous.shipments.length || previous.payments.length || previous.imports.some(b => b.status === 'Posted') || Number(previous.openingCash) !== 0 || previous.companies.some(c => Number(c.balance) !== 0))) errors.push('Currency cannot change over existing financial records without a reviewed conversion.');
  errors.push(...reviewCostAllocations(incoming).errors);
  const companies = new Map(incoming.companies.map(c => [c.id, c]));
  for (const shipment of incoming.shipments) {
    const prefix = `${shipment.id}:`, company = companies.get(shipment.companyId);
    if (!approvedDate(shipment.date)) errors.push(`${prefix} choose a valid delivery effective date.`);
    if (!company) errors.push(`${prefix} select an existing accounting company.`);
    if (company && ((shipment.direction === 'Receipt' && company.role === 'Customer') || (shipment.direction === 'Dispatch' && company.role === 'Supplier'))) errors.push(`${prefix} delivery direction does not match the company's accounting role.`);
    if (!validMoney(shipment.amount) || !positive(shipment.amount)) errors.push(`${prefix} delivery amount must be positive with at most two decimal places.`);
    if (shipment.weight) {
      if (!/^\d{1,12}(?:\.\d{1,6})?$/.test(shipment.weight)) errors.push(`${prefix} weight must be a nonnegative decimal with up to six decimal places.`);
      if (!validMoney(shipment.rate)) errors.push(`${prefix} enter a valid rate when a weight is provided.`);
      try { if (compare(multiply(shipment.weight, shipment.rate), shipment.amount) !== 0) errors.push(`${prefix} quantity × rate must equal the amount; record quantity adjustments separately.`); }
      catch { /* invalid quantity/rate already reported */ }
      if (!shipment.unit.trim()) errors.push(`${prefix} confirm the weight unit.`);
    } else if (shipment.rate && !validMoney(shipment.rate)) errors.push(`${prefix} the rate must be a valid nonnegative decimal.`);
    if (shipment.matchConfirmed) {
      const match = incoming.shipments.find(s => s.id === shipment.matchedId);
      if (!match || match.id === shipment.id || match.direction === shipment.direction || !match.matchConfirmed || match.matchedId !== shipment.id) errors.push(`${prefix} a confirmed match needs reciprocal references and opposite accounting directions.`);
      if (match && match.companyId === shipment.companyId) errors.push(`${prefix} confirm distinct purchase and sale counterparties.`);
      if (match) {
        try { if (!!match.weight !== !!shipment.weight || (match.weight && shipment.weight && scaled(match.weight, 6) !== scaled(shipment.weight, 6))) errors.push(`${prefix} quantities differ; review and allocate costs before confirming a margin.`); }
        catch { errors.push(`${prefix} match quantities must be valid reviewed decimals.`); }
      }
      if (match && match.unit.trim().toLowerCase() !== shipment.unit.trim().toLowerCase()) errors.push(`${prefix} match quantities must use the same approved unit.`);
    }
  }
  for (const payment of incoming.payments) {
    const prefix = `${payment.id}:`, company = companies.get(payment.companyId);
    if (!approvedDate(payment.date)) errors.push(`${prefix} choose a valid payment effective date.`);
    if (!validMoney(payment.amount) || !positive(payment.amount)) errors.push(`${prefix} payment amount must be positive with at most two decimal places.`);
    if (payment.companyId && !company) errors.push(`${prefix} the selected company does not exist.`);
    if ((payment.status === 'Allocated' || payment.balanceApplied) && !company) errors.push(`${prefix} deliberately select a company before approving allocation.`);
    if (!payment.actor.trim()) errors.push(`${prefix} identify the actual payer or beneficiary.`);
    if (payment.balanceApplied && !settlements.includes(payment.treatment)) errors.push(`${prefix} this treatment does not settle a company balance.`);
    if (payment.status === 'Allocated' && settlements.includes(payment.treatment) && payment.balanceApplied === false) errors.push(`${prefix} an approved settlement must carry its reviewed balance allocation.`);
    if (payment.treatment === 'Supplier settlement' || payment.treatment === 'Supplier-agreed deduction') {
      if (payment.direction !== 'Paid' || company?.role === 'Customer') errors.push(`${prefix} a supplier settlement requires a paid direction and a supplier account.`);
    }
    if (payment.treatment === 'Customer receipt' && (payment.direction !== 'Received' || company?.role === 'Supplier')) errors.push(`${prefix} a customer receipt requires a received direction and a customer account.`);
    if (payment.treatment === 'Payment on behalf' && company && ((payment.direction === 'Paid' && company.role === 'Customer') || (payment.direction === 'Received' && company.role === 'Supplier'))) errors.push(`${prefix} review the company role and direction of this third-party settlement.`);
    if (payment.treatment === 'Supplier-agreed deduction' && !payment.evidence?.trim()) errors.push(`${prefix} retain supporting evidence for the supplier-agreed deduction.`);
  }
  for (const batch of incoming.imports.filter(b => b.status === 'Posted')) {
    for (const id of batch.postedRecordIds ?? []) {
      if (id.startsWith('OPEN-')) continue;
      if (!incoming.shipments.some(s => s.id === id && s.sourceRef === batch.id) && !incoming.payments.some(p => p.id === id && p.sourceRef === batch.id)) errors.push(`${batch.id}: posted record ${id} must retain its source link.`);
    }
  }
  if (previous) {
    // Existing balances may only move by the signed effects of reviewed records.
    // New company balances are explicit opening balances and are allowed as entered.
    const expected = new Map(previous.companies.map(c => [c.id, c.balance]));
    const applyShipment = (shipment: Shipment, reverse: boolean) => {
      if (!expected.has(shipment.companyId) || !validMoney(shipment.amount)) return;
      const delta = (shipment.direction === 'Dispatch') !== reverse ? shipment.amount : subtract('0', shipment.amount);
      expected.set(shipment.companyId, add(expected.get(shipment.companyId)!, delta));
    };
    const applyPayment = (payment: Payment, reverse: boolean) => {
      if (!expected.has(payment.companyId) || !validMoney(payment.amount) || !settlesCompany(payment)) return;
      const delta = (payment.direction === 'Paid') !== reverse ? payment.amount : subtract('0', payment.amount);
      expected.set(payment.companyId, add(expected.get(payment.companyId)!, delta));
    };
    previous.shipments.forEach(s => applyShipment(s, true));
    incoming.shipments.forEach(s => applyShipment(s, false));
    previous.payments.forEach(p => applyPayment(p, true));
    incoming.payments.forEach(p => applyPayment(p, false));
    for (const opening of incoming.imports.filter(b => b.status === 'Posted' && b.mapping.mode === 'Opening balance' && !previous.imports.some(p => p.id === b.id && p.status === 'Posted'))) {
      try {
        const closing = reconcile(opening.rows, opening.mapping.openingBalance).closing;
        expected.set(opening.mapping.counterpartyId, opening.mapping.direction === 'Receipt' ? subtract('0', closing) : closing);
      } catch { errors.push(`${opening.id}: resolve source numbers before posting an opening balance.`); }
    }
    for (const [id, balance] of expected) {
      const company = companies.get(id);
      if (company && compare(company.balance, balance) !== 0) errors.push(`${company.name}: balance change does not match reviewed goods and settlement records.`);
    }
  }
  return [...new Set(errors)];
}

/** Recompute import effects before accepting a client snapshot. The caller persists only after this succeeds. */
export function validatePostedChanges(incoming: Workspace, previous: Workspace | null, reviewer: string): string[] {
  const errors: string[] = [];
  for (const posted of previous?.imports.filter(b => b.status === 'Posted') ?? []) {
    const next = incoming.imports.find(b => b.id === posted.id);
    if (!next || !sameValue(next, posted)) errors.push('Posted source batches are immutable. Record an audited adjustment instead.');
  }
  const postings = incoming.imports.filter(b => b.status === 'Posted' && !previous?.imports.some(p => p.id === b.id && p.status === 'Posted'));
  if (!postings.length) return errors;
  if (!previous) return [...errors, 'Save the private business workspace before posting a source import.'];
  let expected = structuredClone(previous);
  for (const batch of postings) {
    const draft = { ...batch, status: 'Draft' as const };
    const failures = validateImport(draft, expected);
    if (failures.length) { errors.push(...failures); continue; }
    expected = postImport(draft, expected, reviewer);
    const expectedBatch = expected.imports.find(b => b.id === batch.id)!;
    if (!sameValue(batch.postedRecordIds, expectedBatch.postedRecordIds)) errors.push('Imported record links do not match the reviewed source.');
    for (const shipment of expected.shipments.filter(s => s.sourceRef === batch.id)) {
      if (!sameValue(incoming.shipments.find(s => s.id === shipment.id), shipment)) errors.push('Imported shipment differs from the reviewed source.');
    }
    for (const payment of expected.payments.filter(p => p.sourceRef === batch.id)) {
      if (!sameValue(incoming.payments.find(p => p.id === payment.id), payment)) errors.push('Imported payment differs from the reviewed source.');
    }
  }
  for (const company of expected.companies) {
    const actual = incoming.companies.find(c => c.id === company.id);
    if (!actual || actual.balance !== company.balance) errors.push('Company balance does not match the reviewed import effects.');
  }
  return [...new Set(errors)];
}
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => sameValue(value, b[i]));
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = Object.keys(left).filter(k => left[k] !== undefined).sort(), other = Object.keys(right).filter(k => right[k] !== undefined).sort();
  return keys.length === other.length && keys.every((key, i) => key === other[i] && sameValue(left[key], right[key]));
}
