import type { Company, ImportBatch, ImportMapping, SourceRow, Workspace } from './types';
import type { ExtractedLedger } from './pdf-extract';
import { suggestedDate } from './pdf-extract.ts';
import { compare, multiply, postImport, reconcile, subtract, validMoney, validateImport, type Reconciliation } from './accounting.ts';

export type AutomaticImportChoices = {
  companyName: string;
  relationship: '' | 'Customer' | 'Supplier';
  perspective?: ImportMapping['perspective'];
  unit: string;
  history: 'Complete history' | 'Partial history';
};
export type AutomaticImportPlan = {
  batch: ImportBatch;
  choices: AutomaticImportChoices;
  company: Company | null;
  newCompany: Company | null;
  readyRows: number;
  reviewRows: SourceRow[];
  blockers: string[];
  totals: Reconciliation;
};

const canonical = (value: string) => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
const blankTotals = (): Reconciliation => ({ goods: '0.00', paid: '0.00', closing: '0.00', goodsCount: 0, paymentCount: 0, transitions: [], balanced: false });

export function createAutomaticDraft(extraction: ExtractedLedger, source: { id: string; name: string; hash: string; fileKey?: string; business: string; currency: string }): ImportBatch {
  return {
    id: source.id, name: source.name, hash: source.hash, fileKey: source.fileKey, createdAt: new Date().toISOString(), status: 'Draft', step: 1,
    mapping: { business: source.business, issuer: extraction.metadata.issuerGuess, counterpartyId: '', perspective: '', partyMeaning: 'Delivery recipient or destination', currency: source.currency, unit: 'Metric tonnes', unitsConfirmed: false, history: 'Partial history', mode: 'Transactions', cutoff: '', direction: '', openingBalance: extraction.metadata.openingBalance?.value || '0.00', expectedClosing: extraction.metadata.closingBalance?.value || '' },
    rows: structuredClone(extraction.rows), sourceMetadata: structuredClone(extraction.metadata), sourcePages: extraction.pages,
  };
}

/** Extract an explicitly named actor. This proposes an allocation for owner confirmation,
 * never creates a company from a remitter, destination or bank name. */
function paymentProposal(row: SourceRow, company: Company | null, direction: ImportMapping['direction']) {
  const description = row.description.trim();
  const complex = /\b(?:freight|fraight|mazda|tractor|advance|lab|test|fee|expense|deduction|munafa|profit|house|drawing|refund|return|rejected|behalf|cutter|for)\b/i.test(description);
  let actor = '';
  const transfer = /^(?:f[./\s]*t[.\s]*|bank\s+transfer|transfer|payment|paid|sent|send)\s+to\s+(.+)$/i.exec(description);
  const received = /^(?:rec(?:eived|ieved|ived)?\.?|receipt)\s+from\s+(.+)$/i.exec(description);
  const from = /^from\s+(.+)$/i.exec(description);
  const bankAccount = /^(.+?)\s+(?:UBL|MBL|Askari)\b.*\b(?:acct|account|bank|bnk)\b/i.exec(description);
  let wrongDirection = false;
  if (transfer) { actor = transfer[1]; wrongDirection = direction === 'Dispatch'; }
  else if (received || from) { actor = (received || from)![1]; wrongDirection = direction === 'Receipt'; }
  else if (bankAccount && !/\b(?:from|to|via|transfer|received|recieved|recived|receipt|paid|payment|sent|send|withdrawal|deposit|remittance)\b|^f[./\s]*t\b/i.test(bankAccount[1])) actor = bankAccount[1];
  actor = actor.replace(/\s+(?:UBL|MBL|Askari)\b.*$/i, '').trim();
  const actorClear = !!actor && actor.length <= 180 && !/[|\d]{4,}|\b(?:bank|bnk|acct|account)\b/i.test(actor);
  const sameCompany = !!company && [company.name, ...company.aliases].some(name => canonical(name) === canonical(actor));
  return {
    actor: actorClear ? actor : '',
    treatment: !complex && actorClear && !wrongDirection && company && direction
      ? sameCompany ? direction === 'Receipt' ? 'Supplier settlement' as const : 'Customer receipt' as const : 'Payment on behalf' as const
      : undefined,
    issue: complex ? 'Confirm the accounting treatment of this freight, fee, advance, deduction or other payment.' : wrongDirection ? 'Payment wording conflicts with the selected direction.' : !actorClear ? 'Confirm the actual payer or beneficiary from the source.' : '',
  };
}

export function prepareAutomaticImport(source: ImportBatch, workspace: Workspace, choices: AutomaticImportChoices, reviewer: string): AutomaticImportPlan {
  const blockers: string[] = [];
  const batch = structuredClone(source);
  delete batch.createdCompanyId;
  const name = choices.companyName.trim().replace(/\s+/g, ' ');
  const matches = name ? workspace.companies.filter(company => [company.name, ...company.aliases].some(alias => canonical(alias) === canonical(name))) : [];
  let company: Company | null = matches.length === 1 ? structuredClone(matches[0]) : null;
  let newCompany: Company | null = null;
  if (!name) blockers.push('Confirm the customer or supplier name.');
  if (!choices.relationship) blockers.push('Choose whether this company is your customer or supplier.');
  if (matches.length > 1) blockers.push('Several company records match this name. Resolve the company in advanced review.');
  if (name && choices.relationship && !matches.length) {
    company = newCompany = { id: `CO-${batch.id}`, name, role: choices.relationship, aliases: [], balance: '0.00', status: 'Active' };
    batch.createdCompanyId = company.id;
  }
  if (company && company.status !== 'Active') blockers.push('This company is inactive. Review its status before importing.');
  if (company && choices.relationship && company.role !== 'Both' && company.role !== choices.relationship) blockers.push('The selected relationship conflicts with the existing company role.');
  if (!choices.perspective) blockers.push('Confirm whose books the source statement represents.');
  if (choices.perspective === 'Third-party statement') blockers.push('Confirm the third-party issuer and allocations in advanced review.');
  if ((choices.relationship === 'Customer' && choices.perspective === 'Supplier statement') || (choices.relationship === 'Supplier' && choices.perspective === 'Customer statement')) blockers.push('The source perspective conflicts with the selected customer or supplier relationship.');
  if (!choices.unit.trim()) blockers.push('Confirm the quantity unit.');
  if (!batch.fileKey || !/^[a-f\d]{64}$/i.test(batch.hash)) blockers.push('Retain the original PDF and its verified hash before importing.');
  if (batch.sourceMetadata?.unreadablePages.length) blockers.push(`Pages ${batch.sourceMetadata.unreadablePages.join(', ')} have no readable text. Their records require review.`);
  if (!validMoney(batch.mapping.expectedClosing, true)) blockers.push('The printed closing balance was not found. Confirm it in advanced review.');
  if (company && choices.relationship && validMoney(batch.mapping.openingBalance, true) && compare(batch.mapping.openingBalance, '0') !== 0) {
    const expectedOpening = choices.relationship === 'Supplier' ? subtract('0', batch.mapping.openingBalance) : batch.mapping.openingBalance;
    if (compare(company.balance, expectedOpening) !== 0) blockers.push('The source opening balance does not match this company’s recorded balance. Review opening-balance accounting before posting history.');
  }

  batch.status = 'Draft';
  batch.mapping = { ...batch.mapping, business: workspace.business, counterpartyId: company?.id || '', direction: choices.relationship === 'Supplier' ? 'Receipt' : choices.relationship === 'Customer' ? 'Dispatch' : '', perspective: choices.perspective || '', issuer: choices.perspective === 'Own books' ? workspace.business : batch.mapping.issuer || name, currency: workspace.currency, unit: choices.unit, unitsConfirmed: false, history: choices.history, mode: 'Transactions' };
  const now = new Date().toISOString();
  batch.rows = batch.rows.map(row => {
    if (row.kind === 'excluded' || row.status === 'Excluded') return { ...row, status: 'Excluded' as const };
    const issues = row.issues.filter(issue => !/^Review payment actor, allocation, and accounting treatment/.test(issue));
    const effectiveDate = row.effectiveDate || suggestedDate(row.rawDate);
    if (!effectiveDate) issues.push('Confirm a valid effective date; the original source date is retained.');
    if (!validMoney(row.goods || '0') || !validMoney(row.paid || '0') || !validMoney(row.balance, true)) issues.push('Review the extracted amounts and running balance.');
    try {
      if (compare(row.goods || '0', '0') > 0) {
        if (!row.weight || !row.rate || compare(multiply(row.weight, row.rate), row.goods) !== 0) issues.push('Quantity × rate must equal the goods amount.');
      }
    } catch { issues.push('Review the extracted quantity and rate.'); }
    let actor = row.actor, treatment = row.treatment, companyId = row.companyId;
    if (row.kind === 'payment' || (validMoney(row.paid) && compare(row.paid, '0') > 0)) {
      const proposed = paymentProposal(row, company, batch.mapping.direction);
      actor = proposed.actor || actor;
      treatment = proposed.treatment;
      companyId = company?.id;
      if (proposed.issue) issues.push(proposed.issue);
      if (!treatment) issues.push('Review the proposed payment treatment and company allocation.');
    }
    const uniqueIssues = [...new Set(issues)];
    return { ...row, effectiveDate, actor, treatment, companyId, issues: uniqueIssues, status: uniqueIssues.length ? 'Needs review' as const : 'Approved' as const, reviewer: uniqueIssues.length ? undefined : reviewer, reviewedAt: uniqueIssues.length ? undefined : now };
  });
  let totals = blankTotals();
  try {
    totals = reconcile(batch.rows, batch.mapping.openingBalance);
    if (!totals.balanced) blockers.push('Source running balances do not all reconcile. Review the highlighted statement rows.');
    if (validMoney(batch.mapping.expectedClosing, true) && compare(totals.closing, batch.mapping.expectedClosing) !== 0) blockers.push('The calculated closing balance differs from the printed balance.');
  } catch { blockers.push('Resolve invalid source amounts before posting.'); }
  const reviewRows = batch.rows.filter(row => row.kind !== 'excluded' && row.status !== 'Approved');
  if (!reviewRows.length && company) {
    const preview = { ...batch, mapping: { ...batch.mapping, unitsConfirmed: true } };
    const candidate = newCompany ? { ...workspace, companies: [...workspace.companies, newCompany] } : workspace;
    blockers.push(...validateImport(preview, candidate));
  }
  batch.step = reviewRows.length || blockers.length ? 2 : 4;
  return { batch, choices: { ...choices, companyName: name }, company, newCompany, readyRows: batch.rows.filter(row => row.kind !== 'excluded' && row.status === 'Approved').length, reviewRows, blockers: [...new Set(blockers)], totals };
}

/** A single owner confirmation applies the visible proposals. Ambiguous statements
 * retain all source rows as drafts; they never contribute unreviewed money. */
export function commitAutomaticImports(plans: AutomaticImportPlan[], workspace: Workspace, reviewer: string, confirmed: boolean) {
  if (!confirmed) throw new Error('Confirm the relationships, currency, units and proposed payment allocations before importing.');
  if (!plans.length) throw new Error('Choose at least one PDF statement.');
  let next = structuredClone(workspace);
  const postedIds: string[] = [], draftIds: string[] = [], newCompanyIds: string[] = [];
  const declared = new Set<string>(), hashes = new Set<string>();
  const now = new Date().toISOString();
  for (const original of plans) {
    if (hashes.has(original.batch.hash)) throw new Error('The same PDF is included more than once.');
    hashes.add(original.batch.hash);
    const existing = next.imports.find(batch => batch.hash === original.batch.hash || batch.id === original.batch.id);
    if (existing) {
      if (existing.status !== 'Draft' || existing.fileKey || existing.id !== original.batch.id || existing.hash !== original.batch.hash) throw new Error('This statement already exists. Open its existing import instead.');
      // Retry a failed original-file retention without abandoning its existing draft.
      next.imports = next.imports.filter(batch => batch.id !== existing.id);
    }
    const plan = prepareAutomaticImport(original.batch, next, original.choices, reviewer);
    if (!plan.company || !plan.choices.relationship || !plan.choices.companyName || !plan.batch.fileKey || !/^[a-f\d]{64}$/i.test(plan.batch.hash)) throw new Error('Confirm a company relationship and retain each original PDF before importing.');
    if (plan.newCompany) { next.companies.push(plan.newCompany); newCompanyIds.push(plan.newCompany.id); }
    const batch = structuredClone(plan.batch);
    batch.mapping.unitsConfirmed = true;
    batch.rows = batch.rows.map(row => row.status === 'Approved' ? { ...row, reviewer, reviewedAt: now } : row);
    if (!plan.reviewRows.length && !plan.blockers.length) {
      if (newCompanyIds.includes(plan.company.id) && !declared.has(plan.company.id)) { batch.createdCompanyId = plan.company.id; declared.add(plan.company.id); }
      else delete batch.createdCompanyId;
      next = postImport(batch, next, reviewer);
      postedIds.push(batch.id);
    } else {
      delete batch.createdCompanyId;
      batch.step = plan.reviewRows.length ? 2 : 1;
      next.imports.push(batch);
      draftIds.push(batch.id);
    }
  }
  return { workspace: next, postedIds, draftIds, newCompanyIds };
}
