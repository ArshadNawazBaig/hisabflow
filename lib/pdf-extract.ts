import type { SourceRow } from './types';

export type ExtractedLedger = { rows: SourceRow[]; pages: number; text: string; columns: string[] };
type Cell = { text: string; x: number; y: number; width: number };
type Column = { key: string; x: number };
const cleanNumber = (s = '') => /^-?[\d,]+(?:\.\d+)?$/.test(s.trim()) ? s.replaceAll(',', '').trim() : '';
const headers = ['date','description','party','vehicle','weight','rate','goods','paid','balance','reference'];
const headerKey = (s: string) => {
  const key = s.toLowerCase().replaceAll(/[^a-z]/g, '');
  if (/^date$/.test(key)) return 'date';
  if (/^descriptions?$/.test(key)) return 'description';
  if (/^party$/.test(key)) return 'party';
  if (/^(veh|vehicle|vehiclenumber)$/.test(key)) return 'vehicle';
  if (/^weight$/.test(key)) return 'weight';
  if (/^rate$/.test(key)) return 'rate';
  if (/^total$/.test(key)) return 'goods';
  if (/^(paid|recived|received)$/.test(key)) return 'paid';
  if (/^(payable|reciveable|receivable|balance)$/.test(key)) return 'balance';
  if (/^(tid|reference|ref)$/.test(key)) return 'reference';
  return '';
};

export function suggestedDate(raw: string): string {
  const match = raw.trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})$/);
  if (!match) return '';
  const day = +match[1], month = +match[2], year = match[3].length === 2 ? 2000 + +match[3] : +match[3];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}` : '';
}

function makeRow(values: Record<string,string>, raw: string, page: number, sequence: number): SourceRow {
  const date = values.date || '';
  const proposedDate = suggestedDate(date);
  const goods = cleanNumber(values.goods), paid = cleanNumber(values.paid);
  const header = /^(?:date\s|ledger of\s|page\s*\d|(?:grand\s+)?total\b|(?:closing|opening|carry|brought)\s*(?:balance|forward)|balance\s*(?:c\/f|b\/f|carried|brought))/i.test(raw.trim()) || /^\d{1,2}$/.test(raw.trim());
  const balanceOnly = !!cleanNumber(values.balance) && !['date','description','party','vehicle','weight','rate','goods','paid','reference'].some(key => values[key]?.trim());
  const looksLikeTransaction = !!(date || values.vehicle || cleanNumber(values.weight) || goods || paid) || (Object.values(values).some(Boolean) && /\d/.test(raw));
  const kind = header || balanceOnly || !looksLikeTransaction ? 'excluded' : goods && +goods !== 0 ? 'goods' : paid && +paid !== 0 ? 'payment' : 'goods';
  const issues: string[] = [];
  if (kind !== 'excluded') {
    if (!date) issues.push('Missing source date — do not infer from nearby rows');
    else if (!proposedDate) issues.push('Ambiguous source date — approve an effective date');
    if (/reject/i.test(raw)) issues.push('Rejected delivery — business meaning needs review; source amount is preserved');
    if (kind === 'payment') issues.push('Review payment actor, allocation, and accounting treatment');
    if (kind === 'goods' && (!cleanNumber(values.weight) || !cleanNumber(values.rate) || !goods)) issues.push('Check extracted quantity, rate, and source amount; this row has not been discarded');
    if (goods && paid && +goods && +paid) issues.push('Both goods and payment amounts on one line — split source evidence into separate reviewed rows');
  }
  return { id: `ROW-${page}-${sequence}`, page, sequence, rawDate:date, proposedDate, effectiveDate:'', description:values.description || '', party: values.party || '', vehicle: values.vehicle || '', weight:cleanNumber(values.weight), rate:cleanNumber(values.rate), goods, paid, balance:cleanNumber(values.balance), reference: values.reference || '', kind, status:kind === 'excluded' ? 'Excluded' : 'Needs review', issues, raw };
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

/** Delimited paste is deliberately explicit; a guessed correction never changes raw evidence. */
export function extractLedgerText(text: string): ExtractedLedger {
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  let columns: string[] = [];
  const rows: SourceRow[] = [];
  let sequence = 0;
  for (const raw of lines) {
    const cells = raw.includes('|') ? raw.split('|').map(s => s.trim()) : raw.includes('\t') ? raw.split('\t').map(s => s.trim()) : raw.trim().split(/\s{2,}/);
    const found = cells.map(headerKey);
    if (found.filter(Boolean).length >= 4) {
      columns = found;
      rows.push(makeRow({}, raw, 1, ++sequence));
      continue;
    }
    const values: Record<string,string> = {};
    (columns.length ? columns : headers).forEach((key, index) => { if(key) values[key] = cells[index] || ''; });
    rows.push(makeRow(values, raw, 1, ++sequence));
  }
  return { rows:flagOrder(rows), pages:1, text, columns:columns.filter(Boolean) };
}

/** Text-layer extraction only. Image-only PDFs remain unposted until a human supplies evidence. */
export async function extractPdf(file: File): Promise<ExtractedLedger> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
  const loadingTask = pdfjs.getDocument({data:new Uint8Array(await file.arrayBuffer())});
  const doc = await loadingTask.promise;
  const rows: SourceRow[] = [];
  const fullText: string[] = [];
  let columns: Column[] = [];
  let sequence = 0;
  try {
    for(let pageNumber=1;pageNumber<=doc.numPages;pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const cells: Cell[] = content.items.filter((item): item is typeof item & {str:string;transform:number[];width:number} => 'str' in item).map(item=>({text:item.str,x:item.transform[4],y:item.transform[5],width:item.width})).filter(item=>item.text.trim());
      const lines: Cell[][] = [];
      for(const cell of cells.sort((a,b)=>b.y-a.y || a.x-b.x)) {
        const line = lines.find(candidate=>Math.abs(candidate[0].y-cell.y)<3);
        if(line) line.push(cell); else lines.push([cell]);
      }
      for(const line of lines) {
        line.sort((a,b)=>a.x-b.x);
        const raw = line.map(cell=>cell.text).join(' | ');
        fullText.push(raw);
        const detected=line.map(cell=>({key:headerKey(cell.text),x:cell.x})).filter(col=>col.key);
        if(detected.length>=5) {
          columns=detected;
          rows.push(makeRow({},raw,pageNumber,++sequence));
          continue;
        }
        if(!columns.length) { rows.push(makeRow({},raw,pageNumber,++sequence)); continue; }
        const values:Record<string,string>={};
        for(const cell of line) {
          // Column anchors come from the printed header; assignments stay editable during review.
          let index=columns.findIndex((col,i)=>cell.x<(columns[i+1]?.x ?? Infinity)-5);
          if(index<0) index=columns.length-1;
          const key=columns[index].key;
          values[key]=(values[key]?`${values[key]} `:'')+cell.text;
        }
        rows.push(makeRow(values,raw,pageNumber,++sequence));
      }
    }
    if(!rows.some(row=>row.kind!=='excluded')) throw new Error('No ledger rows could be read confidently. Paste a delimited transcription below, or use a text-layer PDF. Scanned PDFs require a reviewed transcription.');
    return {rows:flagOrder(rows),pages:doc.numPages,text:fullText.join('\n'),columns:columns.map(col=>col.key)};
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
