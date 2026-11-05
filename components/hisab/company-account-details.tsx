'use client';

import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowDownLeft, ArrowRight, ArrowUpRight, Building2, Check, FileText, Plus, ReceiptText, Truck, Wallet } from 'lucide-react';
import { money, type Workspace } from '@/lib/types';
import { add, compare, validMoney } from '@/lib/accounting';
import { availableCompanyAdvances, companyAccountSummary, shipmentAdvanceSummary } from '@/lib/company-account';
import { InfiniteListFooter, useInfiniteList } from './infinite-list';
import './company-account-details.css';

type AccountTab = 'payments' | 'orders' | 'statements';
type Props = {
  companyId: string;
  data: Workspace;
  onRecordPayment: (advance?: boolean) => void;
  onRecordSale: () => void;
  onApplyAdvance: (shipmentId: string) => void;
  onReviewStatement?: (id: string) => void;
};

function displayDate(value: string) {
  return value ? new Date(`${value.slice(0,10)}T12:00:00`).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' }) : 'Date not recorded';
}
function AccountMoney({ value, currency, signed = false }: { value: string; currency: string; signed?: boolean }) {
  const amount = money(value,2);
  const formatted = signed ? compare(value,'0') < 0 ? amount.replace(/^-/,'− ') : compare(value,'0') > 0 ? `+ ${amount}` : amount : amount;
  return <span className={`ca-money ${formatted.length > 15 ? 'is-long' : formatted.length > 10 ? 'is-medium' : ''}`}><span className="ca-currency">{currency}</span>{' '}<span className="ca-number">{formatted}</span></span>;
}
function Metadata({ items }: { items: [string, ReactNode][] }) {
  const visible = items.filter(([,value]) => value !== '' && value !== undefined && value !== null);
  return <dl className="ca-meta">{visible.map(([label,value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}
function AdvanceReferences({ entries, currency }: { entries: {id:string;label:string;detail?:string;amount:string;date:string}[]; currency:string }) {
  return <ul className="ca-application-links">{entries.map(entry => <li key={entry.id}><b>{entry.label}</b>{entry.detail && <small>{entry.detail}</small>}<span><AccountMoney value={entry.amount} currency={currency}/><time dateTime={entry.date}>{displayDate(entry.date)}</time></span></li>)}</ul>;
}
function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return <div className="ca-empty">{icon}<h4>{title}</h4><p>{children}</p></div>;
}

/** A company's payment ledger, advance position, and linked sales in one place. */
export function CompanyAccountDetails({ companyId, data, onRecordPayment, onRecordSale, onApplyAdvance, onReviewStatement }: Props) {
  const [tab,setTab] = useState<AccountTab>('payments');
  const identifier = useId();
  const company = data.companies.find(item => item.id === companyId);
  const payments = data.payments.filter(payment => payment.companyId === companyId).sort((a,b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  const orders = data.shipments.filter(shipment => shipment.companyId === companyId && shipment.direction === 'Dispatch').sort((a,b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  const statements = data.imports.filter(statement => statement.mapping.counterpartyId === companyId).sort((a,b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const paymentList = useInfiniteList(payments,`${companyId}:${tab}`);
  const orderList = useInfiniteList(orders,`${companyId}:${tab}`);
  const statementList = useInfiniteList(statements,`${companyId}:${tab}`);
  if (!company) return <EmptyState icon={<Building2 size={28}/>} title="Company no longer available">Close this account and select another company.</EmptyState>;
  const summary = companyAccountSummary(data,companyId);
  const advances = new Map(availableCompanyAdvances(data,companyId).map(item => [item.payment.id,item.available]));
  const customer = company.role === 'Customer' || company.role === 'Both';
  const balanceSign = compare(summary.balance,'0');
  const available = compare(summary.availableAdvance,'0') > 0;
  const tabs: {id:AccountTab;label:string;count:number}[] = [{id:'payments',label:'Payments',count:payments.length},...(customer ? [{id:'orders' as const,label:'Orders',count:orders.length}] : []),{id:'statements',label:'Statements',count:statements.length}];
  const activeTab = tabs.some(item => item.id === tab) ? tab : 'payments';
  function tabKeys(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = event.key === 'ArrowRight' ? (index+1)%tabs.length : event.key === 'ArrowLeft' ? (index+tabs.length-1)%tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length-1 : -1;
    if (next === -1) return;
    event.preventDefault(); setTab(tabs[next].id);
    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]'); buttons?.[next].focus();
  }
  return <section className="company-account-details" aria-label={`${company.name} account`}>
    <div className="ca-company-identity"><span className="ca-company-symbol"><Building2 size={22}/></span><div><h3>{company.name}</h3><p>{company.contact || company.role}{company.email && <><span aria-hidden="true"> · </span><span>{company.email}</span></>}</p><span className={`ca-company-status ${company.status === 'Active' ? 'is-active' : ''}`}>{company.status}</span></div></div>
    <dl className={`ca-summary ${customer ? '' : 'ca-summary-supplier'}`} aria-label="Company account summary">
      <div className={`ca-balance ${balanceSign < 0 ? 'is-due' : balanceSign > 0 ? 'is-credit' : ''}`}><dt>Account balance</dt><dd><strong><AccountMoney value={summary.balance} currency={data.currency} signed/></strong><small>{balanceSign < 0 ? 'Amount to receive from this company' : balanceSign > 0 ? 'Credit in this company’s favour' : 'Account balanced'}</small></dd></div>
      {customer && <><div className="ca-summary-tile"><dt>Available advance</dt><dd><strong><AccountMoney value={summary.availableAdvance} currency={data.currency}/></strong><small>Ready to apply to a sale</small></dd></div><div className="ca-summary-tile"><dt>Advance used</dt><dd><strong><AccountMoney value={summary.totalApplied} currency={data.currency}/></strong><small>Linked to recorded sales</small></dd></div></>}
    </dl>
    {customer && <p className="ca-balance-help">Minus means the company owes you. Plus means the company has credit. Applying advance links money already received; it does not record another payment.</p>}
    <div className="ca-quick-actions"><button type="button" className="button button-primary" onClick={() => onRecordPayment(false)}><Wallet size={16}/>Record payment</button>{customer && <><button type="button" className="button button-secondary" onClick={() => onRecordPayment(true)}><Plus size={16}/>Record advance</button><button type="button" className="button button-secondary" disabled={company.status !== 'Active'} onClick={onRecordSale}><Truck size={16}/>Record sale</button></>}</div>
    <div className="ca-tabs" role="tablist" aria-label="Company account sections">{tabs.map((item,index) => <button type="button" role="tab" id={`${identifier}-${item.id}-tab`} aria-controls={`${identifier}-${item.id}-panel`} aria-selected={activeTab === item.id} tabIndex={activeTab === item.id ? 0 : -1} key={item.id} onKeyDown={event => tabKeys(event,index)} onClick={() => setTab(item.id)}>{item.label}<span aria-hidden="true">{item.count}</span></button>)}</div>
    <div className="ca-tab-panel" role="tabpanel" id={`${identifier}-${activeTab}-panel`} aria-labelledby={`${identifier}-${activeTab}-tab`}>
      {activeTab === 'payments' && <><div className="ca-section-heading"><h4>Payment history</h4><p>Every receipt and payment, with its payer and accounting treatment.</p></div><div className="ca-record-list" aria-label="Company payment history">{paymentList.visibleItems.map(payment => {
        const advance = payment.treatment === 'Advance' && payment.direction === 'Received';
        const paymentApplications = (data.advanceApplications || []).filter(application => application.paymentId === payment.id && application.companyId === companyId);
        const applied = paymentApplications.reduce((total,application) => add(total,application.amount),'0.00');
        const linkedOrders = paymentApplications.map(application => { const order = data.shipments.find(item => item.id === application.shipmentId); return {id:application.id,label:order?.product || 'Sale',detail:application.shipmentId,amount:application.amount,date:application.date}; });
        const source = data.imports.find(statement => statement.id === payment.sourceRef);
        const remaining = advances.get(payment.id) || '0.00';
        return <article className="ca-record-card" key={payment.id} data-record-id={payment.id}><header><span className={`ca-record-icon ${payment.direction === 'Received' ? 'is-received' : 'is-paid'}`}>{payment.direction === 'Received' ? <ArrowDownLeft size={18}/> : <ArrowUpRight size={18}/>}</span><div><h5>{payment.treatment}</h5><p>{displayDate(payment.date)} · {payment.id}</p></div><span className={`ca-status ${payment.status === 'Allocated' ? 'is-approved' : 'is-review'}`}>{payment.status}</span></header><div className={`ca-payment-amount ${payment.direction === 'Received' ? 'is-received' : ''}`}><span>{payment.direction === 'Received' ? 'Money received' : 'Money paid'}</span><strong><AccountMoney value={`${payment.direction === 'Paid' ? '-' : ''}${payment.amount}`} currency={data.currency} signed/></strong></div><Metadata items={[["Actual payer / beneficiary",payment.actor],["Own cash / bank account",payment.account],["Reference / TID",payment.reference],["Source bank label",payment.bankLabel],["On behalf of",payment.onBehalfOf],["Supporting evidence",payment.evidence],["Notes",payment.notes],["Source statement",source?.fileKey ? <a href={`/api/files?key=${encodeURIComponent(source.fileKey)}`} target="_blank" rel="noreferrer">{source.name}<ArrowUpRight size={12}/></a> : payment.sourceRef],["Advance applied",advance ? <AccountMoney value={applied} currency={data.currency}/> : null],["Linked orders",advance && linkedOrders.length ? <AdvanceReferences entries={linkedOrders} currency={data.currency}/> : null],["Available advance",advance ? payment.status === 'Allocated' ? <AccountMoney value={remaining} currency={data.currency}/> : 'Awaiting allocation review' : null]]}/></article>;
      })}</div>{payments.length ? <InfiniteListFooter list={paymentList} label="company payments"/> : <EmptyState icon={<Wallet size={28}/>} title="No payments recorded">Record a payment or an advance for this company to start its payment history.</EmptyState>}</>}
      {activeTab === 'orders' && <><div className="ca-section-heading"><h4>Sales and advance coverage</h4><p>Advance coverage is shown per sale. Other receipts affect the account balance and are not assigned to individual sales here.</p></div><div className="ca-record-list" aria-label="Company sales">{orderList.visibleItems.map(order => {
        const coverage = shipmentAdvanceSummary(data,order.id);
        const receipts = (data.advanceApplications || []).filter(application => application.shipmentId === order.id && application.companyId === companyId).map(application => { const receipt = data.payments.find(item => item.id === application.paymentId); return {id:application.id,label:receipt?.reference || application.paymentId,detail:receipt?.reference ? application.paymentId : undefined,amount:application.amount,date:application.date}; });
        const complete = compare(coverage.outstanding,'0') === 0;
        return <article className="ca-record-card" key={order.id} data-record-id={order.id}><header><span className="ca-record-icon"><Truck size={18}/></span><div><h5>{order.product}</h5><p>{displayDate(order.date)} · {order.id}</p></div><span className={`ca-status ${complete ? 'is-approved' : ''}`}>{complete ? 'Advance covered' : order.status}</span></header><div className="ca-payment-amount"><span>Sale amount</span><strong><AccountMoney value={order.amount} currency={data.currency}/></strong></div><Metadata items={[["Vehicle",order.vehicle],["Delivery recipient",order.deliveryParty],["Quantity",order.weight ? `${order.weight} ${order.unit}` : null],["Advance applied",<AccountMoney key="applied" value={coverage.applied} currency={data.currency}/>],["Not covered by advance",<AccountMoney key="outstanding" value={coverage.outstanding} currency={data.currency}/>],["Advance receipt references",receipts.length ? <AdvanceReferences entries={receipts} currency={data.currency}/> : null]]}/>{!complete && <footer><button type="button" className="button button-secondary" disabled={!available || company.status !== 'Active'} onClick={() => onApplyAdvance(order.id)}>Apply advance<ArrowRight size={16}/></button>{!available && <small>No advance available. Record an advance first.</small>}</footer>}</article>;
      })}</div>{orders.length ? <InfiniteListFooter list={orderList} label="company sales"/> : <EmptyState icon={<Truck size={28}/>} title="No sales recorded">Record a sale for this company, then choose an available advance to apply.</EmptyState>}</>}
      {activeTab === 'statements' && <><div className="ca-section-heading"><h4>Source statements</h4><p>Original statements linked to this company and their review status.</p></div><div className="ca-record-list" aria-label="Company statements">{statementList.visibleItems.map(statement => <article className="ca-record-card ca-statement-card" key={statement.id} data-record-id={statement.id}><header><span className="ca-record-icon"><FileText size={18}/></span><div><h5>{statement.name}</h5><p>{displayDate(statement.createdAt)} · {statement.id}</p></div><span className={`ca-status ${statement.status === 'Posted' ? 'is-approved' : 'is-review'}`}>{statement.status === 'Posted' ? <><Check size={12}/>Posted</> : 'Needs review'}</span></header><Metadata items={[["Source rows",statement.rows.length],["Source closing balance",validMoney(statement.mapping.expectedClosing,true) ? <AccountMoney value={statement.mapping.expectedClosing} currency={statement.mapping.currency || data.currency}/> : 'Not recorded']]}/>{onReviewStatement && <footer><button type="button" className="button button-secondary" onClick={() => onReviewStatement(statement.id)}>Review statement<ArrowUpRight size={15}/></button></footer>}</article>)}</div>{statements.length ? <InfiniteListFooter list={statementList} label="company statements"/> : <EmptyState icon={<ReceiptText size={28}/>} title="No linked statements">Imported statements appear here when this company is their accounting counterparty.</EmptyState>}</>}
    </div>
    {company.aliases.length > 0 && <p className="ca-aliases"><b>Reviewed aliases</b>{company.aliases.join(', ')}</p>}
  </section>;
}
