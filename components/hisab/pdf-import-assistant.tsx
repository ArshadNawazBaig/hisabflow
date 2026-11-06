'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Check, FileText, Loader2, Upload, X } from 'lucide-react';
import { createAutomaticDraft, prepareAutomaticImport, commitAutomaticImports } from '@/lib/import-automation';
import { extractPdf, fileHash, type ExtractedLedger } from '@/lib/pdf-extract';
import { uploadPrivateFile } from '@/lib/private-file-upload';
import { money, uid, type ImportBatch, type ImportMapping, type Workspace, type WorkspaceProps } from '@/lib/types';
import { AppSelect } from './controls';
import { InfiniteListFooter, ListSkeleton, useInfiniteList } from './infinite-list';
import './pdf-import-assistant.css';

type ImportChoices = {
  companyName: string;
  relationship: '' | 'Customer' | 'Supplier';
  unit: string;
  history: 'Complete history' | 'Partial history';
  perspective?: ImportMapping['perspective'];
};
type QueueItem = {
  id: string;
  file: File;
  status: 'queued' | 'uploading' | 'extracting' | 'ready' | 'error' | 'duplicate';
  hash?: string;
  fileKey?: string;
  extraction?: ExtractedLedger;
  batch?: ImportBatch;
  existing?: ImportBatch;
  choices: ImportChoices;
  error?: string;
  duplicateMessage?: string;
};
type ImportPlan = ReturnType<typeof prepareAutomaticImport>;
type PendingSave = {
  id: string;
  batches: ImportBatch[];
  newCompanyIds: string[];
};
type SavedImport = { batchIds: string[]; posted: number; drafts: number; companies: number };
export type PdfImportAssistantProps = WorkspaceProps & {
  reviewer?: string;
  onReview: (batch: ImportBatch) => void;
};

const normalizedName = (name: string) => name.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
const initialChoices = (): ImportChoices => ({ companyName: '', relationship: '', unit: 'Metric tonnes', history: 'Partial history' });
function choicesFor(batch: ImportBatch, workspace: Workspace): ImportChoices {
  const name = batch.mapping.issuer.trim();
  const company = workspace.companies.find(item => item.id === batch.mapping.counterpartyId)
    || (name ? workspace.companies.find(item => normalizedName(item.name) === normalizedName(name) || item.aliases.some(alias => normalizedName(alias) === normalizedName(name))) : undefined);
  return {
    companyName: company?.name || name,
    relationship: company?.role === 'Customer' || company?.role === 'Supplier' ? company.role : '',
    unit: batch.mapping.unit || 'Metric tonnes',
    history: batch.mapping.history || 'Partial history',
    perspective: batch.mapping.perspective || undefined,
  };
}
function extractionWarnings(extraction?: ExtractedLedger): string[] {
  if (!extraction) return [];
  const metadata = extraction.metadata as ExtractedLedger['metadata'] & { unreadablePages?: number[]; warnings?: string[] };
  return [
    ...(metadata.unreadablePages?.length ? [`Pages ${metadata.unreadablePages.join(', ')} have no readable text and need a reviewed transcription.`] : []),
    ...(metadata.warnings || []),
  ];
}
function savedBatchMatches(actual: ImportBatch | undefined, expected: ImportBatch): boolean {
  return !!actual && actual.hash === expected.hash && actual.fileKey === expected.fileKey && actual.status === expected.status
    && actual.rows.length === expected.rows.length && (expected.postedRecordIds || []).every(id => actual.postedRecordIds?.includes(id));
}

export function PdfImportAssistant({ ownerId, data, update, notify, reviewer = 'Workspace reviewer', onReview, saveState, retrySave, saveConflict }: PdfImportAssistantProps) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const itemsRef = useRef<QueueItem[]>([]);
  const workspaceRef = useRef(data);
  useLayoutEffect(()=>{workspaceRef.current=data},[data]);
  const [processing, setProcessing] = useState(false);
  const processingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<PendingSave | null>(null);
  const [saved, setSaved] = useState<SavedImport | null>(null);
  const completedRef = useRef('');
  const locked = processing || !!pending;
  const queueList = useInfiniteList(items,'pdf-upload-queue');
  const savedDrafts = (saved?.batchIds || []).map(id=>data.imports.find(batch=>batch.id===id)).filter((batch):batch is ImportBatch=>!!batch&&batch.status!=='Posted');
  const savedDraftList = useInfiniteList(savedDrafts,`saved-pdf-drafts:${saved?.batchIds.join(',')||'none'}`);

  function replaceItems(next: QueueItem[]) { itemsRef.current = next; setItems(next); }
  function patchItem(id: string, values: Partial<QueueItem>) { replaceItems(itemsRef.current.map(item => item.id === id ? { ...item, ...values } : item)); }
  function changeChoices(id: string, values: Partial<ImportChoices>) {
    setAcknowledged(false); setError('');
    replaceItems(itemsRef.current.map(item => item.id === id ? { ...item, choices: { ...item.choices, ...values } } : item));
  }

  async function processFile(id: string) {
    let item = itemsRef.current.find(entry => entry.id === id);
    if (!item) return;
    try {
      if (!/\.pdf$/i.test(item.file.name)) throw new Error('Choose a PDF statement.');
      if (!item.file.size || item.file.size > 20 * 1024 * 1024) throw new Error('Choose a non-empty PDF under 20 MB.');
      patchItem(id, { status: 'uploading', error: undefined });
      const hash = item.hash || await fileHash(item.file);
      patchItem(id, { hash });
      const other = itemsRef.current.find(entry => entry.id !== id && entry.hash === hash && entry.status !== 'error' && entry.status !== 'duplicate');
      if (other) { patchItem(id, { status: 'duplicate', duplicateMessage: 'This PDF is already in this upload.' }); return; }
      const existing = workspaceRef.current.imports.find(batch => batch.hash === hash);
      if (existing && (existing.status === 'Posted' || existing.fileKey)) {
        patchItem(id, { status: 'duplicate', existing, duplicateMessage: existing.status === 'Posted' ? 'This PDF is already imported.' : 'A draft for this PDF is already saved.' });
        return;
      }
      let fileKey = item.fileKey;
      if (!fileKey) {
        const payload = await uploadPrivateFile(item.file, ownerId);
        if (!payload.key || payload.hash !== hash) throw new Error('The retained PDF could not be verified. Retry this file.');
        fileKey = payload.key;
        patchItem(id, { fileKey });
      }
      patchItem(id, { status: 'extracting' });
      item = itemsRef.current.find(entry => entry.id === id)!;
      const extraction = item.extraction || await extractPdf(item.file);
      patchItem(id, { extraction });
      const batch = existing ? { ...existing, fileKey, sourceMetadata: extraction.metadata, sourcePages: extraction.pages } : createAutomaticDraft(extraction, {
        id, name: item.file.name, hash, fileKey, business: workspaceRef.current.business, currency: workspaceRef.current.currency,
      });
      patchItem(id, { status: 'ready', batch, choices: choicesFor(batch, workspaceRef.current) });
    } catch (cause) {
      patchItem(id, { status: 'error', error: cause instanceof Error ? cause.message : 'This PDF could not be read. Retry the file or use a reviewed transcription.' });
    }
  }
  async function run(ids: string[]) {
    if (processingRef.current || pending) return;
    processingRef.current = true; setProcessing(true); setError(''); setAcknowledged(false);
    try { for (const id of ids) await processFile(id); }
    finally { processingRef.current = false; setProcessing(false); }
  }
  function addFiles(files: FileList | File[]) {
    if (processingRef.current || pending || !files.length) return;
    const next = Array.from(files).map(file => ({ id: uid('IMP'), file, status: 'queued' as const, choices: initialChoices() }));
    replaceItems([...itemsRef.current, ...next]); setSaved(null);
    void run(next.map(item => item.id));
  }

  const previews = useMemo(() => items.filter(item => item.status === 'ready' && item.batch).map(item => {
    try { return { item, plan: prepareAutomaticImport(item.batch!, data, item.choices, reviewer), error: '' }; }
    catch (cause) { return { item, plan: null, error: cause instanceof Error ? cause.message : 'The import preview could not be prepared.' }; }
  }), [items, data, reviewer]);
  const plans = previews.flatMap(preview => preview.plan ? [preview.plan] : []);
  const missingDetails = previews.some(({ item, plan }) => !plan || !item.choices.companyName.trim() || !item.choices.relationship || (!plan.company && !plan.newCompany));
  const fileErrors = items.some(item => item.status === 'error');
  const canConfirm = plans.length > 0 && !locked && !fileErrors && !missingDetails && acknowledged;

  useEffect(() => {
    if (!pending) return;
    if (saveState === 'error' && saveConflict) {
      const refreshed = itemsRef.current.map(item => {
        const existing = item.hash && data.imports.find(batch => batch.hash === item.hash);
        return existing ? { ...item, status: 'duplicate' as const, existing, duplicateMessage: 'This PDF is already in the latest workspace.' } : item;
      });
      itemsRef.current = refreshed; setItems(refreshed);
      setPending(null); setAcknowledged(false);
      setError('Workspace changed. Review the latest matching companies/statements, then confirm again.');
      return;
    }
    if (saveState !== 'saved' || completedRef.current === pending.id) return;
    if (!pending.batches.every(batch => savedBatchMatches(data.imports.find(actual => actual.id === batch.id), batch))) return;
    if (!pending.newCompanyIds.every(id => data.companies.some(company => company.id === id))) return;
    completedRef.current = pending.id;
    const result = {
      batchIds: pending.batches.map(batch => batch.id),
      posted: pending.batches.filter(batch => batch.status === 'Posted').length,
      drafts: pending.batches.filter(batch => batch.status !== 'Posted').length,
      companies: pending.newCompanyIds.length,
    };
    setSaved(result); setPending(null); setAcknowledged(false);
    itemsRef.current = []; setItems([]);
    notify(result.drafts ? 'Statements saved. Open the remaining exceptions for review.' : 'Statements imported and saved.');
  }, [pending, saveState, saveConflict, data, notify]);

  function confirmImport() {
    if (!canConfirm) return;
    setError('');
    try {
      const result = commitAutomaticImports(plans, data, reviewer, acknowledged);
      const ids = new Set(plans.map(plan => plan.batch.id));
      const batches = result.workspace.imports.filter(batch => ids.has(batch.id));
      if (batches.length !== plans.length) throw new Error('Some statements are missing from the import result. No update was submitted.');
      setPending({ id: uid('SAVE'), batches, newCompanyIds: result.newCompanyIds });
      update(result.workspace, 'PDF statements imported', `${batches.length} statements; ${result.newCompanyIds.length} companies added`);
    } catch (cause) {
      setPending(null); setError(cause instanceof Error ? cause.message : 'The import could not be prepared. Your preview has been kept.');
    }
  }

  return <section className="pdf-assistant" aria-labelledby="pdf-assistant-heading">
    <div className={`pdf-upload${dragging && !locked ? ' pdf-upload-dragging' : ''}`} aria-busy={processing}
      onDragOver={event => { event.preventDefault(); if (!locked) setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={event => { event.preventDefault(); setDragging(false); if (!locked) addFiles(event.dataTransfer.files); }}>
      <div className="pdf-upload-copy"><h3 id="pdf-assistant-heading">Upload PDF statements</h3><p>Choose one or more PDFs to prepare the companies and transactions for review.</p><span>Text-layer PDFs · Up to 20 MB each</span></div>
      <button type="button" className="button button-primary" disabled={locked} onClick={() => inputRef.current?.click()}><Upload size={16}/>{items.length ? 'Add PDFs' : 'Choose PDFs'}</button>
      <input ref={inputRef} type="file" accept=".pdf,application/pdf" multiple hidden disabled={locked} aria-label="Choose PDF statements" onChange={event => { if (event.currentTarget.files) addFiles(event.currentTarget.files); event.currentTarget.value = ''; }}/>
    </div>

    {processing && <p className="pdf-progress" role="status"><Loader2 size={16} className="spin"/>Processing {Math.min(items.length, items.filter(item => item.status === 'ready' || item.status === 'duplicate' || item.status === 'error').length + 1)} of {items.length} PDFs. Keep this page open.</p>}
    {error && <p className="pdf-assistant-error" role="alert"><AlertCircle size={17}/><span>{error}</span></p>}

    {!!items.length && <div className="pdf-file-list" aria-label="Selected PDF statements" aria-busy={queueList.loading}>{queueList.visibleItems.map(item => {
      const preview = previews.find(entry => entry.item.id === item.id);
      return <article className="pdf-file" key={item.id} aria-labelledby={`${item.id}-name`}>
        <div className="pdf-file-heading"><FileText size={20} aria-hidden="true"/><div><h4 id={`${item.id}-name`}>{item.file.name}</h4><p>{item.status === 'uploading' ? 'Saving original PDF…' : item.status === 'extracting' ? 'Reading statement rows…' : item.status === 'queued' ? 'Waiting to process' : item.fileKey ? 'Original PDF retained' : item.status === 'duplicate' ? item.duplicateMessage : 'Original PDF not retained'}{item.extraction && ` · ${item.extraction.pages} ${item.extraction.pages === 1 ? 'page' : 'pages'}`}</p></div>
          {item.status === 'ready' && preview?.plan && <span className={`pdf-file-status ${preview.plan.blockers.length || preview.plan.reviewRows.length ? 'pdf-status-review' : 'pdf-status-ready'}`}>{preview.plan.blockers.length || preview.plan.reviewRows.length ? 'Needs review' : 'Ready to import'}</span>}
          <button type="button" className="button pdf-remove" disabled={locked} aria-label={`Remove ${item.file.name}`} onClick={() => { replaceItems(itemsRef.current.filter(entry => entry.id !== item.id)); setAcknowledged(false); }}><X size={17}/></button>
        </div>
        {item.status === 'error' && <div className="pdf-file-error" role="alert"><p>{item.error}</p><button type="button" className="button button-secondary" disabled={locked} onClick={() => void run([item.id])}>Retry file</button></div>}
        {item.status === 'duplicate' && item.existing && <div className="pdf-duplicate"><p>{item.duplicateMessage}</p><button type="button" className="button button-secondary" disabled={locked} onClick={() => onReview(item.existing!)}>{item.existing.status === 'Posted' ? 'View existing import' : 'Open existing draft'}</button></div>}
        {item.fileKey && <a className="pdf-source-link" href={`/api/files?key=${encodeURIComponent(item.fileKey)}`} target="_blank" rel="noreferrer">Original PDF</a>}
        {preview?.error && <p className="pdf-assistant-error" role="alert">{preview.error}</p>}
        {['queued','uploading','extracting'].includes(item.status) && <div className="pdf-extraction-skeleton" role="status" aria-label="Preparing statement preview"><ListSkeleton count={1} variant="card"/></div>}
        {preview?.plan && <FilePreview item={item} plan={preview.plan} disabled={locked} onChange={values => changeChoices(item.id, values)}/>}
      </article>;
    })}</div>}
    {!!items.length && <InfiniteListFooter list={queueList} label="PDF statements"/>}

    {previews.length > 0 && <div className="pdf-confirm">
      {fileErrors && <p className="pdf-confirm-hint">Retry or remove the PDFs that could not be processed before importing.</p>}
      {missingDetails && <p className="pdf-confirm-hint">Enter a company name and choose Customer or Supplier for each statement.</p>}
      <label className="pdf-confirm-label"><input type="checkbox" checked={acknowledged} disabled={locked} onChange={event => setAcknowledged(event.currentTarget.checked)}/><span>I confirm the companies, relationships, source perspectives, currency and units shown above, including the proposed payment treatments and allocations to each selected company. Statements with unresolved information will stay in drafts.</span></label>
      <button type="button" className="button button-primary" disabled={!canConfirm} onClick={confirmImport}>{pending ? <Loader2 size={16} className="spin"/> : <Check size={16}/>}Import statements</button>
    </div>}

    {pending && <div className={saveState === 'error' ? 'pdf-assistant-error pdf-save-state' : 'pdf-save-state'} role={saveState === 'error' ? 'alert' : 'status'}>
      <p>{saveState === 'error' ? 'The workspace could not save these changes. Your import preview is kept here until the save succeeds.' : 'Saving the statements and company records…'}</p>
      {saveState === 'error' && retrySave && <button type="button" className="button button-secondary" onClick={retrySave}>Retry save</button>}
    </div>}

    {saved && <div className="pdf-saved" role="status"><div><h3>Import saved</h3><p>{saved.posted} {saved.posted === 1 ? 'statement posted' : 'statements posted'} · {saved.drafts} {saved.drafts === 1 ? 'draft to review' : 'drafts to review'} · {saved.companies} {saved.companies === 1 ? 'company added' : 'companies added'}</p></div>
      {!!savedDrafts.length&&<div className="pdf-saved-actions">{savedDraftList.visibleItems.map(batch => <button type="button" className="button button-secondary" key={batch.id} onClick={() => onReview(batch)}>Review exceptions · {batch.name}</button>)}<InfiniteListFooter list={savedDraftList} label="saved drafts"/></div>}
    </div>}
  </section>;
}

function FilePreview({ item, plan, disabled, onChange }: { item: QueueItem; plan: ImportPlan; disabled: boolean; onChange: (values: Partial<ImportChoices>) => void }) {
  const warnings = extractionWarnings(item.extraction);
  const rows = plan.batch.rows.filter(row => row.kind !== 'excluded' && row.status !== 'Excluded');
  const reviewIds = new Set(plan.reviewRows.map(row => row.id));
  const rowList = useInfiniteList(rows,`pdf-records:${item.id}`);
  const exceptionList = useInfiniteList(plan.reviewRows,`pdf-exceptions:${item.id}`);
  return <div className="pdf-preview">
    {item.extraction?.metadata.title && <p className="pdf-statement-title">Source title: {item.extraction.metadata.title}</p>}
    <div className="pdf-preview-fields">
      <label className="field"><span>Company name</span><input value={item.choices.companyName} maxLength={200} disabled={disabled} onChange={event => onChange({ companyName: event.currentTarget.value })}/><small>{plan.newCompany ? 'A new company will be created' : plan.company ? 'Matches an existing company' : 'Confirm the company shown on this statement'}</small></label>
      <label className="field"><span>Relationship to your business</span><AppSelect aria-label={`Relationship for ${item.file.name}`} value={item.choices.relationship} disabled={disabled} onValueChange={value => onChange({ relationship: value as ImportChoices['relationship'] })} options={[{ value: '', label: 'Choose Customer or Supplier' }, { value: 'Customer', label: 'Customer' }, { value: 'Supplier', label: 'Supplier' }]}/></label>
      <label className="field"><span>Source perspective</span><AppSelect aria-label={`Source perspective for ${item.file.name}`} value={item.choices.perspective ?? plan.batch.mapping.perspective ?? ''} disabled={disabled} onValueChange={value => onChange({ perspective: value as ImportMapping['perspective'] })} options={[{ value: '', label: 'Not confirmed — keep in draft' }, ...['Own books', 'Supplier statement', 'Customer statement', 'Third-party statement'].map(value => ({ value, label: value }))]}/></label>
      <label className="field"><span>Quantity unit</span><AppSelect aria-label={`Quantity unit for ${item.file.name}`} value={item.choices.unit} disabled={disabled} onValueChange={value => onChange({ unit: value })} options={['Metric tonnes', 'Kilograms', 'Units', 'Other'].map(value => ({ value, label: value }))}/></label>
      <label className="field"><span>History coverage</span><AppSelect aria-label={`History coverage for ${item.file.name}`} value={item.choices.history} disabled={disabled} onValueChange={value => onChange({ history: value as ImportChoices['history'] })} options={['Partial history', 'Complete history'].map(value => ({ value, label: value }))}/></label>
      <div className="pdf-currency"><span>Workspace currency</span><strong>{plan.batch.mapping.currency}</strong></div>
    </div>
    <dl className="pdf-preview-totals"><div><dt>Source rows</dt><dd>{rows.length}</dd></div><div><dt>Goods total</dt><dd className={money(plan.totals.goods,2).length>18?'pdf-long-amount':undefined}>{money(plan.totals.goods, 2)}</dd></div><div><dt>Payments total</dt><dd className={money(plan.totals.paid,2).length>18?'pdf-long-amount':undefined}>{money(plan.totals.paid, 2)}</dd></div><div><dt>Calculated closing</dt><dd className={money(plan.totals.closing,2).length>18?'pdf-long-amount':undefined}>{money(plan.totals.closing, 2)}</dd></div></dl>
    <p className="pdf-row-readiness">{plan.readyRows} rows prepared · {plan.reviewRows.length} rows need review{plan.batch.mapping.expectedClosing && <span> · Printed closing {money(plan.batch.mapping.expectedClosing, 2)}</span>}</p>
    <details className="pdf-records"><summary>Preview extracted records ({rows.length})</summary>
      <p className="pdf-records-hint">Review the source values and proposed payment details for each record.</p>
      <div className="pdf-records-scroll" tabIndex={0} role="region" aria-label={`Extracted records from ${item.file.name}`}>
        <table className="pdf-records-table hf-desktop-only"><caption className="hf-visually-hidden">Proposed records from {item.file.name}. Amounts in {plan.batch.mapping.currency}.</caption><thead><tr><th scope="col">Source</th><th scope="col">Description</th><th scope="col">Delivery party</th><th scope="col">Goods</th><th scope="col">Payment</th><th scope="col">Proposed payment details</th><th scope="col">Review state</th></tr></thead>
          <tbody>{rowList.visibleItems.map(row => <tr key={row.id}>
            <th scope="row" className="pdf-record-source">{row.rawDate || 'Undated'}<small>Page {row.page} · Row {row.sequence}</small>{row.effectiveDate && row.effectiveDate !== row.rawDate && <small>Proposed: {row.effectiveDate}</small>}</th>
            <td className="pdf-record-description">{row.description || '—'}<details className="pdf-record-raw"><summary>Source text</summary><p>{row.raw}</p></details></td>
            <td>{row.party || '—'}</td><td className="pdf-record-amount">{row.goods ? money(row.goods, 2) : '—'}</td><td className="pdf-record-amount">{row.paid ? money(row.paid, 2) : '—'}</td>
            <td className="pdf-record-payment">{row.paid && Number(row.paid) !== 0 ? <><span>Actor: {row.actor || 'Not confirmed'}</span><span>Treatment: {row.treatment || 'Not confirmed'}</span><span>Allocation: {row.companyId && row.companyId === plan.company?.id ? plan.company.name : row.companyId ? 'Different company — review' : 'Not confirmed'}</span></> : '—'}</td>
            <td><span className={`pdf-file-status ${reviewIds.has(row.id) ? 'pdf-status-review' : 'pdf-status-ready'}`}>{reviewIds.has(row.id) ? 'Needs review' : 'Prepared'}</span></td>
          </tr>)}</tbody>
        </table>
        <div className="hf-record-cards hf-mobile-only pdf-record-cards" role="list" aria-label={`Extracted records from ${item.file.name}`}>{rowList.visibleItems.map(row=><article key={row.id} role="listitem" className="hf-record-card pdf-record-card" data-testid="pdf-row-card" data-record-id={row.id}><header className="hf-record-card-header"><div className="hf-record-card-title"><h5>{row.description||row.party||'Source record'}</h5><p className="hf-record-card-subtitle">{row.rawDate||'Undated'} · Page {row.page} · Row {row.sequence}</p>{row.effectiveDate&&row.effectiveDate!==row.rawDate&&<p className="hf-record-card-subtitle">Proposed: {row.effectiveDate}</p>}</div><span className={`pdf-file-status ${reviewIds.has(row.id)?'pdf-status-review':'pdf-status-ready'}`}>{reviewIds.has(row.id)?'Needs review':'Prepared'}</span></header><dl className="hf-record-card-meta"><div><dt>Goods · {plan.batch.mapping.currency}</dt><dd className={row.goods&&money(row.goods,2).length>18?'pdf-long-amount':undefined}>{row.goods?money(row.goods,2):'—'}</dd></div><div><dt>Payment · {plan.batch.mapping.currency}</dt><dd className={row.paid&&money(row.paid,2).length>18?'pdf-long-amount':undefined}>{row.paid?money(row.paid,2):'—'}</dd></div><div><dt>Delivery party</dt><dd>{row.party||'—'}</dd></div>{row.paid&&Number(row.paid)!==0&&<><div><dt>Payment actor</dt><dd>{row.actor||'Not confirmed'}</dd></div><div><dt>Treatment</dt><dd>{row.treatment||'Not confirmed'}</dd></div><div><dt>Allocation</dt><dd>{row.companyId&&row.companyId===plan.company?.id?plan.company.name:row.companyId?'Different company — review':'Not confirmed'}</dd></div></>}</dl><details className="pdf-record-raw"><summary>Original source text</summary><p>{row.raw}</p></details></article>)}</div>
        <InfiniteListFooter list={rowList} label="extracted records"/>
      </div>
    </details>
    {(warnings.length > 0 || plan.blockers.length > 0 || plan.reviewRows.length > 0) && <details className="pdf-exceptions"><summary>Review remaining information</summary>
      {!!(warnings.length || plan.blockers.length) && <ul>{[...new Set([...warnings, ...plan.blockers])].map(message => <li key={message}>{message}</li>)}</ul>}
      {!!plan.reviewRows.length && <ul>{exceptionList.visibleItems.map(row => <li key={row.id}>Page {row.page}, row {row.sequence}: {row.issues.join(' ') || 'Additional accounting review is required.'}</li>)}</ul>}
      {!!plan.reviewRows.length&&<InfiniteListFooter list={exceptionList} label="exceptions"/>}
    </details>}
  </div>;
}
