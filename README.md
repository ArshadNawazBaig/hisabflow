# HisabFlow

Private business workspace inspired by the supplied finance dashboard reference. Built with React/TypeScript, Vinext, Cloudflare Workers, Supabase Google authentication and PostgreSQL, D1 identity storage, and private R2 documents. App visitors sign in with Google; no OpenAI account is required by the application.

Local development: `npm run dev` serves `http://127.0.0.1:5173`. To run the compiled app after building and applying local migrations, stop the development server and run `npm start` on that same address. Both use your private root `.dev.vars` (preferred) or `.env`; the built local runner enables loopback authentication explicitly without changing production authentication. No deployment is required for local use.

## Run

Node 22.13+ is required. Run `npm ci`, `npm run build`, apply all pending local SQL migrations once, then `npm run dev`. Add the Supabase URL, publishable key, and server secret privately using `.dev.vars.example` or an ignored `.env`. Signed-out visitors are redirected to `/login`; `/signin` offers the same Google sign-in screen, and `/signup` provides account creation. Local development uses real Supabase Google OAuth. Allow `http://127.0.0.1:5173/auth/callback` in Supabase Authentication → URL Configuration.

```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_special_frog_thor.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0001_easy_maestro.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0002_gifted_lucky_pierre.sql
npm run dev
```

The dashboard is protected before HTML or RSC rendering. The request proxy verifies Google identity and persists refreshed cookies before rendering; API routes independently verify every data and document request. The app contains no demo fallback. New authenticated users explicitly create an empty workspace; loading and storage errors never substitute sample records. Structured records use an owner-scoped snapshot with optimistic revisions. The Supabase adapter preserves accounting validations, and each accepted save appends a server-authored audit event. Source files live in owner-scoped R2 paths and require authentication to retrieve.

## Install on a phone

HisabFlow uses single-page workspace navigation and can be installed as a standalone progressive web app. Open **Install app** in the workspace account menu or on the sign-in screen. Supported Android browsers open their installation prompt; when a prompt is unavailable, the app shows browser instructions. On iPhone/iPad, use Safari’s Share menu → Add to Home Screen, keep Open as Web App enabled if shown, then Add. Installed mode hides the install action.

Phone installation requires the deployed HTTPS address. Localhost/127.0.0.1 can be used for local PWA testing on this computer; an ordinary HTTP LAN address on a phone does not meet the secure-origin requirement. No publishing or hosting change is needed for the local build. The compiled `npm start` registers the service worker; development mode deliberately leaves it unregistered to avoid stale development assets.

The offline page contains no workspace data and offers a reconnect/retry action. An already-open workspace keeps its existing in-memory save/retry behavior; keep that tab open until pending changes are saved. Financial writes are never queued by a background worker. API responses, authenticated HTML, Google sign-in callbacks, original documents, and RSC payloads are never cached by the service worker. Only explicit public icons/fonts/versioned scripts/styles are cached, with a bounded cache size. App updates wait for confirmation, and the Update action is disabled while a workspace save needs attention.

The web manifest, Apple touch icon, regular and maskable app icons are in `public/`. Run `node scripts/generate-app-icons.mjs` after changing the brand mark. Bump the public cache version in `public/sw.js` when publishing a new app release so open installations can offer the update. The PWA browser suite checks real worker control, cache isolation, offline/reconnect, native/manual installation, standalone display, single-document navigation, and safe update activation against a temporary loopback server.

## Supabase connection

The selected project is `coeazyvaghocoxuzngcc`. Follow [the Supabase setup guide](docs/supabase.md) for schema, private credentials, and validation. `npm run check:supabase` performs a non-writing read/RPC readiness probe using ignored `.dev.vars`, `.env`, or server environment values. It does not replace a controlled create/update check. Existing D1 data is frozen by per-owner SQL write guards before copying; original files remain in R2. A hosting or identity change does not automatically transfer legacy owners or documents.

## Implemented workflows

- Mobile record and report lists use labeled cards; desktop lists retain tables. Lists start with five items and reveal five more at the end, including statement evidence, search results, and long modal lists. Loading placeholders cover the initial workspace request, pending list batches, and PDF processing. Filters reset the visible window; totals, reconciliation, and exports always use the full matching records.
- Customer/supplier company accounts show a negative balance when the company owes you and a positive credit/payable balance when you hold its credit or owe it. Historical stored accounting signs are preserved. Company details include Payments, Orders and Statements tabs, complete payment references, and company-scoped payment/advance/sale actions. Approved advances can be applied in full or part when creating a sale or later from Orders; source-linked applications never create another cash movement. Server checks prevent reusing advances, mixing company funds, backdating before receipt, applying future funds, overpaying an order, or changing an existing application. Ordinary receipts affect the company account; order labels specifically show advance coverage because other receipts are not linked to individual sales.
- Receipt and dispatch records with optional vehicles and quantities, three-decimal inputs, decimal-safe amount calculation, delivery status separate from accounting settlement, attachments, truck and delivery-party filters.
- Sale details separate customer payments/advances from supplier purchase costs. The cost editor can record a missing actual purchase receipt, add its supplier inline, preserve the allocation draft, and return after server acknowledgment. It reports mismatched or exhausted receipts and offers a clear next action when no source is available. Equivalent labels such as `t` / `Metric tonnes` and `kg` / `Kilograms` match without converting quantities; kilograms and tonnes stay distinct. Purchase quantity and actual purchase rate must be supplied, and fully reserved sources cannot be reused.
- Reviewed purchase/sale relationships and cost allocations from multiple purchase sources, including partial cost coverage; unmatched costs remain unresolved. Margin covers confirmed goods trading costs; unallocated freight, landed costs, and overhead are excluded, so this is not net profit.
- Actual remitter/beneficiary, accounting counterparty, on-behalf-of company, raw bank labels, string transaction references, own cash account, reviewed classifications, and supplier deductions without duplicate cash outflows.
- Multi-PDF upload reads the supplied ledger layouts, prefills company names, dates, vehicles, quantities, payments and references, and shows one combined preview. Confirm the customer/supplier relationship, source perspective and units once per statement. Confirmation creates or matches companies and posts fully reconciled statements atomically; ambiguous statements retain their prepared rows as linked drafts. Company records link directly to their statements and exceptions. PDF originals remain private, exact-file reuploads reuse the existing batch, and failed retention or save requests can be retried without duplicating records.
- Text-layer PDFs and reviewed delimited text/CSV transcription are supported. Pages without readable text are reported and block financial posting; OCR is not included. Delivery parties and payment actors are kept separate from accounting companies, and unusual payments or uncertain dates remain available for review.
- Retained file/hash/page/row/raw values/approved values/running balances/reviewer, private originals, exact-file and row-overlap duplicate protection, historical transactions versus an opening-balance cutoff, and immutable posted batches.
- CSV reports for cash flow, balances, deliveries, reviewed margin, and audit history. No invented invoices, due dates, allocations, or automatic overdue status.

## Validation

Run `npm run verify` for TypeScript, unit tests, application lint, the isolated browser suites, and a production build. This command does not need a Google login or production credentials and never writes to customer workspaces. On Linux/Windows, first install Chromium with `npx playwright install chromium`; macOS uses installed Google Chrome when available. `PLAYWRIGHT_CHROMIUM_EXECUTABLE` selects another installed Chromium browser. GitHub Actions runs the same verification on pushes and pull requests.

The infinite-list suites verify five-item increments, filter cancellation/reset, partial final batches, duplicate prevention, keyboard loading, scrollable modal roots, missing observer fallback, reduced-motion skeletons, loading errors, and server/client loading-layout hydration. They exercise desktop and 390px/320px mobile layouts against isolated synthetic records.

`npm run test:browser` exercises the actual application components against loopback fixtures with accounting validation. It covers empty-workspace onboarding, company actions, decimal purchases/sales, reviewed shipment matching and margin, receipts/settlements/noncash deductions, all five report exports, search, reloads, quoted CSV review and atomic posting, real multi-PDF extraction/posting, exception drafts, retained originals, duplicate uploads, save-failure recovery, restricted browser storage, and narrow mobile/dark layouts. The historical `records-browser.mjs` and `import-browser.mjs` commands now run this isolated workspace suite instead of the obsolete demo or customer-data tests.

With the real app running locally, `npm run test:auth` separately checks signed-out routes, OAuth initiation/cancellation, reset/logout, API protection, and cross-origin rejection. Use `HISABFLOW_TEST_ORIGIN` to target another local port. Completing Google consent in your own browser and checking a signed-in save/reload remain the final interactive authentication check. `npm run check:supabase` is a separate non-writing connectivity check; it requires your private server configuration.

Save requests include the identity loaded with the workspace. Switching Google accounts in another tab cannot redirect pending edits into the newly signed-in account. Temporary failures retain pending edits with a visible retry action and navigation warning; changes are acknowledged only after the complete save queue succeeds.

`npx tsc --noEmit` checks TypeScript. `node --experimental-strip-types --test tests/*.test.mjs` exercises accounting, source reconciliation, immutable postings, identity isolation, OAuth state, and fixed authentication feedback. `node tests/auth-pages-browser.mjs` verifies server/RSC redirects, Google-only login pages, callback routing, invalid-session recovery, and mobile layouts against the running local app using installed system Chrome.

`node tests/controls-browser.mjs` checks the shared custom dropdowns, date pickers, and account suggestions in a separate loopback component harness. It covers form values, validation, keyboard selection, reset, mobile/dark layouts, and the delivery, payment, report, and import screens without accessing real workspaces or changing the app's login guard.

`node tests/company-actions-browser.mjs` checks company View, Edit, and Delete actions with isolated fixtures, including keyboard navigation, protected account history, delete confirmation, save acknowledgment, retry, and mobile/dark layouts. It never changes a real workspace.

`node tests/pdf-browser.mjs` runs the actual PDF extractor on a sanitized generated ledger in Chromium, including a context without stream async iteration to catch Safari compatibility regressions. It uses a temporary loopback server and does not access real workspaces.

Both original ledgers were verified privately against their goods/payment counts, printed closing totals, source-order balance transitions and quantity multiplications. Only sanitized extraction, automation and accounting fixtures are tracked; the actual documents and their rows are not bundled or seeded into the app. No sample workspace is served by the app.

## Scope

This is a focused trading and statement-review application, not a complete statutory general ledger, tax filing system, inventory costing engine, or subscription billing system. No previous authentication/billing implementation was available to preserve. One authenticated owner has one business workspace in this version. Opening balances require a reviewed cutoff; changing the default currency does not convert existing amounts. Individual invoices/payment terms and complex quantity adjustments are not fabricated from ledger evidence.

The Google-only version is prepared for direct Cloudflare hosting under Arshad's account; see [hosting setup](docs/hosting.md). It has not been published to the former `chatgpt.site` address. Production requires the exact new HTTPS `HISABFLOW_APP_ORIGIN` and `<origin>/auth/callback` allowed in Supabase. Do not commit `.cloudflare/`, `.wrangler/`, `.sites-runtime/`, `.env*`, uploads, credentials, or local QA data.
