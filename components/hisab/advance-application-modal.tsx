'use client';

import { useEffect, useEffectEvent, useState, type FormEvent } from 'react';
import { Check, Wallet } from 'lucide-react';
import { type WorkspaceProps, money, today } from '@/lib/types';
import { add, compare } from '@/lib/accounting';
import { applyCompanyAdvance, availableCompanyAdvances, shipmentAdvanceSummary } from '@/lib/company-account';
import { Modal } from './modal';
import { InfiniteListFooter, useInfiniteList } from './infinite-list';
import './advance-payment.css';

export function AdvanceApplicationModal({ data, update, notify, saveState = 'saved', saveConflict = false, retrySave, shipmentId, onClose }: WorkspaceProps & { shipmentId:string; onClose:()=>void }) {
  const shipment=data.shipments.find(item=>item.id===shipmentId);
  const sources=availableCompanyAdvances(data,shipment?.companyId||'',today());
  const summary=shipmentAdvanceSummary(data,shipmentId);
  // The authoritative helper checks every source and the order again on submission.
  const maxAmount=(()=>{const sum=sources.reduce((total,item)=>add(total,item.available),'0.00');return compare(sum,summary.outstanding)<0?sum:summary.outstanding;})();
  const [amount,setAmount]=useState(maxAmount),[error,setError]=useState(''),[submitted,setSubmitted]=useState<string[]|null>(null);
  const list=useInfiniteList(sources,`${shipmentId}:${today()}`);
  const acknowledge=useEffectEvent(()=>{
    if(!submitted)return;
    if(saveConflict&&saveState==='error'){setSubmitted(null);setError('The allocation was not saved. Review the latest available advance and try again.');return;}
    if(saveState==='saved'&&submitted.every(id=>data.advanceApplications?.some(item=>item.id===id))){notify('Advance applied and saved.');onClose();}
  });
  // Only close after the server acknowledges every application in this action.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(()=>{acknowledge()},[data.advanceApplications,saveState,saveConflict,submitted]);
  const close=()=>{if(submitted&&saveState==='saving')return;onClose();};
  const submit=(event:FormEvent<HTMLFormElement>)=>{
    event.preventDefault();if(submitted)return;
    try{
      const next=applyCompanyAdvance(data,shipmentId,amount,today());
      const previous=new Set(data.advanceApplications?.map(item=>item.id)||[]);
      const ids=next.advanceApplications?.filter(item=>!previous.has(item.id)).map(item=>item.id)||[];
      setSubmitted(ids);setError('');update(next,'Customer advance applied',`${shipmentId} · ${amount} ${data.currency} · existing receipts applied without another cash movement`);
    }catch(reason){setError(reason instanceof Error?reason.message:'The advance could not be applied.');}
  };
  if(!shipment)return null;
  return <Modal title="Apply advance" subtitle="Use funds already received from this company." onClose={close} className="hf-advance-modal"
    formProps={{onSubmit:submit}}
    footer={<div className="rv-form-actions"><button type="button" className="button button-secondary" onClick={close} disabled={!!submitted&&saveState==='saving'}>Cancel</button>{submitted&&saveState==='error'&&!saveConflict?<button type="button" className="button button-primary" onClick={retrySave}>Retry save</button>:<button type="submit" className="button button-primary" disabled={!!submitted||compare(maxAmount,'0')<=0}><Check size={16}/>{submitted?'Saving…':'Apply advance'}</button>}</div>}>
    <div className="hf-advance-order"><Wallet size={21}/><div><b>{shipment.product}</b><span>{shipment.id} · {data.companies.find(item=>item.id===shipment.companyId)?.name}</span></div></div>
    <dl className="hf-advance-summary"><div><dt>Order amount</dt><dd>{data.currency} {money(shipment.amount,2)}</dd></div><div><dt>Advance already applied</dt><dd>{data.currency} {money(summary.applied,2)}</dd></div><div><dt>Not covered by advance</dt><dd>{data.currency} {money(summary.outstanding,2)}</dd></div><div><dt>Available to apply</dt><dd>{data.currency} {money(maxAmount,2)}</dd></div></dl>
    <label className="field">Advance to apply · {data.currency}<input aria-label="Advance to apply" type="number" inputMode="decimal" min="0.01" step="0.01" max={maxAmount} required value={amount} onChange={event=>setAmount(event.target.value)} disabled={!!submitted}/></label>
    {error&&<p className="hf-advance-error" role="alert">{error}</p>}
    <p className="hf-advance-note">This links existing advance receipts to this order. It does not record another payment or change cash. Other payments remain reflected in the company account balance.</p>
    <section aria-label="Available advance receipts" className="hf-advance-sources"><h3>Available advance receipts</h3>{list.visibleItems.map(item=><article key={item.payment.id} data-record-id={item.payment.id}><div><b>{item.payment.reference||item.payment.id}</b><span>{item.payment.date} · {item.payment.account}</span></div><strong>{data.currency} {money(item.available,2)}</strong></article>)}{!sources.length&&<p>No approved advance is available for this company.</p>}<InfiniteListFooter list={list} label="advance receipts"/></section>
  </Modal>;
}

