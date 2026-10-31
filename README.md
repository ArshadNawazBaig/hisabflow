# HisabFlow

Private business workspace inspired by the supplied finance dashboard reference. Built with React/TypeScript on the Sites Vinext starter, Cloudflare Workers, D1 or Supabase PostgreSQL, and private R2 document storage. No earlier master specification or application source was supplied, so this is a new implementation rather than a migration of an existing stack.

## Run

Node 22.13+ is required. Run `npm ci`, `npm run build`, apply the generated SQL migration locally, then `npm run dev`. The local sign-in page is `/signin-with-chatgpt?return_to=/`. Local development uses the starter's simulated identity; hosted identity and private site access are managed by Sites.

```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_special_frog_thor.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0001_easy_maestro.sql
npm run dev
```

The browser starts with explicitly fictional, unsaved sample data. **Start your workspace** creates an empty private workspace. Sample records are never copied into a user's business automatically. Hosted structured records use an owner-scoped snapshot with optimistic revisions. D1 remains active until Supabase is configured and verified; the Supabase adapter and migration preserve the same snapshot and accounting validations. Each accepted save appends a server-authored audit event. Source files live in owner-scoped R2 paths and require authentication to retrieve.

## Supabase connection

The selected project is `coeazyvaghocoxuzngcc`. Follow [the Supabase setup guide](docs/supabase.md) to apply its additive PostgreSQL migration, configure the server-only credential, verify access, and activate the provider. `npm run check:supabase` performs a non-writing read/RPC readiness probe using ignored `.dev.vars` or server environment values. It does not activate Supabase or replace a controlled create/update check. No dashboard URL or prepared code alone is treated as a live connection. Existing D1 data is frozen by per-owner SQL write guards before copying; original files remain in R2.

## Implemented workflows

- Customer/supplier companies, signed balances (positive receivable, negative payable), deliberately reviewed aliases and source-linked activity.
- Receipt and dispatch records with optional vehicles and quantities, three-decimal inputs, decimal-safe amount calculation, delivery status separate from accounting settlement, attachments, truck and delivery-party filters.
- Reviewed purchase/sale relationships and cost allocations from multiple purchase sources, including partial cost coverage; unmatched costs remain unresolved. Margin covers confirmed goods trading costs; unallocated freight, landed costs, and overhead are excluded, so this is not net profit.
- Actual remitter/beneficiary, accounting counterparty, on-behalf-of company, raw bank labels, string transaction references, own cash account, reviewed classifications, and supplier deductions without duplicate cash outflows.
- PDF text-layer extraction and delimited text/CSV transcription; upload, map, review, reconcile in source order, preview, confirm, and atomic posting. An image-only PDF can retain its original evidence while a human supplies a transcription. OCR is not included.
- Retained file/hash/page/row/raw values/approved values/running balances/reviewer, private originals, exact-file and row-overlap duplicate protection, historical transactions versus an opening-balance cutoff, and immutable posted batches.
- CSV reports for cash flow, balances, deliveries, reviewed margin, and audit history. No invented invoices, due dates, allocations, or automatic overdue status.

## Validation

`npx tsc --noEmit` checks TypeScript. `node --experimental-strip-types --test tests/*.test.mjs` exercises decimal arithmetic, source reconciliation, review gates, duplication, ownership-sensitive evidence, classifications, rejected deliveries, missing costs, immutable postings, and atomic effects. Browser QA uses the installed system Chrome through Playwright; scripts under `tests/` document the UI checks.

The user supplied PDF descriptions and aggregate totals, not the original PDFs. Aggregate arithmetic is tested and labeled as brief evidence. Synthetic fixtures test source-order transitions and anomalies; reproducing every transition from the actual two PDFs requires those original files. No real private company rows are shipped in the demo.

## Scope

This is a focused trading and statement-review application, not a complete statutory general ledger, tax filing system, inventory costing engine, or subscription billing system. No previous authentication/billing implementation was available to preserve. One authenticated owner has one business workspace in this version. Opening balances require a reviewed cutoff; changing the default currency does not convert existing amounts. Individual invoices/payment terms and complex quantity adjustments are not fabricated from ledger evidence.

Production publishing uses the Sites plugin workflow and preserves private access. Do not commit `.wrangler/`, `.sites-runtime/`, `.env*`, source uploads, credentials, or local QA data.
