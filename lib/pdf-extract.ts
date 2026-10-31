import type { SourceRow } from './types';
import type { TextContent } from 'pdfjs-dist/types/src/display/api';

export type LedgerBalanceEvidence = { value: string; raw: string; page: number; sequence: number };
export type LedgerMetadata = {
  title: string;
  /** A name printed in the title, never an inferred supplier/customer or statement perspective. */
  issuerGuess: string;
  columns: { key: string; label: string }[];
  unreadablePages: number[];
  openingBalance?: LedgerBalanceEvidence;
  closingBalance?: LedgerBalanceEvidence;
};
export type ExtractedLedger = { rows: SourceRow[]; pages: number; text: string; columns: string[]; metadata: LedgerMetadata };
export type LedgerTextCell = { text: string; x: number; y: number; width: number };
type Column = { key: string; label: string; x: number; width: number };
const headers = ['date','description','party','vehicle','weight','rate','goods','paid','balance','reference'];
const numericColumns = new Set(['weight','rate','goods','paid','balance']);
const blankCell = (value = '') => !value.trim() || /^[-–—]+$/.test(value.trim());
const nonzero = (value: string) => /[1-9]/.test(value);

/** Normalize punctuation only; money and quantities never pass through floating point. */
const cleanNumber = (source = '') => {
  let value = source.trim().replace(/\u2212/g,'-');
  if (/^\([^()]+\)$/.test(value)) value = `-${value.slice(1,-1).trim()}`;
  if (!/^[+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)$/.test(value)) return '';
  return value.replaceAll(',','').replace(/^\+/,'').replace(/^(-?)\./,(_,sign:string)=>`${sign}0.`);
};
const headerKey = (source: string) => {
  const key = source.toLowerCase().replaceAll(/[^a-z]/g,'');
  if (/^(date|transactiondate)$/.test(key)) return 'date';
  if (/^(descriptions?|desc|particulars)$/.test(key)) return 'description';
  if (/^(party|partyname)$/.test(key)) return 'party';
  if (/^(veh|vehicle|vehno|vehicleno|vehiclenumber)$/.test(key)) return 'vehicle';
  if (/^(weight|quantity|qty)$/.test(key)) return 'weight';
  if (/^rate$/.test(key)) return 'rate';
  if (/^(total|amount|goodstotal)$/.test(key)) return 'goods';
  if (/^(paid|recived|received|recieved)$/.test(key)) return 'paid';
  if (/^(payable|reciveable|recieveable|receivable|balance|runningbalance)$/.test(key)) return 'balance';
  if (/^(tid|transactionid|reference|ref|refno)$/.test(key)) return 'reference';
  return '';
};
const splitCells = (raw: string) => raw.includes('|') ? raw.split('|').map(value=>value.trim()) : raw.includes('\t') ? raw.split('\t').map(value=>value.trim()) : raw.trim().split(/\s{2,}/);
const tableHeader = (keys: string[]) => new Set(keys.filter(Boolean)).size >= 4 && keys.some(key=>key==='date'||key==='description') && keys.some(key=>['goods','paid','balance'].includes(key));
const balanceLabel = (raw: string) => {
  const label = raw.replace(/\|/g,' ').trim();
  if (/^(?:opening\s+(?:balance|payable|receivable)|(?:balance\s+)?brought\s+forward|balance\s+b\s*\/\s*f)\b/i.test(label)) return 'opening';
  if (/^(?:closing\s+(?:balance|payable|receivable)|(?:balance\s+)?carried\s+forward|carry\s+forward|balance\s+c\s*\/\s*f|total\s+(?:payable|receivable))\b/i.test(label)) return 'closing';
  return '';
};
const sourceDecoration = (raw: string) => /^(?:ledger\s+(?:of|for)\b|(?:account\s+)?statement\s+(?:of|for)\b|page\s*\d+(?:\s+of\s+\d+)?\s*$)/i.test(raw.trim()) || /^(?:grand\s+)?totals?\s*$/i.test(splitCells(raw).find(value=>!blankCell(value)) || '') || !!balanceLabel(raw);

export function suggestedDate(raw: string): string {
  const match = raw.trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})$/);
  if (!match) return '';
  const day = +match[1], month = +match[2], year = match[3].length === 2 ? 2000 + +match[3] : +match[3];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}` : '';
}

function onlyBalance(values: Record<string,string>) {
  return !!cleanNumber(values.balance) && ['date','description','party','vehicle','reference'].every(key=>blankCell(values[key])) && ['weight','rate','goods','paid'].every(key=>blankCell(values[key]) || (!!cleanNumber(values[key]) && !nonzero(cleanNumber(values[key]))));
}

function makeRow(values: Record<string,string>, raw: string, page: number, sequence: number): SourceRow {
  const date = blankCell(values.date) ? '' : values.date || '';
  const proposedDate = suggestedDate(date);
  const goods = cleanNumber(values.goods), paid = cleanNumber(values.paid);
  const header = sourceDecoration(raw) || /^\d{1,2}$/.test(raw.trim());
  const looksLikeTransaction = !!(date || !blankCell(values.vehicle) || cleanNumber(values.weight) || goods || paid) || (Object.values(values).some(value=>!blankCell(value)) && /\d/.test(raw));
  const kind = header || onlyBalance(values) || !looksLikeTransaction ? 'excluded' : goods && nonzero(goods) ? 'goods' : paid && nonzero(paid) ? 'payment' : 'goods';
  const issues: string[] = [];
  if (kind !== 'excluded') {
    if (!date) issues.push('Missing source date — do not infer from nearby rows');
    else if (!proposedDate) issues.push('Ambiguous source date — approve an effective date');
    if (/reject/i.test(raw)) issues.push('Rejected delivery — business meaning needs review; source amount is preserved');
    if (kind === 'payment') issues.push('Review payment actor, allocation, and accounting treatment');
    if (kind === 'goods' && (!cleanNumber(values.weight) || !cleanNumber(values.rate) || !goods)) issues.push('Check extracted quantity, rate, and source amount; this row has not been discarded');
    if (goods && paid && nonzero(goods) && nonzero(paid)) issues.push('Both goods and payment amounts on one line — split source evidence into separate reviewed rows');
    for (const key of numericColumns) {
      if (!blankCell(values[key]) && !cleanNumber(values[key])) issues.push(`Unrecognized source ${key} value — review the original text`);
    }
  }
  return { id:`ROW-${page}-${sequence}`, page, sequence, rawDate:date, proposedDate, effectiveDate:'', description:values.description || '', party:values.party || '', vehicle:blankCell(values.vehicle)?'':values.vehicle || '', weight:cleanNumber(values.weight), rate:cleanNumber(values.rate), goods, paid, balance:cleanNumber(values.balance), reference:values.reference || '', kind, status:kind==='excluded'?'Excluded':'Needs review', issues, raw };
}

function flagOrder(rows: SourceRow[]) {
  let previous = '';
  for (const row of rows) {
    if (row.kind === 'excluded') continue;
    if (row.proposedDate && previous && row.proposedDate < previous) row.issues.push('Source row is out of chronological order — preserve printed sequence');
    if (row.proposedDate) previous = row.proposedDate;
  }
  return rows;
}

function readDelimitedRows(text: string) {
  let columns: string[] = [];
  const rows: SourceRow[] = [];
  let sequence = 0;
  const pages = text.split('\f');
  pages.forEach((page,pageIndex)=>{
    for (const raw of page.split(/\r?\n/).filter(line=>line.trim())) {
      const cells = splitCells(raw), found = cells.map(headerKey);
      if (tableHeader(found)) {
        columns = found;
        rows.push(makeRow({},raw,pageIndex+1,++sequence));
        continue;
      }
      const values: Record<string,string> = {};
      if (columns.length || cells.length >= 4) (columns.length?columns:headers).forEach((key,index)=>{ if(key) values[key]=cells[index] || ''; });
      rows.push(makeRow(values,raw,pageIndex+1,++sequence));
    }
  });
  return { rows, columns:columns.filter(Boolean), pages:pages.length };
}

function printedBalance(row: SourceRow): LedgerBalanceEvidence | undefined {
  let value = cleanNumber(row.balance);
  if (!value) {
    // Only called for an explicitly labeled balance, so a last numeric token is source evidence.
    const token = row.raw.match(/(?:^|[\s|:])(\(?[+\-−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\)?)(?:\s*\|)*\s*$/);
    value = cleanNumber(token?.[1]);
  }
  return value ? {value,raw:row.raw,page:row.page,sequence:row.sequence} : undefined;
}

/** Printed names/labels and balance evidence only. No accounting role or financial ownership is inferred. */
export function extractLedgerMetadata(text: string, sourceRows?: SourceRow[]): LedgerMetadata {
  const metadata: LedgerMetadata = { title:'', issuerGuess:'', columns:[], unreadablePages:[] };
  for (const raw of text.split(/[\r\n\f]+/).filter(line=>line.trim())) {
    const title = raw.replace(/\s*\|\s*/g,' ').trim();
    const match = title.match(/^(?:(?:account\s+)?ledger|(?:account\s+)?statement)\s+(?:of|for)\s*:?\s*(.+)$/i);
    if (!metadata.title && match) { metadata.title=title; metadata.issuerGuess=match[1].trim(); }
    const cells=splitCells(raw), keys=cells.map(headerKey);
    if (!metadata.columns.length && tableHeader(keys)) metadata.columns=cells.flatMap((label,index)=>keys[index]?[{key:keys[index],label}]:[]);
  }
  const rows = sourceRows || readDelimitedRows(text).rows;
  const pageCount=rows.reduce((count,row)=>Math.max(count,row.page),text.split('\f').length);
  metadata.unreadablePages=Array.from({length:pageCount},(_,index)=>index+1).filter(page=>!rows.some(row=>row.page===page && (row.kind!=='excluded'||!!row.balance)));
  const lastTransaction = rows.reduce((last,row)=>row.kind==='excluded'?last:row.sequence,0);
  for (const row of rows) {
    const label = balanceLabel(row.raw);
    if (label==='opening') metadata.openingBalance=printedBalance(row) || metadata.openingBalance;
    if (label==='closing') metadata.closingBalance=printedBalance(row) || metadata.closingBalance;
  }
  if (!metadata.closingBalance && metadata.columns.some(column=>column.key==='balance')) {
    // A terminal balance-only line under PAYABLE/RECEIVABLE is a printed summary, not a transaction.
    const summary = rows.findLast(row=>row.kind==='excluded' && row.sequence>lastTransaction && onlyBalance({date:row.rawDate,description:row.description,party:row.party,vehicle:row.vehicle,weight:row.weight,rate:row.rate,goods:row.goods,paid:row.paid,balance:row.balance,reference:row.reference}));
    if (summary) metadata.closingBalance=printedBalance(summary);
  }
  return metadata;
}

/** Delimited paste is deliberately explicit; a guessed correction never changes raw evidence. */
export function extractLedgerText(text: string): ExtractedLedger {
  const result=readDelimitedRows(text);
  return {...result,rows:flagOrder(result.rows),text,metadata:extractLedgerMetadata(text,result.rows)};
}

function detectColumns(line: readonly LedgerTextCell[]): Column[] {
  const columns: Column[] = [];
  for (let index=0;index<line.length;index++) {
    let detected: Column | undefined, end=index;
    for (let next=index;next<Math.min(line.length,index+3);next++) {
      if (next>index && line[next].x-(line[next-1].x+line[next-1].width)>8) break;
      const label=line.slice(index,next+1).map(cell=>cell.text).join(' '), key=headerKey(label);
      if (key) { detected={key,label,x:line[index].x,width:line[next].x+line[next].width-line[index].x}; end=next; }
    }
    if (detected) { columns.push(detected); index=end; }
  }
  return tableHeader(columns.map(column=>column.key)) ? columns : [];
}

function assignValues(line: readonly LedgerTextCell[], columns: readonly Column[]) {
  const buckets: Record<string,LedgerTextCell[]> = {};
  for (const cell of line) {
    // Numeric text is often right aligned and starts to the left of its header. Its center stays in its column.
    const numeric = /^[\d.,+()\-−\s]+$/.test(cell.text.trim());
    const point=cell.x+(numeric?cell.width/2:Math.min(cell.width/2,8));
    let index=columns.findIndex((column,i)=>point<((column.x+column.width/2)+(columns[i+1]?columns[i+1].x+columns[i+1].width/2:Infinity))/2);
    if (index<0) index=columns.length-1;
    const key=columns[index].key;
    (buckets[key] ||= []).push(cell);
  }
  const values: Record<string,string> = {};
  for (const [key,cells] of Object.entries(buckets)) {
    values[key]=cells.map((cell,index)=>`${index && cell.x-(cells[index-1].x+cells[index-1].width)>1?' ':''}${cell.text}`).join('').trim();
    if (numericColumns.has(key) && !cleanNumber(values[key])) {
      const joined=cells.map(cell=>cell.text.trim()).join('');
      if (cleanNumber(joined)) values[key]=joined;
    }
  }
  return values;
}

/** Shared by the browser PDF reader and sanitized position-based extraction fixtures. */
export function extractLedgerPages(pages: readonly (readonly LedgerTextCell[])[]): ExtractedLedger {
  const rows: SourceRow[] = [], fullText: string[] = [];
  let columns: Column[] = [], printedColumns: LedgerMetadata['columns'] = [];
  let sequence=0;
  pages.forEach((page,pageIndex)=>{
    const lines: LedgerTextCell[][] = [];
    for (const cell of [...page].filter(item=>item.text.trim()).sort((a,b)=>b.y-a.y || a.x-b.x)) {
      const line=lines.find(candidate=>Math.abs(candidate[0].y-cell.y)<3);
      if (line) line.push(cell); else lines.push([cell]);
    }
    let previousY: number | undefined;
    for (const line of lines) {
      line.sort((a,b)=>a.x-b.x);
      const raw=line.map(cell=>cell.text).join(' | '), detected=detectColumns(line);
      fullText.push(raw);
      sequence++;
      if (detected.length) {
        columns=detected;
        if (!printedColumns.length) printedColumns=detected.map(({key,label})=>({key,label}));
        rows.push(makeRow({},raw,pageIndex+1,sequence));
      } else if (!columns.length) rows.push(makeRow({},raw,pageIndex+1,sequence));
      else {
        const values=assignValues(line,columns), previous=rows.at(-1);
        const continuation=previous && previous.page===pageIndex+1 && previous.kind!=='excluded' && previousY!==undefined && previousY-line[0].y<=12 && !sourceDecoration(raw) && Object.entries(values).every(([key,value])=>blankCell(value)||key==='description'||key==='party') && !!(values.description||values.party);
        if (continuation) {
          if (values.description) previous.description=[previous.description,values.description].filter(Boolean).join(' ');
          if (values.party) previous.party=[previous.party,values.party].filter(Boolean).join(' ');
          previous.raw+=`\n${raw}`;
        } else rows.push(makeRow(values,raw,pageIndex+1,sequence));
      }
      previousY=line[0].y;
    }
  });
  const text=fullText.join('\n'), metadata=extractLedgerMetadata(text,rows);
  if (printedColumns.length) metadata.columns=printedColumns;
  metadata.unreadablePages=pages.flatMap((_,index)=>rows.some(row=>row.page===index+1 && (row.kind!=='excluded'||!!row.balance))?[]:[index+1]);
  return {rows:flagOrder(rows),pages:pages.length,text,columns:columns.map(column=>column.key),metadata};
}

/** Read PDF.js chunks without requiring ReadableStream async iteration (missing in Safari). */
export async function readPdfTextItems(stream: ReadableStream<TextContent>): Promise<TextContent['items']> {
  const reader = stream.getReader();
  const items: TextContent['items'] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return items;
      items.push(...value.items);
    }
  } finally {
    reader.releaseLock();
  }
}

/** Text-layer extraction only. Image-only PDFs remain unposted until a human supplies evidence. */
export async function extractPdf(file: File): Promise<ExtractedLedger> {
  const pdfjs=await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc='/pdf.worker.min.mjs';
  const loadingTask=pdfjs.getDocument({data:new Uint8Array(await file.arrayBuffer())});
  try {
    const doc=await loadingTask.promise;
    const pages: LedgerTextCell[][] = [];
    for (let pageNumber=1;pageNumber<=doc.numPages;pageNumber++) {
      const page=await doc.getPage(pageNumber);
      // XFA's getTextContent path does not use stream iteration; preserve its handling.
      const items=page.isPureXfa ? (await page.getTextContent()).items : await readPdfTextItems(page.streamTextContent());
      pages.push(items.filter((item): item is typeof item & {str:string;transform:number[];width:number}=>'str' in item).map(item=>({text:item.str,x:item.transform[4],y:item.transform[5],width:item.width})));
    }
    const extraction=extractLedgerPages(pages);
    if (!extraction.rows.some(row=>row.kind!=='excluded')) throw new Error('No ledger rows could be read confidently. Paste a delimited transcription below, or use a text-layer PDF. Scanned PDFs require a reviewed transcription.');
    return extraction;
  } finally { await loadingTask.destroy(); }
}

export async function fileHash(file: Blob): Promise<string> {
  const digest=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());
  return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
}

export const SAMPLE_LEDGER = `DATE | DESCRIPTIONS | PARTY | VEH. # | WEIGHT | RATE | TOTAL | PAID | PAYABLE | TID #
12-10-2026 | Mineral shipment | Atlas Textiles | DEM-401 | 24.500 | 12000.00 | 294000.00 | | 294000.00 |
13-10-2026 | Transfer by example remitter | | | | | | 200000.00 | 94000.00 | SAMPLE-01
14/10/026 | Mineral shipment | Riverdale Mills | DEM-402 | 18.250 | 12000.00 | 219000.00 | | 313000.00 |
15-10-2026 | Rejected quantity, review meaning | Atlas Textiles | DEM-401 | 0.500 | 12000.00 | 6000.00 | | 319000.00 | Rejected
16-10-2026 | Transfer by example remitter | | | | | | 100000.00 | 219000.00 | SAMPLE-02
Closing balance | | | | | | | | 219000.00 |`;
