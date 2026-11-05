// Isolated browser fixture. This module is never imported by the application.
import { createRoot } from 'react-dom/client';
import HisabApp from '../../components/hisab/hisab-app';
import type { Workspace } from '../../lib/types';
import '../../app/globals.css';
import '../../app/typography.css';

const initialWorkspace: Workspace = {
  business: 'Company actions QA', currency: 'PKR', openingCash: '0.00', audit: [],
  companies: [
    { id: 'CO-UNUSED', name: 'Unused QA Co', role: 'Customer', aliases: [], balance: '0.00', status: 'Active' },
    { id: 'CO-BALANCE', name: 'Balance QA Co', role: 'Supplier', aliases: [], balance: '-120.00', status: 'Active' },
    { id: 'CO-DRAFT', name: 'Draft QA Co', role: 'Supplier', aliases: [], balance: '0.00', status: 'Active' },
    { id: 'CO-LEDGER', name: 'Ledger QA Co', role: 'Customer', aliases: [], balance: '0.00', status: 'Active' },
  ],
  shipments: [{ id: 'SHP-QA', direction: 'Dispatch', companyId: 'CO-LEDGER', deliveryParty: 'QA destination', date: '2026-11-01', vehicle: 'QA-001', product: 'QA material', weight: '1.000', unit: 'units', rate: '100.00', amount: '100.00', status: 'Delivered', settlement: 'Settled' }],
  payments: [{ id: 'PAY-QA', direction: 'Received', date: '2026-11-01', companyId: 'CO-LEDGER', actor: 'Ledger QA Co', amount: '100.00', account: 'Business current', bankLabel: '', reference: 'QA-RECEIPT', treatment: 'Customer receipt', status: 'Allocated', balanceApplied: true }],
  imports: [{
    id: 'IMP-QA', name: 'QA draft statement.txt', hash: 'a'.repeat(64), createdAt: '2026-11-01T10:00:00Z', status: 'Draft', step: 1,
    mapping: { business: 'Company actions QA', issuer: 'QA statement issuer', counterpartyId: 'CO-DRAFT', perspective: 'Supplier statement', partyMeaning: 'Delivery recipient or destination', currency: 'PKR', unit: 'Metric tonnes', unitsConfirmed: false, history: 'Partial history', mode: 'Transactions', cutoff: '', direction: 'Receipt', openingBalance: '0.00', expectedClosing: '10.00' },
    rows: [{ id: 'ROW-QA', page: 1, sequence: 1, rawDate: '', proposedDate: '', effectiveDate: '', description: 'QA source row', party: 'QA destination', vehicle: '', weight: '1.000', rate: '10.00', goods: '10.00', paid: '', balance: '10.00', reference: 'QA-SOURCE', kind: 'goods', status: 'Needs review', issues: ['Confirm the missing source date.'], raw: 'QA source row | 1.000 | 10.00 | 10.00' }],
  }],
};

type SaveRequest = { data: Workspace; revision: number; action: string; detail: string };
let stored = structuredClone(initialWorkspace), revision = 1, activeOwner='QA-OWNER';
const requests: SaveRequest[] = [];
const waiting: { request: SaveRequest; resolve: (response: Response) => void }[] = [];
const qa = {
  requests,
  setOwner(id:string){activeOwner=id},
  get pendingCount() { return waiting.length; },
  snapshot: () => structuredClone(stored),
  releaseSave(status = 200) {
    const pending = waiting.shift();
    if (!pending) throw new Error('No mocked workspace save is pending.');
    if (status !== 200) { pending.resolve(Response.json({ error: 'Temporary QA save failure.' }, { status })); return; }
    stored = structuredClone(pending.request.data); revision++;
    pending.resolve(Response.json({ data: structuredClone(stored), revision }));
  },
};

declare global { interface Window { __companyActionsQA: typeof qa } }
window.__companyActionsQA = qa;
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
  if (url.pathname !== '/api/workspace') return nativeFetch(input, init);
  if (init?.method === 'PUT') {
    const request = JSON.parse(String(init.body)) as SaveRequest;
    requests.push(structuredClone(request));
    if(new Headers(init?.headers).get('X-Workspace-Owner')!==encodeURIComponent(activeOwner))return Response.json({error:'Workspace account changed.',code:'WORKSPACE_ACCOUNT_CHANGED'},{status:409});
    return new Promise<Response>(resolve => waiting.push({ request, resolve }));
  }
  return Response.json({ data: structuredClone(stored), revision, storage: 'isolated-test', user: { id:activeOwner, name: 'QA owner', email: 'qa-owner@example.invalid', provider: 'google' } });
};

createRoot(document.getElementById('root')!).render(<HisabApp/>);
