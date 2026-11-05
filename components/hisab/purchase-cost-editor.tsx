'use client';

import { useEffect, useEffectEvent, useId, useRef, useState } from 'react';
import { AlertCircle, ArrowUpRight, Check, CheckCircle2, Layers3, Loader2, Package, Plus, ReceiptText, X } from 'lucide-react';
import { type CostAllocation, type Shipment, type WorkspaceProps, money } from '@/lib/types';
import { add, compare, multiply, quantityAdd, quantityCompare, quantitySubtract } from '@/lib/accounting';
import { isAllocationQuantity, reviewPurchaseSources } from '@/lib/purchase-sources';
import { canonicalDeliveryUnit } from '@/lib/delivery-units';
import { AppSelect } from './controls';
import { Modal } from './modal';
import { InfiniteListFooter, useInfiniteList } from './infinite-list';
import './purchase-costs.css';

export type CostAllocationDraft = { picks: CostAllocation[]; evidence: string; reviewed: boolean };
type PurchaseCostEditorProps = WorkspaceProps & {
  sale: Shipment;
  draft?: CostAllocationDraft;
  onClose: () => void;
  onRecordPurchase: (draft: CostAllocationDraft) => void;
};
type SubmittedAllocation = { allocations: CostAllocation[]; evidence: string; confirmed: boolean };

function quantityLabel(value: string): string {
  if (!isAllocationQuantity(value)) return value;
  const [whole, fraction = ''] = value.split('.');
  return `${whole}.${fraction.replace(/0+$/, '').padEnd(3, '0')}`;
}
function dateLabel(value: string): string {
  return value ? new Date(`${value}T12:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : 'Date unresolved';
}
function allocationMatches(sale: Shipment | undefined, submitted: SubmittedAllocation): boolean {
  const allocations = sale?.costAllocations || [];
  return !!sale && !sale.matchConfirmed && !!sale.costAllocationConfirmed === submitted.confirmed
    && (sale.costAllocationEvidence || '') === submitted.evidence
    && allocations.length === submitted.allocations.length
    && allocations.every((allocation, index) => allocation.shipmentId === submitted.allocations[index].shipmentId
      && quantityCompare(allocation.weight, submitted.allocations[index].weight) === 0
      && compare(allocation.amount, submitted.allocations[index].amount) === 0);
}

/** Select real supplier receipts; customer advances are handled on the company account. */
export function PurchaseCostEditor({ sale: initialSale, draft, data, update, notify, saveState = 'saved', saveConflict = false, retrySave, onClose, onRecordPurchase }: PurchaseCostEditorProps) {
  const sale = data.shipments.find(item => item.id === initialSale.id) || initialSale;
  const [picks, setPicks] = useState<CostAllocation[]>(() => (draft?.picks || sale.costAllocations || []).map(pick => ({ ...pick })));
  const [evidence, setEvidence] = useState(draft?.evidence ?? sale.costAllocationEvidence ?? '');
  const [reviewed, setReviewed] = useState(draft?.reviewed ?? false);
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState<SubmittedAllocation | null>(null);
  const sourceRows = useRef<HTMLDivElement>(null);
  const pendingSourceFocus = useRef<number | null>(null);
  const reasonId = useId();
  const review = reviewPurchaseSources(data, sale);
  const sources = review.available;
  const blocked = useInfiniteList(review.excluded.map(item => ({ ...item, id: item.shipment.id })), sale.id);
  const busy = !!submitted;
  const knownSaleQuantity = isAllocationQuantity(sale.weight) && quantityCompare(sale.weight, '0') > 0;
  const assigned = picks.reduce((total, pick) => isAllocationQuantity(pick.weight) ? quantityAdd(total, pick.weight) : total, '0.000000');
  const allocatedCost = picks.reduce((total, pick) => {
    const source = sources.find(item => item.shipment.id === pick.shipmentId);
    return source && isAllocationQuantity(pick.weight) ? add(total, multiply(pick.weight, source.shipment.rate)) : total;
  }, '0.00');
  const full = knownSaleQuantity && quantityCompare(assigned, sale.weight) === 0;
  const unit = canonicalDeliveryUnit(sale.unit) || sale.unit;
  const companyName = (id: string) => data.companies.find(company => company.id === id)?.name || 'Company not recorded';
  const purchaseEvidence = (shipment: Shipment) => {
    if (!shipment.sourceRef && !shipment.attachment) return null;
    const batch = data.imports.find(item => item.id === shipment.sourceRef);
    return <div className="hf-purchase-evidence">
      {shipment.sourceRef && (batch?.fileKey
        ? <a className="hf-purchase-evidence-link" href={`/api/files?key=${encodeURIComponent(batch.fileKey)}`} target="_blank" rel="noreferrer"><span>{batch.name}</span><ArrowUpRight size={15}/></a>
        : <span>Source reference: {shipment.sourceRef}</span>)}
      {shipment.attachment && <a className="hf-purchase-evidence-link" href={`/api/files?key=${encodeURIComponent(shipment.attachment)}`} target="_blank" rel="noreferrer"><span>View purchase evidence</span><ArrowUpRight size={15}/></a>}
    </div>;
  };
  const rowIssue = (() => {
    const seen = new Set<string>();
    for (const [index, pick] of picks.entries()) {
      const source = sources.find(item => item.shipment.id === pick.shipmentId);
      if (!source) return `Select an available purchase receipt for source ${index + 1}.`;
      if (seen.has(pick.shipmentId)) return 'Choose each purchase receipt once; combine its allocated quantity in one row.';
      seen.add(pick.shipmentId);
      if (!isAllocationQuantity(pick.weight) || quantityCompare(pick.weight, '0') <= 0) return `Enter a positive quantity for purchase source ${index + 1}, with up to six decimal places.`;
      if (quantityCompare(pick.weight, source.available) > 0) return `${source.shipment.id} has only ${quantityLabel(source.available)} ${unit} available after other allocations.`;
    }
    return '';
  })();
  const draftIssue = sale.matchConfirmed ? 'Unlink the confirmed single-source match before allocating purchase costs.'
    : !knownSaleQuantity ? 'Record a positive sale quantity before allocating purchase costs.'
    : rowIssue || (quantityCompare(assigned, sale.weight) > 0 ? 'Allocated quantity cannot exceed the sale quantity.' : '');
  const confirmReason = draftIssue || (!picks.length ? sources.length ? 'Select a purchase receipt to start allocating costs.' : 'Record a matching purchase receipt, then select it for this sale.'
    : !full ? `Allocate the remaining ${quantityLabel(quantitySubtract(sale.weight, assigned))} ${unit} before confirming.`
    : !evidence.trim() ? 'Add relationship evidence or review notes before confirming.'
    : !reviewed ? 'Confirm that you have reviewed the purchase and sale relationships.' : '');

  const acknowledge = useEffectEvent(() => {
    if (!submitted) return;
    if (saveConflict && saveState === 'error') {
      setSubmitted(null); setReviewed(false);
      setError('The allocation was not saved. Review the latest purchase availability and confirm the relationships again.');
      return;
    }
    if (saveState === 'saved' && allocationMatches(data.shipments.find(item => item.id === sale.id), submitted)) {
      notify(submitted.confirmed ? 'Purchase costs confirmed and saved.' : submitted.allocations.length ? 'Allocation draft saved. Trading margin remains unresolved.' : 'Draft saved. No purchase costs are allocated.');
      onClose();
    }
  });
  // Optimistic workspace changes alone do not acknowledge a completed save.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { acknowledge(); }, [data.shipments, saveState, saveConflict, submitted]);

  useEffect(() => {
    const index = pendingSourceFocus.current;
    if (index === null) return;
    const frame = requestAnimationFrame(() => {
      const row = sourceRows.current?.querySelector<HTMLElement>(`[data-purchase-index="${index}"]`);
      if (!row) return;
      row.scrollIntoView({ block: 'start', behavior: 'instant' });
      row.querySelector<HTMLElement>('[role="combobox"]')?.focus({ preventScroll: true });
      pendingSourceFocus.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [picks.length]);

  const close = () => { if (!submitted || saveState === 'error') onClose(); };
  const recordPurchase = () => {
    if (busy) return;
    onRecordPurchase({ picks: picks.map(pick => ({ ...pick })), evidence, reviewed });
  };
  const selectPurchase = () => {
    if (busy || picks.length >= sources.length) return;
    pendingSourceFocus.current = picks.length;
    setPicks([...picks, { shipmentId: '', weight: '', amount: '' }]);
    setReviewed(false); setError('');
  };
  const patch = (index: number, field: 'shipmentId' | 'weight', value: string) => {
    setError(''); setReviewed(false);
    setPicks(previous => previous.map((pick, itemIndex) => {
      if (itemIndex !== index) return pick;
      const next = { ...pick, [field]: value };
      const source = sources.find(item => item.shipment.id === next.shipmentId);
      return { ...next, amount: source && isAllocationQuantity(next.weight) ? multiply(next.weight, source.shipment.rate) : '' };
    }));
  };
  const save = (confirmed: boolean) => {
    if (submitted) return;
    const issue = confirmed ? confirmReason : draftIssue || (!picks.length && !sale.costAllocations?.length ? 'Select a purchase receipt before saving an allocation draft.' : '');
    if (issue) { setError(issue); return; }
    const currentSale = data.shipments.find(item => item.id === sale.id);
    if (!currentSale) { setError('This sale is no longer available. Close this window and review the shipment register.'); return; }
    const allocations = picks.map(pick => ({ ...pick, amount: multiply(pick.weight, sources.find(item => item.shipment.id === pick.shipmentId)!.shipment.rate) }));
    const trimmedEvidence = evidence.trim();
    setError(''); setSubmitted({ allocations, evidence: trimmedEvidence, confirmed });
    update({ ...data, shipments: data.shipments.map(item => item.id === sale.id ? { ...currentSale, costAllocations: allocations, costAllocationConfirmed: confirmed, costAllocationEvidence: trimmedEvidence, matchConfirmed: false, matchedId: undefined } : item) },
      confirmed ? 'Purchase cost allocation confirmed' : 'Purchase cost allocation saved',
      `${sale.id} · ${allocations.length} purchase sources · ${quantityLabel(assigned)} ${unit} · ${confirmed ? 'full coverage reviewed' : 'draft; margin unresolved'}`);
  };

  return <Modal title="Allocate purchase costs" subtitle={`${sale.id} · ${quantityLabel(sale.weight)} ${unit}`} onClose={close} wide className="hf-purchase-cost-modal"
    footer={<div className="hf-purchase-footer">
      <p id={reasonId} className={confirmReason ? 'hf-purchase-confirm-reason' : 'hf-purchase-ready'}>{busy ? saveState === 'error' ? 'The allocation has not been saved. Retry to finish.' : 'Saving your purchase cost allocation…' : confirmReason || 'Full coverage reviewed. Ready to confirm purchase costs.'}</p>
      <div className="rv-form-actions">
        {!busy && !sources.length ? <>
          <button type="button" className="button button-secondary" onClick={close}>Cancel</button>
          <button type="button" className="button button-primary" onClick={recordPurchase}><Plus size={17}/>Record purchase receipt</button>
        </> : !busy && !picks.length ? <>
          <button type="button" className="button button-secondary" onClick={recordPurchase}><ReceiptText size={16}/>Record purchase receipt</button>
          <button type="button" className="button button-primary" onClick={selectPurchase}><Plus size={16}/>Select purchase receipt</button>
        </> : <>
        {submitted && saveState === 'error' && <button type="button" className="button button-secondary" onClick={close}>Close for now</button>}
        <button type="button" className="button button-secondary" disabled={busy || !!draftIssue || (!picks.length && !sale.costAllocations?.length)} onClick={() => save(false)}>Save allocation draft</button>
        {submitted && saveState === 'error' && !saveConflict && retrySave
          ? <button type="button" className="button button-primary" onClick={retrySave}>Retry save</button>
          : <button type="button" className="button button-primary" disabled={busy || !!confirmReason} aria-describedby={reasonId} onClick={() => save(true)}>{busy ? <Loader2 size={16} className="spin"/> : <Check size={16}/>} {busy ? 'Saving…' : 'Confirm purchase costs'}</button>}
        </>}
      </div>
    </div>}>
    <div className="hf-purchase-identity"><span><Package size={21}/></span><div><h3>{sale.product || 'Product not recorded'}</h3><p>Supplier purchase costs for this sale</p></div></div>
    <div className="rv-cost-overview"><div><span>Sale amount · {data.currency}</span><strong>{money(sale.amount, 2)}</strong></div><div><span>Allocated purchase costs · {data.currency}</span><strong>{money(allocatedCost, 2)}</strong></div><div><span>Quantity coverage</span><strong>{quantityLabel(assigned)} / {quantityLabel(sale.weight)} <small>{unit}</small></strong></div></div>
    <div className="hf-purchase-explanation"><Layers3 size={18}/><p>Link the actual supplier receipts that supplied this sale. Customer payments and advances are applied separately in the company account.</p></div>
    <dl className="hf-purchase-requirements" aria-label="Required purchase details"><div><dt>Product</dt><dd>{sale.product || 'Not recorded'}</dd></div><div><dt>Unit</dt><dd>{unit || 'Not recorded'}</dd></div><div><dt>Grade</dt><dd>{sale.grade || 'Any recorded grade'}</dd></div></dl>

    {!sources.length && <div className="hf-purchase-empty">
      <span><ReceiptText size={27}/></span><h3>{review.receiptsCount ? 'No compatible purchase receipts' : 'No purchases recorded'}</h3>
      <p>{review.receiptsCount ? 'Your recorded receipts cannot supply this sale yet. Review the reasons below or use Record purchase receipt below to add the actual purchase.' : 'Use Record purchase receipt below to record the supplier, quantity, and actual purchase rate. You can then allocate it to this sale.'}</p>
      <small>Your selected sources and review notes will be kept.</small>
    </div>}

    <div className="rv-cost-rows" ref={sourceRows}>{picks.map((pick, index) => {
      const source = sources.find(item => item.shipment.id === pick.shipmentId);
      const excluded = review.excluded.find(item => item.shipment.id === pick.shipmentId);
      return <section className="rv-cost-row" key={index} data-purchase-index={index} aria-label={`Purchase source allocation ${index + 1}`}>
        <div className="rv-cost-row-top"><span>Purchase source {index + 1}</span><button type="button" className="rv-icon-button" disabled={busy} aria-label={`Remove purchase source ${index + 1}`} onClick={() => { setPicks(picks.filter((_, i) => i !== index)); setReviewed(false); setError(''); }}><X size={17}/></button></div>
        <div className="rv-cost-row-fields">
          <label className="field rv-field"><span>Purchase receipt *</span><AppSelect aria-label={`Purchase source ${index + 1}`} value={pick.shipmentId} disabled={busy} onValueChange={value => patch(index, 'shipmentId', value)} options={[{ value: '', label: 'Select a purchase receipt' }, ...sources.filter(item => item.shipment.id === pick.shipmentId || !picks.some(other => other.shipmentId === item.shipment.id)).map(item => ({ value: item.shipment.id, label: `${item.shipment.id} · ${companyName(item.shipment.companyId)} · ${quantityLabel(item.available)} ${unit} available` })), ...(!source && pick.shipmentId ? [{ value: pick.shipmentId, label: `${pick.shipmentId} · Unavailable`, disabled: true }] : [])]}/></label>
          <label className="field rv-field"><span>Allocated quantity · {unit}</span><input aria-label={`Allocated quantity for purchase source ${index + 1}`} type="number" inputMode="decimal" min="0.000001" step="0.000001" max={source?.available} disabled={busy} value={pick.weight} onChange={event => patch(index, 'weight', event.target.value)} placeholder="0.000"/></label>
          <label className="field rv-field"><span>Allocated cost · {data.currency}</span><input aria-label={`Allocated cost for purchase source ${index + 1}`} readOnly value={source && isAllocationQuantity(pick.weight) ? multiply(pick.weight, source.shipment.rate) : ''} placeholder="From purchase rate"/></label>
        </div>
        {source && <div className="rv-cost-source-meta"><span>{dateLabel(source.shipment.date)} · {source.shipment.product} · {source.shipment.grade || 'No grade recorded'}</span><span>Available: <b>{quantityLabel(source.available)} {unit}</b> · Rate: {data.currency} {money(source.shipment.rate, 2)}</span>{purchaseEvidence(source.shipment)}</div>}
        {excluded && <p className="hf-purchase-row-error"><AlertCircle size={15}/>{excluded.reasons.join(' · ')}. Select another receipt or remove this source.</p>}
      </section>;
    })}</div>
    {!!sources.length && !!picks.length && <div className="hf-purchase-source-actions"><button type="button" className="button button-secondary" disabled={busy || picks.length >= sources.length} onClick={selectPurchase}><Plus size={16}/>Select purchase receipt</button><button type="button" className="button button-secondary" disabled={busy} onClick={recordPurchase}><ReceiptText size={16}/>Record purchase receipt</button></div>}

    <div className="hf-purchase-review">
      <label className="field rv-field"><span>Relationship evidence / review notes</span><textarea aria-label="Relationship evidence / review notes" rows={3} disabled={busy} value={evidence} onChange={event => { setEvidence(event.target.value); setError(''); }} placeholder="Describe the supplier invoices or other evidence linking these purchases to this sale."/></label>
      {!!picks.length && <label className="rv-checkbox rv-cost-confirm"><input type="checkbox" checked={reviewed} disabled={busy} onChange={event => setReviewed(event.target.checked)}/>I have reviewed the actual purchase/sale relationships and confirmed the accounting directions.</label>}
    </div>
    <p className={`rv-cost-coverage ${full ? 'complete' : ''}`}><span>{full ? <CheckCircle2 size={16}/> : <AlertCircle size={16}/>}</span>{full ? 'Full quantity coverage. Purchase costs require your evidence and review before confirmation.' : quantityCompare(assigned, '0') > 0 ? 'Partial quantity coverage. You can save a draft; trading margin remains unresolved.' : 'No purchase quantity allocated. Select a receipt before confirming costs.'}</p>
    {(error || (submitted && saveState === 'error')) && <p className="hf-purchase-error" role="alert">{error || 'The allocation could not be saved. Your draft is kept here. Retry the save to finish.'}</p>}

    {!!review.excluded.length && <section className="hf-purchase-unavailable" aria-label="Unavailable purchase receipts"><div className="hf-purchase-unavailable-heading"><h3>Unavailable purchase receipts</h3><span>{review.excluded.length}</span></div><p>These receipts are kept in your records. Their product, unit, rate, or remaining quantity prevents allocation to this sale.</p>{blocked.visibleItems.map(item => <article key={item.shipment.id} data-record-id={item.shipment.id}><div><b>{item.shipment.id}</b><span>{companyName(item.shipment.companyId)} · {dateLabel(item.shipment.date)}</span><span>{item.shipment.product || 'Product not recorded'} · {item.shipment.weight || 'Unknown quantity'} {item.shipment.unit}{item.shipment.grade ? ` · ${item.shipment.grade}` : ''}</span>{purchaseEvidence(item.shipment)}</div><ul>{item.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul></article>)}<InfiniteListFooter list={blocked} label="unavailable purchase receipts"/></section>}
  </Modal>;
}
