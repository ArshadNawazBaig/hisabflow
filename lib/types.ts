import type { LedgerMetadata } from './pdf-extract';

export type View = 'Overview' | 'Companies' | 'Deliveries' | 'Payments' | 'Imports' | 'Reports';
export type Company = { id: string; name: string; role: 'Customer' | 'Supplier' | 'Both'; contact?: string; email?: string; aliases: string[]; balance: string; status: 'Active' | 'Inactive' };
export type CostAllocation = { shipmentId: string; weight: string; amount: string };
export type AdvanceApplication = { id: string; companyId: string; paymentId: string; shipmentId: string; amount: string; date: string };
export type Shipment = { id: string; direction: 'Dispatch' | 'Receipt'; companyId: string; deliveryParty: string; date: string; vehicle: string; product: string; grade?: string; weight: string; unit: string; rate: string; amount: string; status: 'Delivered' | 'In transit' | 'Rejected' | 'Pending'; settlement?: string; sourceRef?: string; sourcePage?: number; sourceRow?: number; relatedDocument?: string; transporter?: string; destination?: string; notes?: string; attachment?: string; matchedId?: string; matchConfirmed?: boolean; costAllocations?: CostAllocation[]; costAllocationConfirmed?: boolean; costAllocationEvidence?: string };
export type Treatment = 'Supplier settlement' | 'Customer receipt' | 'Payment on behalf' | 'Supplier-agreed deduction' | 'Capitalized landed cost' | 'Operating expense' | 'Advance' | 'Owner drawing' | 'Other adjustment';
export type Payment = { id: string; direction: 'Received' | 'Paid'; date: string; companyId: string; actor: string; onBehalfOf?: string; amount: string; account: string; bankLabel: string; reference: string; treatment: Treatment; status: 'Allocated' | 'Needs review'; balanceApplied?: boolean; notes?: string; sourceRef?: string; evidence?: string };
export type SourceRow = { id: string; page: number; sequence: number; rawDate: string; proposedDate: string; effectiveDate: string; description: string; party: string; vehicle: string; weight: string; rate: string; goods: string; paid: string; balance: string; reference: string; kind: 'goods' | 'payment' | 'excluded'; status: 'Needs review' | 'Approved' | 'Excluded'; issues: string[]; raw: string; treatment?: Treatment; actor?: string; companyId?: string; reviewer?: string; reviewedAt?: string };
export type ImportMapping = { business: string; issuer: string; counterpartyId: string; perspective: '' | 'Own books' | 'Supplier statement' | 'Customer statement' | 'Third-party statement'; partyMeaning: string; currency: string; unit: string; unitsConfirmed: boolean; history: '' | 'Complete history' | 'Partial history'; mode: 'Transactions' | 'Opening balance'; cutoff: string; direction: '' | 'Receipt' | 'Dispatch'; openingBalance: string; expectedClosing: string; };
export type ImportBatch = { id: string; name: string; hash: string; createdAt: string; status: 'Draft' | 'Posted'; step: number; mapping: ImportMapping; rows: SourceRow[]; fileKey?: string; postedAt?: string; postedRecordIds?: string[]; createdCompanyId?: string; sourceMetadata?: LedgerMetadata; sourcePages?: number; };
export type AuditEvent = { id: string; at: string; action: string; detail: string; actor: string; sourceRef?: string };
export type Workspace = { business: string; currency: string; companies: Company[]; shipments: Shipment[]; payments: Payment[]; imports: ImportBatch[]; audit: AuditEvent[]; openingCash: string; advanceApplications?: AdvanceApplication[]; };
export type WorkspaceProps = { ownerId?:string; data: Workspace; update: (next: Workspace, action: string, detail: string) => void; notify: (message: string) => void; saveState?: 'saved' | 'saving' | 'error'; saveConflict?: boolean; retrySave?: () => void; };
/** Keep decimal strings exact while grouping and rounding their display value. */
export function money(v: string | number, decimals = 0): string {
  const formatter = new Intl.NumberFormat('en-PK', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  const value = String(v || 0).trim(), match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return formatter.format(Number(v || 0));
  const places = formatter.resolvedOptions().maximumFractionDigits ?? decimals;
  const fraction = match[3] || '';
  const scale = BigInt(10) ** BigInt(places);
  let units = BigInt(match[2]) * scale + BigInt(fraction.slice(0, places).padEnd(places, '0') || '0');
  if (fraction.length > places && Number(fraction[places]) >= 5) units++;
  const whole = new Intl.NumberFormat('en-PK', { maximumFractionDigits: 0 }).format(units / scale);
  return `${match[1] === '-' ? '-' : ''}${whole}${places ? `.${(units % scale).toString().padStart(places, '0')}` : ''}`;
}
export const today = () => new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Karachi', year:'numeric', month:'2-digit', day:'2-digit'}).format(new Date());
export const uid = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0,8).toUpperCase()}`;
