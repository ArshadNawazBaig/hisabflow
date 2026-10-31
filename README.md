# HisabFlow

Private business workspace inspired by the supplied finance dashboard reference. Built with React/TypeScript, Vinext, Cloudflare Workers, Supabase Google authentication and PostgreSQL, D1 identity storage, and private R2 documents. App visitors sign in with Google; no OpenAI account is required by the application.

## Run

Node 22.13+ is required. Run `npm ci`, `npm run build`, apply all pending local SQL migrations once, then `npm run dev`. Add the Supabase URL, publishable key, and server secret privately using `.dev.vars.example` or an ignored `.env`. Signed-out visitors are redirected to `/login`; `/signin` offers the same Google sign-in screen, and `/signup` provides account creation. Local development uses real Supabase Google OAuth. Allow `http://127.0.0.1:5173/auth/callback` in Supabase Authentication → URL Configuration.

```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_special_frog_thor.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0001_easy_maestro.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0002_gifted_lucky_pierre.sql
npm run dev
```

The dashboard is protected before HTML or RSC rendering. The request proxy verifies Google identity and persists refreshed cookies before rendering; API routes independently verify every data and document request. The app contains no demo fallback. New authenticated users explicitly create an empty workspace; loading and storage errors never substitute sample records. Structured records use an owner-scoped snapshot with optimistic revisions. The Supabase adapter preserves accounting validations, and each accepted save appends a server-authored audit event. Source files live in owner-scoped R2 paths and require authentication to retrieve.

## Supabase connection

The selected project is `coeazyvaghocoxuzngcc`. Follow [the Supabase setup guide](docs/supabase.md) for schema, private credentials, and validation. `npm run check:supabase` performs a non-writing read/RPC readiness probe using ignored `.dev.vars`, `.env`, or server environment values. It does not replace a controlled create/update check. Existing D1 data is frozen by per-owner SQL write guards before copying; original files remain in R2. A hosting or identity change does not automatically transfer legacy owners or documents.

## Implemented workflows

- Customer/supplier companies, signed balances (positive receivable, negative payable), deliberately reviewed aliases and source-linked activity.
- Receipt and dispatch records with optional vehicles and quantities, three-decimal inputs, decimal-safe amount calculation, delivery status separate from accounting settlement, attachments, truck and delivery-party filters.
- Reviewed purchase/sale relationships and cost allocations from multiple purchase sources, including partial cost coverage; unmatched costs remain unresolved. Margin covers confirmed goods trading costs; unallocated freight, landed costs, and overhead are excluded, so this is not net profit.
- Actual remitter/beneficiary, accounting counterparty, on-behalf-of company, raw bank labels, string transaction references, own cash account, reviewed classifications, and supplier deductions without duplicate cash outflows.
- Multi-PDF upload reads the supplied ledger layouts, prefills company names, dates, vehicles, quantities, payments and references, and shows one combined preview. Confirm the customer/supplier relationship, source perspective and units once per statement. Confirmation creates or matches companies and posts fully reconciled statements atomically; ambiguous statements retain their prepared rows as linked drafts. Company records link directly to their statements and exceptions. PDF originals remain private, exact-file reuploads reuse the existing batch, and failed retention or save requests can be retried without duplicating records.
- Text-layer PDFs and reviewed delimited text/CSV transcription are supported. Pages without readable text are reported and block financial posting; OCR is not included. Delivery parties and payment actors are kept separate from accounting companies, and unusual payments or uncertain dates remain available for review.
- Retained file/hash/page/row/raw values/approved values/running balances/reviewer, private originals, exact-file and row-overlap duplicate protection, historical transactions versus an opening-balance cutoff, and immutable posted batches.
- CSV reports for cash flow, balances, deliveries, reviewed margin, and audit history. No invented invoices, due dates, allocations, or automatic overdue status.

## Validation

`npx tsc --noEmit` checks TypeScript. `node --experimental-strip-types --test tests/*.test.mjs` exercises accounting, source reconciliation, immutable postings, identity isolation, OAuth state, and fixed authentication feedback. `node tests/auth-pages-browser.mjs` verifies server/RSC redirects, Google-only login pages, callback routing, invalid-session recovery, and mobile layouts against the running local app using installed system Chrome.

`node tests/controls-browser.mjs` checks the shared custom dropdowns, date pickers, and account suggestions in a separate loopback component harness. It covers form values, validation, keyboard selection, reset, mobile/dark layouts, and the delivery, payment, report, and import screens without accessing real workspaces or changing the app's login guard.

`node tests/pdf-browser.mjs` runs the actual PDF extractor on a sanitized generated ledger in Chromium, including a context without stream async iteration to catch Safari compatibility regressions. It uses a temporary loopback server and does not access real workspaces.

Both original ledgers were verified privately against their goods/payment counts, printed closing totals, source-order balance transitions and quantity multiplications. Only sanitized extraction, automation and accounting fixtures are tracked; the actual documents and their rows are not bundled or seeded into the app. No sample workspace is served by the app.

## Scope

This is a focused trading and statement-review application, not a complete statutory general ledger, tax filing system, inventory costing engine, or subscription billing system. No previous authentication/billing implementation was available to preserve. One authenticated owner has one business workspace in this version. Opening balances require a reviewed cutoff; changing the default currency does not convert existing amounts. Individual invoices/payment terms and complex quantity adjustments are not fabricated from ledger evidence.

The Google-only version is prepared for direct Cloudflare hosting under Arshad's account; see [hosting setup](docs/hosting.md). It has not been published to the former `chatgpt.site` address. Production requires the exact new HTTPS `HISABFLOW_APP_ORIGIN` and `<origin>/auth/callback` allowed in Supabase. Do not commit `.cloudflare/`, `.wrangler/`, `.sites-runtime/`, `.env*`, uploads, credentials, or local QA data.
