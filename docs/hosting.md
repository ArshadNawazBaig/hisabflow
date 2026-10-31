# Hosting HisabFlow with Google login

The Google-only app can run directly on Cloudflare Workers, outside the former `chatgpt.site` account. It uses Supabase for authentication and workspace snapshots, D1 for immutable identity links and short-lived OAuth state, and a private R2 bucket for original documents. App visitors do not need an OpenAI account.

No new Cloudflare deployment has been made. The CLI is not authenticated. The existing hosted site has not been renamed, transferred, or deleted.

## Use Arshad’s hosting account

From the project directory, sign in and confirm the account before creating resources:

```sh
npx wrangler login
npx wrangler whoami
```

Complete the browser flow using Arshad’s account. Create the resources in that same account, using unused names if these already exist:

```sh
npx wrangler d1 create hisabflow-auth
npx wrangler r2 bucket create hisabflow-documents
```

Keep the bucket private. See Cloudflare’s [D1 commands](https://developers.cloudflare.com/d1/wrangler-commands/) and [R2 bucket setup](https://developers.cloudflare.com/r2/buckets/create-buckets/).

## Prepare the deployment

Copy `cloudflare.config.example.json` into ignored `.cloudflare/config.json`. Fill in the actual account ID, returned D1 UUID, resource names, Supabase publishable key, and the exact new HTTPS origin. Use the actual `workers.dev` origin for the initial deployment, or an already configured custom domain. Do not use a guessed Arshad address or the former account’s hostname.

The file accepts public configuration only. The server secret key belongs in Cloudflare’s secrets store, not this JSON file, source control, or a command argument.

```sh
npm run build
node scripts/prepare-cloudflare.mjs
npx wrangler d1 migrations apply DB --remote --config .cloudflare/wrangler.deploy.json
npx wrangler secret put SUPABASE_SECRET_KEY --config .cloudflare/wrangler.deploy.json
npx wrangler deploy --config .cloudflare/wrangler.deploy.json
```

The secret command prompts privately for the existing selected Supabase project’s server secret. The preparation script reads only the supplied account configuration and built Worker metadata. It does not read `.env`, authenticate, create resources, copy old service bindings, or publish. Re-run the build and preparation after source changes.

## Set the Google return URL

In Supabase **Authentication → URL Configuration**, set Site URL to the confirmed new app origin and add `<new-origin>/auth/callback` to Redirect URLs. For local development add `http://127.0.0.1:5173/auth/callback` as well. The Google OAuth client’s authorized redirect URI remains `https://coeazyvaghocoxuzngcc.supabase.co/auth/v1/callback`.

After deployment, verify the actual returned hostname matches `HISABFLOW_APP_ORIGIN`, Google sign-in returns to `/auth/callback`, unsigned data/file requests fail, and the signed-in user can save and reload only their own records.

## Existing records and documents

Moving hosting does not automatically move the former Site’s D1 identity links, map its user IDs to Google users, or copy its private R2 documents. Existing Supabase snapshots remain under their original owner IDs. Preserve the old resources until any required ownership transfer and document migration has been explicitly reviewed and verified. Do not merge accounts merely because their email addresses match.
