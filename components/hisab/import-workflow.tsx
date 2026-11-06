'use client';

import { cloneElement, isValidElement, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowDownToLine, ArrowLeft, ArrowRight, Check, CheckCheck, CheckCircle2, ChevronDown, ChevronRight, FileCheck2, FileText, Fingerprint, Info, Layers3, Loader2, LockKeyhole, Save, ScanLine, ShieldCheck, Trash2, Upload, X } from 'lucide-react';
import { money, uid, type ImportBatch, type ImportMapping, type SourceRow, type Treatment, type WorkspaceProps } from '@/lib/types';
import { extractLedgerText, extractPdf, fileHash, suggestedDate } from '@/lib/pdf-extract';
import { uploadPrivateFile } from '@/lib/private-file-upload';
import { reconcile, validateImport, postImport, multiply, add, subtract, validMoney, importDeletionReason } from '@/lib/accounting';
import { parseISODate } from '@/lib/control-dates';
import { AppSelect, AppDatePicker } from './controls';
import { PdfImportAssistant } from './pdf-import-assistant';
import { Modal } from './modal';
import { InfiniteListFooter, useInfiniteList } from './infinite-list';
import './imports.css';

const choiceOptions = (values: readonly string[]) => values.map(value=>({value,label:value}));
const steps = ['Upload', 'Map statement', 'Review rows', 'Reconcile', 'Preview & post'];
const treatments: Treatment[] = ['Supplier settlement','Customer receipt','Payment on behalf','Supplier-agreed deduction','Capitalized landed cost','Operating expense','Advance','Owner drawing','Other adjustment'];
const defaultMapping = (business:string,currency:string):ImportMapping => ({business,issuer:'',counterpartyId:'',perspective:'',partyMeaning:'',currency,unit:'Metric tonnes',unitsConfirmed:false,history:'',mode:'Transactions',cutoff:'',direction:'',openingBalance:'0.00',expectedClosing:''});
const equalAmounts=(left:string|undefined,right:string|undefined)=>!!left&&!!right&&validMoney(left,true)&&validMoney(right,true)&&subtract(left,right)==='0.00';
const sourceDate = (value:string) => value ? new Date(`${value}T00:00:00`).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}) : 'Not approved';

export function ImportWorkflow({ownerId,data,update,notify,saveState='saved',saveConflict=false,retrySave,reviewer='Workspace reviewer',requestedImportId,onRequestHandled}:WorkspaceProps & {reviewer?:string;requestedImportId?:string|null;onRequestHandled?:()=>void}) {
  const workspaceRef=useRef(data);useLayoutEffect(()=>{workspaceRef.current=data},[data]);
  const [batch,setBatch] = useState<ImportBatch|null>(null);
  const activeBatchId=batch?.id,activeBatchStep=batch?.step,activeBatchStatus=batch?.status;
  const stepperRef=useRef<HTMLElement>(null);
  // A new review screen starts at its heading rather than retaining the previous page's scroll.
  useLayoutEffect(()=>{
    window.scrollTo(0,0);
    const nav=stepperRef.current,current=nav?.querySelector<HTMLElement>('[aria-current=step]');
    if(nav&&current)nav.scrollLeft+=current.getBoundingClientRect().left-nav.getBoundingClientRect().left-(nav.clientWidth-current.clientWidth)/2;
  },[activeBatchId,activeBatchStep,activeBatchStatus]);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [paste,setPaste] = useState('');
  const [expanded,setExpanded] = useState<string|null>(null);
  const [filter,setFilter] = useState<'all'|'review'|'excluded'>('all');
  const [acknowledged,setAcknowledged] = useState(false);
  const [pendingPost,setPendingPost] = useState<string|null>(null);
  const [pendingOriginal,setPendingOriginal] = useState<File|null>(null);
  const [manualOpen,setManualOpen] = useState(false);
  const [textMode,setTextMode] = useState<'paste'|'file'>('paste');
  const [textFile,setTextFile] = useState<File|null>(null);
  const textFileInput = useRef<HTMLInputElement>(null);
  const [deleting,setDeleting] = useState<ImportBatch|null>(null);
  const [deletionRequested,setDeletionRequested] = useState(false);
  const [deleteError,setDeleteError] = useState('');
  const deleteTrigger = useRef<HTMLElement|null>(null);
  const historyHeading = useRef<HTMLHeadingElement>(null);
  const deletionReason = deleting ? importDeletionReason(data,deleting.id) : null;
  const statementList = useInfiniteList(data.imports,'statement-library');
  const reviewRows = batch?.rows.filter(row=>filter==='all'?row.kind!=='excluded':filter==='review'?row.status==='Needs review':row.kind==='excluded') || [];
  const reviewList = useInfiniteList(reviewRows,`review:${batch?.id||'none'}:${filter}`);
  const statementStatus = (item:ImportBatch) => <span className={`import-status ${item.status==='Posted'?'approved':'review'}`}>{item.status==='Posted'?<Check size={12}/>:<span className="import-dot"/>}{item.status==='Posted'?'Posted':'Needs review'}</span>;
  const statementActions = (item:ImportBatch) => <div className="import-table-actions"><button type="button" className="import-link" onClick={()=>{setBatch(item);setError('');setAcknowledged(false);}}>{item.status==='Posted'?'View import':'Continue review'}<ArrowRight size={14}/></button><button type="button" className="button import-delete-action" aria-label={`Delete ${item.name}`} onClick={event=>{deleteTrigger.current=event.currentTarget;setDeleting(item);setDeletionRequested(false);setDeleteError('');}}><Trash2 size={15}/>Delete</button></div>;

  const closeDelete=()=>{if(deletionRequested&&saveState==='saving')return;setDeleting(null);setDeletionRequested(false);setDeleteError('');};
  const deleteStatement=()=>{
    if(!deleting||deletionRequested)return;
    const current=workspaceRef.current,reason=importDeletionReason(current,deleting.id);
    if(reason){setDeleteError(reason);return;}
    setDeletionRequested(true);setDeleteError('');
    update({...current,imports:current.imports.filter(item=>item.id!==deleting.id)},'Statement draft deleted',`${deleting.name} · ${deleting.id}`);
  };
  const acknowledgeDeletion=useEffectEvent(()=>{
    if(!deleting||!deletionRequested)return;
    if(saveConflict&&saveState==='error'){setDeletionRequested(false);setDeleteError('The statement could not be deleted. Review the latest records before trying again.');return;}
    if(saveState==='saved'&&!data.imports.some(item=>item.id===deleting.id)){
      notify(`${deleting.name} deleted`);setDeleting(null);setDeletionRequested(false);
      requestAnimationFrame(()=>historyHeading.current?.focus());
    }
  });
  // A deletion is complete only after the parent confirms the server save.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(()=>{acknowledgeDeletion()},[data.imports,deleting,deletionRequested,saveConflict,saveState]);
  const openReview=(next:ImportBatch)=>{const current=workspaceRef.current.imports.find(item=>item.id===next.id);if(!current){notify('This statement is no longer in the library. Upload it again to start a new review.');return;}setBatch(current);setFilter(current.rows.some(row=>row.status==='Needs review')?'review':'all');setExpanded(current.rows.find(row=>row.status==='Needs review')?.id||null);setAcknowledged(false);setError('');};
  const handleReviewRequest=useEffectEvent(()=>{if(!requestedImportId)return;const found=data.imports.find(item=>item.id===requestedImportId);if(found){setBatch(found);setFilter('review');setExpanded(found.rows.find(row=>row.status==='Needs review')?.id||null);setAcknowledged(false);setError('');}onRequestHandled?.();});
  // A cross-view review request opens the corresponding local editor.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(()=>{handleReviewRequest()},[requestedImportId,data.imports]);
  const reconcilePostedBatch=useEffectEvent(()=> {
    if(batch?.status==='Posted') {
      const current=data.imports.find(item=>item.id===batch.id);
      if(current && current.status!=='Posted') setBatch(current);
    }
  });
  // A rejected save replaces an optimistic posting with the durable server draft.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(()=>{reconcilePostedBatch()},[data.imports,batch?.id,batch?.status]);
  const acknowledgePost=useEffectEvent(()=>{if(!pendingPost)return;if(saveConflict&&saveState==='error'){setPendingPost(null);setError('The change could not be saved. Review the current statement and resolve the save error before confirming again.');return;}if(saveState==='saved'){const saved=data.imports.find(item=>item.id===pendingPost&&item.status==='Posted');if(saved){setBatch(saved);setPendingPost(null);notify('Statement imported and saved.');}}});
  // Report posting success only after the parent confirms durable persistence.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(()=>{acknowledgePost()},[pendingPost,saveState,saveConflict,data.imports]);
  const reviewed=batch?.rows.filter(row=>row.status==='Approved').length || 0;
  const activeRows=batch?.rows.filter(row=>row.kind!=='excluded') || [];
  const step=batch?.step || 0;
  let summary:ReturnType<typeof reconcile>|null=null;
  try {if(batch) summary=reconcile(batch.rows,batch.mapping.openingBalance || '0');} catch {/* Incomplete normalized inputs remain visible for correction. */}
  const company=(id:string)=>data.companies.find(company=>company.id===id)?.name || 'Unallocated';

  const saveBatch=(next:ImportBatch,action='Import draft saved')=> {
    if(pendingPost)return;
    const current=workspaceRef.current;const exists=current.imports.some(item=>item.id===next.id);
    update({...current,imports:exists?current.imports.map(item=>item.id===next.id?next:item):[next,...current.imports]},action,next.name);
  };
  const patch=(values:Partial<ImportBatch>)=>batch && setBatch({...batch,...values});
  const mapping=(values:Partial<ImportMapping>)=>batch && patch({mapping:{...batch.mapping,...values}});
  const patchRow=(id:string,values:Partial<SourceRow>)=>batch && patch({rows:batch.rows.map(row=>row.id===id?{...row,...values,status:values.status || (row.kind==='excluded'?'Excluded':'Needs review')}:row)});

  async function begin(file:File) {
    setBusy(true);setError('');
    try {
      if(!file.size) throw new Error('Choose a non-empty source statement.');
      if(file.size>20*1024*1024) throw new Error('Please use a statement smaller than 20 MB.');
      if(!/\.(pdf|txt|csv)$/i.test(file.name)) throw new Error('Choose a PDF statement or a reviewed text transcription.');
      const sourceFile=!file.name.toLowerCase().endsWith('.pdf') && pendingOriginal ? pendingOriginal : file;
      const hash=await fileHash(sourceFile);
      const existing=workspaceRef.current.imports.find(item=>item.hash===hash);
      if(existing&&(existing.fileKey||existing.status==='Posted')) {setManualOpen(false);setBatch(existing);notify(`This source already has a ${existing.status.toLowerCase()} import. Opened the existing batch.`);return;}
      let fileKey:string|undefined;
      try {
        const payload=await uploadPrivateFile(sourceFile,ownerId);
        if(payload.key && (!payload.hash || payload.hash===hash)) fileKey=payload.key;
        else notify('The original file is not yet saved to your private workspace. Posting will remain blocked.');
      } catch { notify('Your original file has not yet been saved. Posting will remain blocked.'); }
      if(existing){setManualOpen(false);const retained={...existing,fileKey};setBatch(retained);setPendingOriginal(fileKey?null:sourceFile);if(fileKey){saveBatch(retained,'Statement original retained');notify('Original source retained. Continue reviewing the existing draft.');}return;}
      if(file.name.toLowerCase().endsWith('.pdf')) setPendingOriginal(file);
      const extracted=!file.name.toLowerCase().endsWith('.pdf') ? extractLedgerText(await file.text()) : await extractPdf(file);
      const next:ImportBatch={id:uid('IMP'),name:sourceFile.name,hash,createdAt:new Date().toISOString(),status:'Draft',step:1,mapping:defaultMapping(workspaceRef.current.business,workspaceRef.current.currency),rows:extracted.rows,fileKey};
      setBatch(next);setManualOpen(false);setPaste('');setTextFile(null);setAcknowledged(false);setPendingOriginal(fileKey?null:sourceFile);
      if(extracted.rows.every(row=>row.kind==='excluded')) setError('No transaction amounts were recognized. Review the delimited column order and edit the source rows.');
      saveBatch(next,'Statement extracted');
    } catch(cause) {setError(cause instanceof Error?cause.message:'The statement could not be read.');}
    finally {setBusy(false);}
  }

  const mappingErrors=()=> {
    if(!batch) return [];
    const m=batch.mapping;
    return [!m.business&&'Select your business.',!m.issuer.trim()&&'Enter the statement issuer.',!m.counterpartyId&&'Select the accounting counterparty.',!m.perspective&&'Confirm the source statement perspective.',!m.partyMeaning&&'Confirm what the PARTY column means.',(!m.currency || !m.unit || !m.unitsConfirmed)&&'Confirm currency and quantity unit.',!m.history&&'Confirm whether this is complete or partial history.',!m.direction&&'Confirm the accounting direction of goods.',m.mode==='Opening balance'&&!m.cutoff&&'Choose an opening-balance cutoff.'].filter(Boolean) as string[];
  };
  function next() {
    if(!batch) return;
    if(step===1 && mappingErrors().length) {setError(mappingErrors().join(' '));return;}
    if(step===2 && activeRows.some(row=>row.status!=='Approved')) {setError('Review each transaction row before reconciliation. Exclude only rows that are not transactions.');return;}
    setError('');const next={...batch,step:Math.min(4,step+1)};setBatch(next);saveBatch(next);
  }
  function approveRow(row:SourceRow) {
    if(row.kind==='excluded') return;
    if(!parseISODate(row.effectiveDate || row.proposedDate)) {setError('Choose an approved effective date for this row. The original date will remain unchanged.');return;}
    if(row.kind==='payment' && (!row.treatment || !row.actor?.trim() || !row.companyId)) {setError('Select an accounting treatment, actual payer or beneficiary, and an allocation before approving a payment.');return;}
    if(row.kind==='goods' && (!row.goods || !row.weight || !row.rate)) {setError('Check the quantity, rate, and goods amount before approval.');return;}
    try {if(row.kind==='goods' && multiply(row.weight,row.rate)!==add(row.goods,'0')) {setError('Quantity × rate does not match the source amount. Correct the suggested extraction or keep the row in review.');return;}} catch {setError('Check the quantity and rate: enter valid decimal values before approving.');return;}
    patchRow(row.id,{status:'Approved',effectiveDate:row.effectiveDate || row.proposedDate,reviewer,reviewedAt:new Date().toISOString()});setError('');
  }
  function post() {
    if(!batch || !acknowledged || pendingPost) return;
    try {
      const errors=validateImport(batch,data);
      if(errors.length) throw new Error(errors.join(' '));
      const next=postImport(batch,data,reviewer);
      update(next,'Statement imported',`${batch.name}; source ${batch.hash.slice(0,12)}`);
      setPendingPost(batch.id);setError('');
    } catch(cause) {setError(cause instanceof Error?cause.message:'Import validation failed. No records were posted.');}
  }

  if(!batch) return <div className="imports-home">
    <div className="import-page-heading"><div><h2>Statement library</h2><p className="muted">Upload PDFs to prepare company records and transactions automatically.</p></div><span className="import-private"><LockKeyhole size={14}/> Private workspace</span></div>
    <div className="import-stats"><div><span className="import-stat-icon"><FileCheck2 size={20}/></span><p>Posted statements<strong>{data.imports.filter(item=>item.status==='Posted').length.toString().padStart(2,'0')}</strong></p></div><div><span className="import-stat-icon amber"><ScanLine size={20}/></span><p>Drafts to review<strong>{data.imports.filter(item=>item.status==='Draft').length.toString().padStart(2,'0')}</strong></p></div><div><span className="import-stat-icon"><ShieldCheck size={20}/></span><p>Transactions loaded<strong>{data.imports.reduce((count,item)=>count+item.rows.filter(row=>row.kind!=='excluded').length,0)}</strong></p></div></div>
    <PdfImportAssistant ownerId={ownerId} data={data} update={update} notify={notify} saveState={saveState} saveConflict={saveConflict} retrySave={retrySave} reviewer={reviewer} onReview={openReview}/>
    <div className="import-text-card"><span className="import-text-card-icon"><FileText size={21}/></span><div><h3>Text &amp; CSV statements</h3><p>Upload a file or paste reviewed ledger rows.</p></div><button type="button" className="button button-secondary" onClick={()=>{setManualOpen(true);setError('');}}>Import text or CSV<ArrowRight size={15}/></button></div>
    {error&&!manualOpen&&<div className="import-error" role="alert"><AlertCircle size={18}/>{error}</div>}
    <div className="import-how"><span><span>1</span> Upload PDFs</span><ChevronRight size={16}/><span><span>2</span> Confirm company details</span><ChevronRight size={16}/><span><span>3</span> Import and review exceptions</span></div>
    <section className="panel import-history" aria-busy={statementList.loading}><div className="import-section-heading"><div><h3 ref={historyHeading} tabIndex={-1}>Statement imports</h3><p className="muted">A complete trail from the original file to your books.</p></div><span className="badge">{data.imports.length} statements</span></div>{data.imports.length?<><div className="import-table-scroll hf-desktop-only"><table className="import-table"><thead><tr><th>Source document</th><th>Uploaded</th><th>Transactions</th><th>Status</th><th>Actions</th></tr></thead><tbody>{statementList.visibleItems.map(item=><tr key={item.id}><td><span className="import-file-cell"><FileText size={19}/><span><strong>{item.name}</strong><small>{item.id} · {item.hash.slice(0,10)}</small></span></span></td><td>{new Date(item.createdAt).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})}</td><td>{item.rows.filter(row=>row.kind!=='excluded').length} rows</td><td>{statementStatus(item)}</td><td>{statementActions(item)}</td></tr>)}</tbody></table></div><div className="hf-record-cards hf-mobile-only import-statement-cards" role="list" aria-label="Statement imports">{statementList.visibleItems.map(item=><article key={item.id} role="listitem" className="hf-record-card import-statement-card" data-testid="import-card" data-record-id={item.id}><header className="hf-record-card-header"><span className="import-card-file-icon"><FileText size={20}/></span><div className="hf-record-card-title"><h4>{item.name}</h4><p className="hf-record-card-subtitle">{item.id}</p></div>{statementStatus(item)}</header><dl className="hf-record-card-meta"><div><dt>Uploaded</dt><dd>{new Date(item.createdAt).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})}</dd></div><div><dt>Transactions</dt><dd>{item.rows.filter(row=>row.kind!=='excluded').length} rows</dd></div><div><dt>Source hash</dt><dd className="import-card-hash">{item.hash.slice(0,12)}</dd></div></dl><footer className="hf-record-card-actions">{statementActions(item)}</footer></article>)}</div><InfiniteListFooter list={statementList} label="statements"/></>:<div className="import-empty"><Layers3 size={24}/><p>Your statement library is ready.<br/><span>Upload a source to start your first review.</span></p></div>}</section>
    {manualOpen&&<Modal title="Import text or CSV" subtitle="Prepare a statement from a file or reviewed text." wide className="import-text-modal" onClose={()=>{if(!busy)setManualOpen(false);}}
      formProps={{onSubmit:event=>{event.preventDefault();const file=textMode==='file'?textFile:new File([paste],'Transcribed statement.txt',{type:'text/plain'});if(file)void begin(file);}}}
      footer={<div className="rv-form-actions"><button type="button" className="button button-secondary" disabled={busy} onClick={()=>setManualOpen(false)}>Cancel</button><button type="submit" className="button button-primary" disabled={busy||(textMode==='paste'?!paste.trim():!textFile)}>{busy?<><Loader2 size={16} className="spin"/>Preparing statement…</>:<>{textMode==='paste'?'Extract pasted statement':'Extract selected file'}<ArrowRight size={15}/></>}</button></div>}>
      <div className="import-method-tabs" role="tablist" aria-label="Text import method" onKeyDown={event=>{if(busy||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const mode=event.key==='Home'?'paste':event.key==='End'?'file':textMode==='paste'?'file':'paste';setTextMode(mode);setError('');document.getElementById(mode==='paste'?'import-paste-tab':'import-file-tab')?.focus();}}><button type="button" id="import-paste-tab" role="tab" disabled={busy} tabIndex={textMode==='paste'?0:-1} aria-selected={textMode==='paste'} aria-controls="import-text-panel" onClick={()=>{setTextMode('paste');setError('');}}>Paste text</button><button type="button" id="import-file-tab" role="tab" disabled={busy} tabIndex={textMode==='file'?0:-1} aria-selected={textMode==='file'} aria-controls="import-text-panel" onClick={()=>{setTextMode('file');setError('');}}>Upload file</button></div>
      <div id="import-text-panel" role="tabpanel" aria-labelledby={textMode==='paste'?'import-paste-tab':'import-file-tab'}>
        {textMode==='paste'?<div className="import-paste"><label>Statement text<textarea aria-label="Statement text" disabled={busy} value={paste} onChange={event=>setPaste(event.target.value)} placeholder="DATE | DESCRIPTIONS | PARTY | VEH. # | WEIGHT | RATE | TOTAL | PAID | PAYABLE | TID #" rows={9}/></label><p className="import-text-hint">Paste CSV, tab-separated, or | separated columns. Original values stay available during review.</p></div>:<div className="import-text-file"><button type="button" className="import-text-dropzone" onClick={()=>textFileInput.current?.click()} disabled={busy}><Upload size={28}/><strong>{textFile?.name||'Choose a CSV or text file'}</strong><span>{textFile?`${(textFile.size/1024).toFixed(1)} KB · Click to choose another file`:'CSV or TXT · Up to 20 MB'}</span></button><input ref={textFileInput} name="statement" type="file" hidden disabled={busy} aria-label="CSV or text statement" accept=".csv,.txt,text/csv,text/plain" onChange={event=>{setTextFile(event.target.files?.[0]||null);setError('');}}/><p className="import-text-hint">Your file will be retained privately before the extracted rows enter review.</p></div>}
      </div>
      {error&&<div className="import-error" role="alert"><AlertCircle size={18}/><span>{error}</span></div>}
    </Modal>}
    {deleting&&<Modal title="Delete statement" subtitle={deleting.name} onClose={closeDelete} restoreFocusRef={deleteTrigger}
      footer={<div className="rv-form-actions"><button type="button" className="button button-secondary" disabled={deletionRequested&&saveState==='saving'} onClick={closeDelete}>{deletionRequested||deletionReason?'Close':'Cancel'}</button>{deletionRequested&&saveState==='error'&&retrySave?<button type="button" className="button button-primary" onClick={retrySave}>Retry save</button>:<button type="button" className="button import-confirm-delete" disabled={!!deletionReason||deletionRequested} onClick={deleteStatement}><Trash2 size={16}/>Delete statement</button>}</div>}>
      {deletionRequested?<p className="import-delete-description" role="status">{saveState==='error'?'The deletion has not been saved. Retry to finish removing this draft.':'Deleting statement…'}</p>:deletionReason?<div className="import-delete-restriction"><ShieldCheck size={21}/><p>{deletionReason}</p></div>:<div className="import-delete-description"><p>Delete <strong>{deleting.name}</strong> and its draft review?</p><p>This statement has not posted any transactions. Your companies, deliveries, payments, and original source file will be kept.</p></div>}
      {deleteError&&<div className="import-error" role="alert"><AlertCircle size={18}/><span>{deleteError}</span></div>}
    </Modal>}
  </div>;

  if(batch.status==='Posted') return <div className="import-posted"><button className="import-back" onClick={()=>setBatch(null)}><ArrowLeft size={16}/> All statements</button><div className="panel import-success"><span className="import-success-icon"><CheckCheck size={34}/></span><span className="eyebrow">REVIEW COMPLETE</span><h2>Statement imported</h2><p>{batch.name} has been reviewed and added to the books.<br/>Every imported record retains its source reference.</p><div className="import-success-stats"><span><strong>{batch.postedRecordIds?.length || activeRows.length}</strong>Linked records</span><span><strong>{batch.mapping.currency} {money(summary?.closing || 0,2)}</strong>Source closing balance</span></div><div className="import-inline-note"><Fingerprint size={16}/><code>{batch.hash.slice(0,32)}…</code></div><div className="import-success-actions"><button className="button button-primary" onClick={()=>setBatch(null)}>Back to statements <ArrowRight size={15}/></button>{batch.fileKey&&<a className="button button-secondary" href={`/api/files?key=${encodeURIComponent(batch.fileKey)}`} target="_blank" rel="noreferrer"><ArrowDownToLine size={15}/> Original source</a>}</div></div><SourceTable rows={batch.rows} opening={batch.mapping.openingBalance}/></div>;

  const visible=reviewRows;
  const errors=step===4?validateImport(batch,data):[];
  return <div className="import-workflow"><div className="import-workflow-heading"><button className="import-back" onClick={()=>{saveBatch(batch);setBatch(null);setError('');}}><ArrowLeft size={16}/> All statements</button><button className="button button-secondary" disabled={!!pendingPost} onClick={()=>{saveBatch(batch);notify('Saving the draft. Wait for the saved status before leaving.');}}><Save size={14}/> Save draft</button></div>
    <div className="import-document-heading"><span className="import-document-icon"><FileText size={23}/></span><div><h2>{batch.name}</h2><p>{batch.id} <span>·</span> {activeRows.length} transaction rows <span>·</span> Source order preserved</p></div><span className="import-status review"><span className="import-dot"/>Draft</span></div>
    <nav ref={stepperRef} className="import-stepper" aria-label="Import progress">{steps.map((label,index)=><button key={label} aria-current={index===step?'step':undefined} disabled={!!pendingPost || index===0 || index>step} className={`${index===step?'current':''} ${index<step?'complete':''}`} onClick={()=>{patch({step:index});setError('');}}><span>{index<step?<Check size={14}/>:index+1}</span><strong>{label}</strong>{index<steps.length-1&&<ChevronRight size={16}/>}</button>)}</nav>
    {!batch.fileKey&&pendingOriginal&&<div className="import-info"><AlertCircle size={17}/><p>The original source has not been retained. Retry before posting.</p><button type="button" className="button button-secondary" disabled={busy} onClick={()=>void begin(pendingOriginal)}>{busy?'Retaining original…':'Retry retaining original'}</button></div>}
    {error&&<div className="import-error" role="alert"><AlertCircle size={18}/><span>{error}</span><button onClick={()=>setError('')} aria-label="Dismiss error"><X size={15}/></button></div>}
    {pendingPost&&<div className="import-info" role={saveState==='error'?'alert':'status'}><Loader2 size={17} className="spin"/><p>{saveState==='error'?'The statement has not been saved. Retry the save before leaving this page.':'Saving the reviewed statement…'}</p>{saveState==='error'&&retrySave&&<button className="button button-secondary" onClick={retrySave}>Retry save</button>}</div>}

    {step===1&&<div className="panel import-map"><div className="import-section-heading"><div><span className="eyebrow">STEP 02 / UNDERSTAND THE STATEMENT</span><h3>Whose perspective is this?</h3><p className="muted">A statement title doesn’t establish who owes whom. Make the accounting direction explicit.</p></div><span className="import-round-icon"><Layers3 size={22}/></span></div><ColumnMapping batch={batch} onChange={rows=>patch({rows})}/><div className="import-form-grid"><Field label="Your selected business"><input value={batch.mapping.business} onChange={e=>mapping({business:e.target.value})}/></Field><Field label="Source statement issuer"><input value={batch.mapping.issuer} onChange={e=>mapping({issuer:e.target.value})} placeholder="Who prepared this statement?"/></Field><Field label="Accounting counterparty"><AppSelect value={batch.mapping.counterpartyId} onValueChange={value=>mapping({counterpartyId:value})} options={[{value:'',label:'Select a reviewed company'},...data.companies.map(company=>({value:company.id,label:company.name}))]}/></Field><Field label="Source statement perspective"><AppSelect value={batch.mapping.perspective} onValueChange={value=>mapping({perspective:value as ImportMapping['perspective']})} options={[{value:'',label:'Confirm the source perspective'},...choiceOptions(['Own books','Supplier statement','Customer statement','Third-party statement'])]}/></Field><Field label="Meaning of the PARTY column"><AppSelect value={batch.mapping.partyMeaning} onValueChange={value=>mapping({partyMeaning:value})} options={[{value:'',label:'Choose the role in this document'},...choiceOptions(['Delivery recipient or destination','Accounting counterparty','Payment actor','Other — review each row'])]}/></Field><Field label="Goods direction in your books"><AppSelect value={batch.mapping.direction} onValueChange={value=>mapping({direction:value as ImportMapping['direction']})} options={[{value:'',label:'Confirm receipt or dispatch'},{value:'Receipt',label:'Receipt — purchases from counterparty'},{value:'Dispatch',label:'Dispatch — sales to counterparty'}]}/></Field><Field label="Currency"><AppSelect value={batch.mapping.currency} onValueChange={value=>mapping({currency:value,unitsConfirmed:false})} options={choiceOptions(['PKR','USD','AED','GBP','EUR'])}/></Field><Field label="Quantity / weight unit"><AppSelect value={batch.mapping.unit} onValueChange={value=>mapping({unit:value,unitsConfirmed:false})} options={choiceOptions(['Metric tonnes','Kilograms','Units','Other'])}/></Field></div><label className="import-confirm-units"><input type="checkbox" checked={batch.mapping.unitsConfirmed} onChange={e=>mapping({unitsConfirmed:e.target.checked})}/><span>I have confirmed the currency and quantity unit with supporting evidence.<small>The workspace currency and metric tonnes are suggestions. The source may not state these.</small></span></label><div className="import-map-divider"/><div className="import-form-grid"><Field label="History coverage"><AppSelect value={batch.mapping.history} onValueChange={value=>mapping({history:value as ImportMapping['history']})} options={[{value:'',label:'Confirm statement coverage'},...choiceOptions(['Complete history','Partial history'])]}/></Field><Field label="Import method"><AppSelect value={batch.mapping.mode} onValueChange={value=>mapping({mode:value as ImportMapping['mode']})} options={[{value:'Transactions',label:'Reviewed historical transactions'},{value:'Opening balance',label:'Opening balance at an agreed cutoff'}]}/></Field><Field label="Source opening balance"><input inputMode="decimal" value={batch.mapping.openingBalance} onChange={e=>mapping({openingBalance:e.target.value})}/></Field><Field label="Printed source closing balance"><input inputMode="decimal" value={batch.mapping.expectedClosing} onChange={e=>mapping({expectedClosing:e.target.value})} placeholder="Enter the printed closing total"/></Field>{batch.mapping.mode==='Opening balance'&&<Field label="Approved opening-balance cutoff"><AppDatePicker value={batch.mapping.cutoff} onValueChange={value=>mapping({cutoff:value})}/></Field>}</div><div className="import-info"><Info size={17}/><p>Goods and payment columns are extracted as source values. Their ownership and treatment are established only by your review. You can correct normalized column values in the next step; raw text stays intact.</p></div><div className="import-column-chips">{['Date','Description','Party','Vehicle','Weight','Rate','Goods total','Paid / received','Balance','Reference'].map(label=><span key={label}><Check size={11}/>{label}</span>)}</div></div>}

    {step===2&&<div className="panel import-review"><div className="import-section-heading"><div><span className="eyebrow">STEP 03 / KEEP THE DETAILS HONEST</span><h3>A human check, row by row.</h3><p className="muted">Approve effective dates, accounting allocations, and any exceptions.</p></div><span className="import-reviewed-count"><CheckCircle2 size={16}/>{reviewed} of {activeRows.length} reviewed</span></div><div className="import-review-toolbar"><div className="import-tabs"><button className={filter==='all'?'active':''} onClick={()=>setFilter('all')}>Transactions <span>{activeRows.length}</span></button><button className={filter==='review'?'active':''} onClick={()=>setFilter('review')}>Needs review <span>{activeRows.length-reviewed}</span></button><button className={filter==='excluded'?'active':''} onClick={()=>setFilter('excluded')}>Excluded <span>{batch.rows.length-activeRows.length}</span></button></div><span className="muted">Printed source order</span></div><div className="import-row-list" aria-busy={reviewList.loading}>{reviewList.visibleItems.map(row=><div className={`import-row ${row.status==='Approved'?'is-approved':''}`} key={row.id}><button className="import-row-summary" aria-expanded={expanded===row.id} onClick={()=>setExpanded(expanded===row.id?null:row.id)}><span className={`import-row-kind ${row.kind}`}>{row.kind==='payment'?<ArrowDownToLine size={17}/>:row.kind==='excluded'?<X size={17}/>:<Layers3 size={17}/>}</span><span className="import-row-main"><strong>{row.description || row.party || (row.kind==='excluded'?'Header / statement total':'Unidentified source row')}</strong><small>Page {row.page} · Row {row.sequence} <span>·</span> {row.rawDate || 'Undated'} {row.vehicle&&<><span>·</span>{row.vehicle}</>}</small></span><span className="import-row-amount">{batch.mapping.currency} {money(row.kind==='payment'?row.paid:row.goods,2)}<small>{row.kind==='payment'?'Source payment':row.kind==='goods'?'Source goods amount':'Excluded from transactions'}</small></span><span className={`import-status ${row.status==='Approved'?'approved':row.status==='Excluded'?'excluded':'review'}`}>{row.status==='Approved'?<Check size={12}/>:<span className="import-dot"/>}{row.status}</span>{expanded===row.id?<ChevronDown size={17}/>:<ChevronRight size={17}/>}</button>{expanded===row.id&&<div className="import-row-details">{row.issues.length>0&&<div className="import-row-issues">{row.issues.map(issue=><span key={issue}><AlertCircle size={14}/>{issue}</span>)}</div>}<div className="import-form-grid"><Field label="Original source date"><input value={row.rawDate} readOnly className="source-value"/></Field><Field label="Approve effective date"><AppDatePicker value={row.effectiveDate || row.proposedDate} onValueChange={value=>patchRow(row.id,{effectiveDate:value})}/></Field><Field label="Delivery party / source party"><input value={row.party} onChange={e=>patchRow(row.id,{party:e.target.value})}/></Field><Field label="Vehicle (not a unique identifier)"><input value={row.vehicle} onChange={e=>patchRow(row.id,{vehicle:e.target.value})}/></Field>{row.kind==='goods'?<><Field label={`Quantity · ${batch.mapping.unit}`}><input inputMode="decimal" value={row.weight} onChange={e=>patchRow(row.id,{weight:e.target.value})}/></Field><Field label={`Rate · ${batch.mapping.currency}`}><input inputMode="decimal" value={row.rate} onChange={e=>patchRow(row.id,{rate:e.target.value})}/></Field><Field label="Source goods amount"><input inputMode="decimal" value={row.goods} onChange={e=>patchRow(row.id,{goods:e.target.value})}/></Field></>:<><Field label="Source payment amount"><input inputMode="decimal" value={row.paid} onChange={e=>patchRow(row.id,{paid:e.target.value})}/></Field><Field label="Actual payer / beneficiary"><input value={row.actor || ''} onChange={e=>patchRow(row.id,{actor:e.target.value})} placeholder="Preserve the real payment actor"/></Field><Field label="Allocate to accounting company"><AppSelect value={row.companyId || ''} onValueChange={value=>patchRow(row.id,{companyId:value})} options={[{value:'',label:'Deliberately select the company'},...data.companies.map(item=>({value:item.id,label:item.name}))]}/></Field><Field label="Reviewed accounting treatment"><AppSelect value={row.treatment || ''} onValueChange={value=>patchRow(row.id,{treatment:value as Treatment})} options={[{value:'',label:'Choose treatment'},...choiceOptions(treatments)]}/></Field></>}<Field label="Reference / TID (as printed)"><input value={row.reference} onChange={e=>patchRow(row.id,{reference:e.target.value})}/></Field><Field label="Source running balance"><input inputMode="decimal" value={row.balance} onChange={e=>patchRow(row.id,{balance:e.target.value})}/></Field><Field label="Description / reviewed exception notes"><input value={row.description} onChange={e=>patchRow(row.id,{description:e.target.value})}/></Field></div><div className="import-raw"><span><FileText size={13}/> Original extracted text · page {row.page}, sequence {row.sequence}</span><code>{row.raw}</code></div><div className="import-row-actions"><button className="import-link danger" onClick={()=>patchRow(row.id,{kind:row.kind==='excluded'?(Number(row.goods)>0?'goods':Number(row.paid)>0?'payment':'goods'):'excluded',status:row.kind==='excluded'?'Needs review':'Excluded'})}>{row.kind==='excluded'?'Restore as transaction':'Exclude non-transaction row'}</button>{row.kind!=='excluded'&&<button className="button button-primary" onClick={()=>approveRow(row)}><Check size={15}/> {row.status==='Approved'?'Reapprove reviewed row':'Approve reviewed row'}</button>}</div>{/reject/i.test(row.raw)&&<div className="import-inline-note">Approval acknowledges the business meaning was reviewed. Rejection remains a delivery status; this row’s amount is preserved and no refund or stock reversal is created.</div>}</div>}</div>)}{!visible.length&&<div className="import-empty"><CheckCheck size={25}/><p>All transaction rows have been reviewed.</p></div>}</div><InfiniteListFooter list={reviewList} label="source rows"/></div>}

    {step===3&&<div className="import-reconcile"><div className="panel"><div className="import-section-heading"><div><span className="eyebrow">STEP 04 / BALANCE THE SOURCE</span><h3>Every line. The same closing balance.</h3><p className="muted">Reconciliation follows the printed sequence, including nonchronological rows.</p></div><ShieldCheck size={26} className="import-green"/></div><div className="import-reconcile-stats"><span>Source goods total<strong>{batch.mapping.currency} {money(summary?.goods || 0,2)}</strong><small>{summary?.goodsCount || 0} goods rows</small></span><span>Source payments<strong>{batch.mapping.currency} {money(summary?.paid || 0,2)}</strong><small>{summary?.paymentCount || 0} payment rows</small></span><span className="import-closing">Computed closing balance<strong>{batch.mapping.currency} {money(summary?.closing || 0,2)}</strong><small>Opening + goods − payments</small></span></div><div className={`import-reconciliation-result ${equalAmounts(batch.mapping.expectedClosing,summary?.closing)?'balanced':'unbalanced'}`}>{equalAmounts(batch.mapping.expectedClosing,summary?.closing)?<CheckCircle2 size={20}/>:<AlertCircle size={20}/>}<div><strong>{equalAmounts(batch.mapping.expectedClosing,summary?.closing)?'The closing balance reconciles.':'The printed closing balance needs attention.'}</strong><p>Printed closing: {batch.mapping.expectedClosing?`${batch.mapping.currency} ${money(batch.mapping.expectedClosing,2)}`:'Not confirmed'} <span>·</span> {batch.rows.length-activeRows.length} headers, totals, and excluded rows kept out of transactions.</p></div></div><div className="import-info"><Info size={17}/><p>This validates the statement’s arithmetic. It does not establish your business’s receivables, payables, revenue, expenses, or trading margin.</p></div></div><SourceTable rows={batch.rows} opening={batch.mapping.openingBalance}/></div>}

    {step===4&&<div className="import-preview"><div className="panel"><div className="import-section-heading"><div><span className="eyebrow">STEP 05 / MAKE IT OFFICIAL</span><h3>Here’s what will enter your books.</h3><p className="muted">A final look before the reviewed batch posts as one transaction.</p></div><FileCheck2 size={26} className="import-green"/></div><div className="import-preview-grid"><div><span className="muted">Business</span><strong>{batch.mapping.business}</strong></div><div><span className="muted">Accounting counterparty</span><strong>{company(batch.mapping.counterpartyId)}</strong></div><div><span className="muted">Statement perspective</span><strong>{batch.mapping.perspective}</strong></div><div><span className="muted">Import method</span><strong>{batch.mapping.mode==='Opening balance'?`Opening balance · ${sourceDate(batch.mapping.cutoff)}`:'Historical transactions'}</strong></div></div><div className="import-effects">{batch.mapping.mode==='Transactions'?<><div><Layers3 size={18}/><span>{summary?.goodsCount || 0} {batch.mapping.direction==='Receipt'?'purchase receipts':'sales dispatches'}<small>Original references, quantity, and delivery-party details retained</small></span><strong>{batch.mapping.currency} {money(summary?.goods || 0,2)}</strong></div><div><ArrowDownToLine size={18}/><span>{summary?.paymentCount || 0} reviewed payments<small>Actual payment actors and deliberate company allocations retained</small></span><strong>{batch.mapping.currency} {money(summary?.paid || 0,2)}</strong></div></>:<div><Layers3 size={18}/><span>One opening-balance entry<small>Historical transactions will not also be posted</small></span><strong>{batch.mapping.currency} {money(summary?.closing || 0,2)}</strong></div>}<div><Fingerprint size={18}/><span>Original document and source traceability<small>SHA-256 · {batch.hash.slice(0,24)}…</small></span>{batch.fileKey?<Check size={18}/>:<span className="import-status review">Original not saved</span>}</div></div><div className="import-info"><ShieldCheck size={17}/><p>Unknown invoice numbers and due dates remain empty. Unconfirmed shipment relationships and costs do not create profit. This batch cannot post its transaction history and its closing balance twice.</p></div>{errors.length>0?<div className="import-blockers"><h4><AlertCircle size={16}/> Resolve before posting</h4><ul>{errors.map((message,index)=><li key={`${message}-${index}`}>{message}</li>)}</ul></div>:<div className="import-ready"><CheckCircle2 size={18}/> All required checks have passed.</div>}<label className="import-confirm-units"><input type="checkbox" checked={acknowledged} onChange={e=>setAcknowledged(e.target.checked)}/><span>I confirm the ledger perspective, dates, units, classifications, and allocations.<small>Post this reviewed batch atomically to {data.business}.</small></span></label></div></div>}

    <div className="import-footer"><span><LockKeyhole size={14}/> Your source stays private and traceable.</span><div><button className="button button-secondary" disabled={!!pendingPost || step===1} onClick={()=>{patch({step:Math.max(1,step-1)});setError('');}}><ArrowLeft size={15}/> Back</button>{step<4?<button className="button button-primary" onClick={next}>{step===1?'Continue to review':step===2?'Reconcile statement':'Preview accounting effects'}<ArrowRight size={15}/></button>:<button className="button button-primary" disabled={!!pendingPost || !acknowledged || errors.length>0} onClick={post}><CheckCheck size={16}/> Confirm & post import</button>}</div></div>
  </div>;
}

function Field({label,children}:{label:string;children:React.ReactNode}) { return <label className="field import-field"><span>{label}</span>{isValidElement<{'aria-label'?:string}>(children)?cloneElement(children,{'aria-label':label}):children}</label>; }

type SourceColumn = 'rawDate'|'description'|'party'|'vehicle'|'weight'|'rate'|'goods'|'paid'|'balance'|'reference';
const sourceColumns: {key:SourceColumn;label:string}[] = [{key:'rawDate',label:'DATE'},{key:'description',label:'DESCRIPTIONS'},{key:'party',label:'PARTY'},{key:'vehicle',label:'VEH. #'},{key:'weight',label:'WEIGHT'},{key:'rate',label:'RATE'},{key:'goods',label:'TOTAL'},{key:'paid',label:'PAID / RECIVED'},{key:'balance',label:'PAYABLE / RECIVEABLE'},{key:'reference',label:'TID #'}];
function ColumnMapping({batch,onChange}:{batch:ImportBatch;onChange:(rows:SourceRow[])=>void}) {
  const original=useRef(batch.rows.map(row=>({...row})));
  const [assignments,setAssignments]=useState<Record<SourceColumn,SourceColumn>>({rawDate:'rawDate',description:'description',party:'party',vehicle:'vehicle',weight:'weight',rate:'rate',goods:'goods',paid:'paid',balance:'balance',reference:'reference'});
  function assign(target:SourceColumn,source:SourceColumn) {
    const next={...assignments,[target]:source};setAssignments(next);
    onChange(original.current.map(row=> {
      if(row.kind==='excluded') return row;
      const normalized={...row};
      sourceColumns.forEach(column=>{normalized[column.key]=row[next[column.key]];});
      normalized.proposedDate=suggestedDate(normalized.rawDate);normalized.effectiveDate='';normalized.status='Needs review';normalized.reviewer=undefined;normalized.reviewedAt=undefined;
      normalized.kind=Number(normalized.goods)>0?'goods':Number(normalized.paid)>0?'payment':row.kind;
      return normalized;
    }));
  }
  return <details className="import-column-map"><summary><span><ScanLine size={16}/><strong>Check the extracted column mapping</strong><small>Adjust a source column before reviewing its normalized values.</small></span><ChevronDown size={15}/></summary><div className="import-column-grid">{sourceColumns.map(column=><label key={column.key}><span>{column.label}</span><AppSelect aria-label={`Source column for ${column.label}`} value={assignments[column.key]} onValueChange={value=>assign(column.key,value as SourceColumn)} options={sourceColumns.map(source=>({value:source.key,label:source.label}))}/></label>)}</div><p className="import-inline-note">Original extracted text is immutable. Mapping changes are suggestions and reset row approvals.</p></details>;
}

function sourceEntries(rows:SourceRow[],opening:string) {
  const entries:{id:string;row:SourceRow;computed:string;matched:boolean}[]=[];
  let running=opening,invalid=false;
  for(const row of rows) {
    if(row.kind==='excluded')continue;
    let computed='';
    if(!invalid){try{running=reconcile([row],running).closing;computed=running;}catch{invalid=true;}}
    entries.push({id:row.id,row,computed,matched:equalAmounts(row.balance,computed)});
  }
  return entries;
}

function SourceTable({rows,opening='0'}:{rows:SourceRow[];opening?:string}) {
  const entries=useMemo(()=>sourceEntries(rows,opening),[rows,opening]);
  const sourceList=useInfiniteList(entries,`source:${rows[0]?.id||'empty'}:${opening}`);
  return <section className="panel import-source-table" aria-busy={sourceList.loading}><div className="import-section-heading"><div><h3>Source-order reconciliation</h3><p className="muted">Original evidence beside the computed balance.</p></div><span className="badge">{entries.length} rows</span></div><div className="import-table-scroll hf-desktop-only"><table className="import-table"><thead><tr><th>Source</th><th>Original date</th><th>Description</th><th>Goods</th><th>Payment</th><th>Source balance</th><th>Computed</th><th>Check</th></tr></thead><tbody>{sourceList.visibleItems.map(({row,computed,matched})=><tr key={row.id}><td>P{row.page} · R{row.sequence}</td><td>{row.rawDate || <span className="import-amber">Undated</span>}</td><td><strong>{row.description || row.party || 'Source row'}</strong>{row.vehicle&&<small>{row.vehicle} · {row.weight || '—'}</small>}</td><td>{row.goods?money(row.goods,2):'—'}</td><td>{row.paid?money(row.paid,2):'—'}</td><td>{row.balance?money(row.balance,2):'Not printed'}</td><td>{computed?money(computed,2):'Review numbers'}</td><td>{matched?<CheckCircle2 className="import-green" size={16}/>:<AlertCircle className="import-amber" size={16}/>}</td></tr>)}</tbody></table></div><div className="hf-record-cards hf-mobile-only import-source-cards" role="list" aria-label="Source-order reconciliation">{sourceList.visibleItems.map(({row,computed,matched})=><article key={row.id} role="listitem" className="hf-record-card import-source-card" data-testid="source-row-card" data-record-id={row.id}><header className="hf-record-card-header"><div className="hf-record-card-title"><h4>{row.description || row.party || 'Source row'}</h4><p className="hf-record-card-subtitle">Page {row.page} · Row {row.sequence} · {row.rawDate||'Undated'}</p></div><span className={`import-source-check ${matched?'matched':'unresolved'}`}>{matched?<CheckCircle2 size={16}/>:<AlertCircle size={16}/>}<span>{matched?'Matched':'Review'}</span></span></header><dl className="hf-record-card-meta"><div className={row.goods&&money(row.goods,2).length>14?'import-wide-amount':undefined}><dt>Goods</dt><dd>{row.goods?money(row.goods,2):'—'}</dd></div><div className={row.paid&&money(row.paid,2).length>14?'import-wide-amount':undefined}><dt>Payment</dt><dd>{row.paid?money(row.paid,2):'—'}</dd></div><div className={row.balance&&money(row.balance,2).length>14?'import-wide-amount':undefined}><dt>Source balance</dt><dd>{row.balance?money(row.balance,2):'Not printed'}</dd></div><div className={computed&&money(computed,2).length>14?'import-wide-amount':undefined}><dt>Computed balance</dt><dd>{computed?money(computed,2):'Review numbers'}</dd></div>{row.vehicle&&<div><dt>Vehicle / quantity</dt><dd>{row.vehicle} · {row.weight||'—'}</dd></div>}{row.party&&<div><dt>Source party</dt><dd>{row.party}</dd></div>}</dl><details className="import-card-evidence"><summary>Original source text</summary><p>{row.raw}</p></details></article>)}</div><InfiniteListFooter list={sourceList} label="source rows"/></section>;
}
