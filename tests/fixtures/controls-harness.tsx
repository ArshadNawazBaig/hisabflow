// Isolated component QA only. This entry is never imported by the application.
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import HisabApp from '../../components/hisab/hisab-app';
import { AppSelect, AppDatePicker } from '../../components/hisab/controls';
import { AppCombobox } from '../../components/hisab/combobox';
import type { Workspace } from '../../lib/types';
import '../../app/globals.css';
import '../../app/typography.css';

const workspace: Workspace = {
  business:'Control QA workspace',currency:'PKR',openingCash:'0.00',audit:[],shipments:[],payments:[],
  companies:[{id:'QA-CUSTOMER',name:'QA Customer',role:'Customer',aliases:[],balance:'0.00',status:'Active'},{id:'QA-SUPPLIER',name:'QA Supplier',role:'Supplier',aliases:[],balance:'0.00',status:'Active'}],
  imports:[{id:'IMP-CONTROLS',name:'QA control statement.pdf',hash:'qa-control-hash',createdAt:'2026-11-01T10:00:00Z',status:'Draft',step:1,mapping:{business:'Control QA workspace',issuer:'QA issuer',counterpartyId:'',perspective:'',partyMeaning:'',currency:'PKR',unit:'Metric tonnes',unitsConfirmed:false,history:'',mode:'Transactions',cutoff:'',direction:'',openingBalance:'0.00',expectedClosing:'100.00'},rows:[{id:'ROW-CONTROLS',page:1,sequence:1,rawDate:'01-11-2026',proposedDate:'2026-11-01',effectiveDate:'',description:'QA material',party:'QA destination',vehicle:'QA-101',weight:'1.000',rate:'100.00',goods:'100.00',paid:'',balance:'100.00',reference:'QA-REF',kind:'goods',status:'Needs review',issues:[],raw:'QA original source row'}]}],
};
let stored=workspace, revision=1;
const nativeFetch=window.fetch.bind(window);
window.fetch=async(input,init)=>{
  const url=new URL(input instanceof Request?input.url:String(input),location.origin);
  if(url.pathname!=='/api/workspace')return nativeFetch(input,init);
  if(init?.method==='PUT'){stored=JSON.parse(String(init.body)).data;revision++;return Response.json({data:stored,revision});}
  return Response.json({data:stored,revision,storage:'isolated-test',user:{id:'QA-OWNER',name:'QA owner',email:'qa@example.invalid',provider:'google'}});
};

function ControlLab(){
  const [result,setResult]=useState('');
  return <main className="control-lab" style={{maxWidth:520,margin:'40px auto',padding:20}}>
    <h1>Custom control QA</h1>
    <form id="control-form" style={{display:'grid',gap:20,marginTop:24}} onSubmit={event=>{event.preventDefault();setResult(JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))));}}>
      <label className="field">Currency<AppSelect aria-label="Currency" name="currency" defaultValue="PKR" options={['PKR','USD','EUR'].map(value=>({value,label:value}))}/></label>
      <label className="field">Counterparty<AppSelect aria-label="Counterparty" name="party" defaultValue="" required options={[{value:'',label:'Choose a company'},{value:'alpha',label:'Alpha company'},{value:'beta',label:'Beta company'},{value:'disabled',label:'Disabled company',disabled:true}]}/></label>
      <label className="field">Delivery date<AppDatePicker aria-label="Delivery date" name="date" required defaultValue="2026-11-01" min="2026-10-01" max="2026-12-31"/></label>
      <label className="field">Own account<AppCombobox aria-label="Own account" name="account" required defaultValue="Business current" options={['Business current','Petty cash','Non-cash','Unassigned']}/></label>
      <label className="field">Disabled field<AppSelect aria-label="Disabled field" name="ignored" disabled defaultValue="PKR" options={[{value:'PKR',label:'PKR'}]}/></label>
      <div style={{display:'flex',gap:12}}><button type="submit" className="button button-primary">Save QA form</button><button type="reset" className="button button-secondary">Reset QA form</button></div>
    </form>
    <output id="form-result" style={{display:'block',overflowWrap:'anywhere',marginTop:24}}>{result}</output>
  </main>;
}

createRoot(document.getElementById('root')!).render(new URLSearchParams(location.search).get('view')==='workspace'?<HisabApp/>:<ControlLab/>);
