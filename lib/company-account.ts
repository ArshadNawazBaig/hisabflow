import { add, subtract, compare, validMoney, affectsCash } from './accounting.ts';
import { today, uid, type AdvanceApplication, type Company, type Payment, type Workspace } from './types.ts';

const zero = '0.00';
const sum = (values: string[]) => values.reduce((total, value) => add(total, value), zero);
const positiveMoney = (value: string) => validMoney(value) && compare(value, zero) > 0;
const nonnegative = (value: string) => compare(value, zero) < 0 ? zero : value;
const applications = (data: Workspace) => data.advanceApplications || [];
const approvedAdvance = (payment: Payment) => payment.treatment === 'Advance' && payment.balanceApplied !== true && positiveMoney(payment.amount) && affectsCash(payment);
const validDate = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T12:00:00Z`)) && new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) === date;
const customerRole = (company: Company | undefined) => company?.role === 'Customer' || company?.role === 'Both';

/** Canonical receivable remains positive; advances are derived rather than rewriting historical books. */
export function economicCompanyBalances(data: Workspace): Map<string, string> {
  const balances = new Map(data.companies.map(company => [company.id, validMoney(company.balance, true) ? company.balance : zero]));
  for (const payment of data.payments) {
    const balance = balances.get(payment.companyId);
    if (balance === undefined || !approvedAdvance(payment)) continue;
    balances.set(payment.companyId, payment.direction === 'Received' ? subtract(balance, payment.amount) : add(balance, payment.amount));
  }
  return balances;
}

export function economicCompanyBalance(data: Workspace, companyId: string): string {
  const company = data.companies.find(company => company.id === companyId);
  if (!company) return zero;
  let balance = validMoney(company.balance, true) ? company.balance : zero;
  for (const payment of data.payments) {
    if (payment.companyId !== companyId || !approvedAdvance(payment)) continue;
    balance = payment.direction === 'Received' ? subtract(balance, payment.amount) : add(balance, payment.amount);
  }
  return balance;
}

/** Counterparty account display: credit positive; money due from the company negative. */
export function companyAccountBalance(data: Workspace, companyId: string): string {
  return subtract(zero, economicCompanyBalance(data, companyId));
}

export function companyBalanceLabel(data: Workspace, companyId: string): string {
  const balance = companyAccountBalance(data, companyId), company = data.companies.find(company => company.id === companyId);
  if (compare(balance, zero) === 0) return 'Settled';
  if (compare(balance, zero) < 0) return company?.role === 'Supplier' ? 'Supplier advance / credit' : 'Due from company';
  return company?.role === 'Supplier' ? 'To pay' : 'Advance / credit';
}

export type AvailableCompanyAdvance = { payment: Payment; available: string; applied: string };

/** Existing order reservations are kept; refunds consume remaining credits FIFO. */
export function availableCompanyAdvances(data: Workspace, companyId: string, asOf = today()): AvailableCompanyAdvance[] {
  if (!customerRole(data.companies.find(company => company.id === companyId)) || !validDate(asOf)) return [];
  const appliedByPayment = new Map<string, string>();
  for (const application of applications(data)) {
    if (application.companyId === companyId && positiveMoney(application.amount)) appliedByPayment.set(application.paymentId, add(appliedByPayment.get(application.paymentId) || zero, application.amount));
  }
  const records = data.payments.filter(payment => payment.companyId === companyId && payment.direction === 'Received' && approvedAdvance(payment) && validDate(payment.date) && payment.date <= asOf)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  let refunds = sum(data.payments.filter(payment => payment.companyId === companyId && payment.direction === 'Paid' && approvedAdvance(payment)).map(payment => payment.amount));
  return records.map(payment => {
    const applied = appliedByPayment.get(payment.id) || zero;
    let available = nonnegative(subtract(payment.amount, applied));
    const refunded = compare(refunds, available) < 0 ? refunds : available;
    available = subtract(available, refunded); refunds = subtract(refunds, refunded);
    return { payment, available, applied };
  }).filter(record => compare(record.available, zero) > 0);
}

export function shipmentAdvanceSummary(data: Workspace, shipmentId: string): { applied: string; outstanding: string } {
  const shipment = data.shipments.find(shipment => shipment.id === shipmentId);
  const applied = sum(applications(data).filter(application => application.shipmentId === shipmentId && positiveMoney(application.amount)).map(application => application.amount));
  return { applied, outstanding: shipment && validMoney(shipment.amount) ? nonnegative(subtract(shipment.amount, applied)) : zero };
}

export function companyAccountSummary(data: Workspace, companyId: string) {
  const advancePayments = data.payments.filter(payment => payment.companyId === companyId && approvedAdvance(payment));
  const receivable = economicCompanyBalance(data, companyId);
  const appliedByShipment = new Map<string, string>();
  let totalApplied = zero;
  for (const application of applications(data)) {
    if (application.companyId !== companyId || !positiveMoney(application.amount)) continue;
    totalApplied = add(totalApplied, application.amount);
    appliedByShipment.set(application.shipmentId, add(appliedByShipment.get(application.shipmentId) || zero, application.amount));
  }
  return {
    balance: subtract(zero, receivable), receivable,
    totalAdvance: sum(advancePayments.filter(payment => payment.direction === 'Received').map(payment => payment.amount)),
    totalRefunded: sum(advancePayments.filter(payment => payment.direction === 'Paid').map(payment => payment.amount)),
    totalApplied,
    availableAdvance: sum(availableCompanyAdvances(data, companyId).map(record => record.available)),
    ordersNotCoveredByAdvance: sum(data.shipments.filter(shipment => shipment.companyId === companyId && shipment.direction === 'Dispatch' && validMoney(shipment.amount)).map(shipment => nonnegative(subtract(shipment.amount, appliedByShipment.get(shipment.id) || zero)))),
  };
}

/** Apply existing money to an order; no cash movement or stored balance is added. */
export function applyCompanyAdvance(data: Workspace, shipmentId: string, amount: string, date = today()): Workspace {
  const shipment = data.shipments.find(shipment => shipment.id === shipmentId);
  if (!shipment || shipment.direction !== 'Dispatch' || !customerRole(data.companies.find(company => company.id === shipment.companyId))) throw new Error('Choose a customer product order before applying an advance.');
  if (!validDate(date) || date > today()) throw new Error('Choose a valid application date up to today.');
  if (!positiveMoney(amount)) throw new Error('Enter a positive advance amount with at most two decimal places.');
  if (compare(amount, shipmentAdvanceSummary(data, shipmentId).outstanding) > 0) throw new Error('The advance amount exceeds the part of this order not covered by advance.');
  const sources = availableCompanyAdvances(data, shipment.companyId, date);
  if (compare(amount, sum(sources.map(source => source.available))) > 0) throw new Error('This company does not have enough available advance for this application date.');
  const next = structuredClone(data), entries: AdvanceApplication[] = [];
  let remaining = amount;
  for (const source of sources) {
    if (compare(remaining, zero) === 0) break;
    const used = compare(remaining, source.available) < 0 ? remaining : source.available;
    entries.push({ id: uid('ADV'), companyId: shipment.companyId, paymentId: source.payment.id, shipmentId, amount: used, date });
    remaining = subtract(remaining, used);
  }
  next.advanceApplications = [...applications(next), ...entries];
  const errors = validateAdvanceApplications(next, data);
  if (errors.length) throw new Error(errors.join('\n'));
  return next;
}

/** Snapshot-wide checks prevent editing or reusing a payment after reserving its funds. */
export function validateAdvanceApplications(data: Workspace, previous: Workspace | null = null): string[] {
  const errors: string[] = [], usedIds = new Set<string>(), paymentTotals = new Map<string, string>(), shipmentTotals = new Map<string, string>(), companyTotals = new Map<string, string>();
  const companiesById = new Map(data.companies.map(record => [record.id, record])), paymentsById = new Map(data.payments.map(record => [record.id, record])), shipmentsById = new Map(data.shipments.map(record => [record.id, record]));
  const applicationsById = new Map(applications(data).map(record => [record.id, record]));
  for (const original of previous ? applications(previous) : []) {
    const next = applicationsById.get(original.id);
    if (!next || (['id', 'companyId', 'paymentId', 'shipmentId', 'amount', 'date'] as const).some(key => original[key] !== next[key])) errors.push(`${original.id}: existing advance applications cannot be changed or removed. Retain their audited history.`);
  }
  const otherIds = new Set([...data.companies, ...data.payments, ...data.shipments, ...data.imports].map(record => record.id));
  for (const application of applications(data)) {
    const prefix = `${application.id}:`, company = companiesById.get(application.companyId), payment = paymentsById.get(application.paymentId), shipment = shipmentsById.get(application.shipmentId);
    if (!application.id || usedIds.has(application.id) || otherIds.has(application.id)) errors.push(`${prefix} advance application references must be unique.`);
    usedIds.add(application.id);
    if (!customerRole(company)) errors.push(`${prefix} advances can be applied only to customer accounts.`);
    if (!shipment || shipment.direction !== 'Dispatch' || shipment.companyId !== application.companyId) errors.push(`${prefix} select a product order for this same customer.`);
    if (!payment || payment.direction !== 'Received' || payment.companyId !== application.companyId || !approvedAdvance(payment)) errors.push(`${prefix} select an approved received advance in this customer's own cash or bank account.`);
    if (!validDate(application.date) || application.date > today()) errors.push(`${prefix} choose a valid application date up to today.`);
    if (payment && (!validDate(payment.date) || application.date < payment.date)) errors.push(`${prefix} an advance cannot be used before its payment date.`);
    if (!positiveMoney(application.amount)) { errors.push(`${prefix} application amounts must be positive with at most two decimal places.`); continue; }
    paymentTotals.set(application.paymentId, add(paymentTotals.get(application.paymentId) || zero, application.amount));
    shipmentTotals.set(application.shipmentId, add(shipmentTotals.get(application.shipmentId) || zero, application.amount));
    companyTotals.set(application.companyId, add(companyTotals.get(application.companyId) || zero, application.amount));
  }
  for (const [paymentId, used] of paymentTotals) {
    const payment = paymentsById.get(paymentId);
    if (payment && validMoney(payment.amount) && compare(used, payment.amount) > 0) errors.push(`${paymentId}: advance applications exceed the received payment.`);
  }
  for (const [shipmentId, used] of shipmentTotals) {
    const shipment = shipmentsById.get(shipmentId);
    if (shipment && validMoney(shipment.amount) && compare(used, shipment.amount) > 0) errors.push(`${shipmentId}: advance applications exceed the product order amount.`);
  }
  const funds = new Map<string, { received: string; refunded: string }>(), currentDate = today();
  for (const payment of data.payments) {
    if (!companyTotals.has(payment.companyId) || !approvedAdvance(payment)) continue;
    const total = funds.get(payment.companyId) || { received: zero, refunded: zero };
    if (payment.direction === 'Paid') total.refunded = add(total.refunded, payment.amount);
    else if (validDate(payment.date) && payment.date <= currentDate) total.received = add(total.received, payment.amount);
    funds.set(payment.companyId, total);
  }
  for (const [companyId, used] of companyTotals) {
    const { received, refunded } = funds.get(companyId) || { received: zero, refunded: zero };
    if (compare(used, nonnegative(subtract(received, refunded))) > 0) errors.push(`${companyId}: advance applications exceed funds remaining after refunds.`);
  }
  return [...new Set(errors)];
}

/** Describe order coverage without changing historical settlement fields. */
export function shipmentSettlementLabel(data: Workspace, shipmentId: string): string {
  const shipment = data.shipments.find(item => item.id === shipmentId);
  const summary = shipmentAdvanceSummary(data, shipmentId);
  if (compare(summary.applied, zero) > 0) return compare(summary.outstanding, zero) === 0 ? 'Covered by advance' : 'Partially covered by advance';
  return shipment?.settlement || 'Unresolved';
}
