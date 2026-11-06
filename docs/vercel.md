# Vercel deployment

Production project: `arshadnawazbaigs-projects/hisabflow`.
Production origin: `https://hisabflow-seven.vercel.app`.

The Vercel build uses standard Next.js (`npm run build:vercel`). The existing
Vinext/Cloudflare build and local data remain available through the original
commands. The Next.js configuration replaces Cloudflare runtime bindings with
server-only Supabase adapters; it does not publish local D1 data or R2 files.

## One-time Supabase setup

1. In the selected project's [SQL Editor](https://supabase.com/dashboard/project/coeazyvaghocoxuzngcc/sql/new),
   run `supabase/migrations/20261106000100_hisabflow_vercel.sql`.
   This adds private identity links, atomic one-use OAuth state, and the private
   `hisabflow-documents` storage bucket. It does not copy or reassign any existing
   workspace or original document. The existing workspace migration must already
   be applied.
2. In [Authentication URL Configuration](https://supabase.com/dashboard/project/coeazyvaghocoxuzngcc/auth/url-configuration),
   set **Site URL** to `https://hisabflow-seven.vercel.app`, then add the exact
   `https://hisabflow-seven.vercel.app/auth/callback` to **Redirect URLs** and save
   both settings. Supabase falls back to Site URL if a requested callback is not
   accepted; leaving it as localhost can send a completed Google sign-in to this
   computer instead of the deployed app.
   Keep any existing local callback URLs still in use. The Google OAuth provider
   remains configured in Supabase.

After changing these settings, start a fresh sign-in at the production `/login`
page. An OAuth attempt already in progress can retain its previous destination.

The application uses the existing canonical `supabase:<user UUID>` owner IDs.
Moving hosting does not claim older workspaces with other owner IDs. Local data
and files remain untouched; moving those requires a separate reviewed migration.

## Production environment

Configure these in Vercel, with the server secret stored as an encrypted variable:

```text
SUPABASE_URL=https://coeazyvaghocoxuzngcc.supabase.co
SUPABASE_PUBLISHABLE_KEY=<publishable key>
SUPABASE_SECRET_KEY=<server-only secret>
WORKSPACE_STORAGE_PROVIDER=supabase
HISABFLOW_APP_ORIGIN=https://hisabflow-seven.vercel.app
NEXT_PUBLIC_HISABFLOW_HOSTING=vercel
```

The final public flag selects direct signed uploads in the browser and must be
present at build time. Original documents upload directly to the private bucket;
the server checks their owner, size, and SHA-256 before accepting them. Downloads
use short-lived signed URLs after the application authenticates the owner.

Do not set `HISABFLOW_LOCAL_RUNTIME` in Vercel. Local environment files, generated
artifacts, original documents, and credentials are excluded by `.vercelignore`.

## Deploy and verify

```sh
npm run typecheck
npm test
npm run build:vercel
vercel --prod
```

After the one-time setup, `npm run test:auth` can target the deployed origin with
`HISABFLOW_TEST_ORIGIN=https://hisabflow-seven.vercel.app`. It checks signed-out
pages/APIs, cross-origin rejection, and OAuth initiation/cancellation, including
the effective redirect returned by Supabase after provider cancellation. Complete
Google consent in a browser, then verify a workspace save/reload and a private
document upload/download using the same account.

Vercel limits individual function request payloads to 4.5 MB. Direct document
uploads preserve the app's 20 MiB file limit. Workspace snapshots still pass
through the application API, so very large workspace saves are subject to the
platform request limit even though the database accepts up to 8 MiB.
