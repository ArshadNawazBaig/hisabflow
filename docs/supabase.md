# HisabFlow Supabase connection

The selected project is [HisabFlow's Supabase project](https://supabase.com/dashboard/project/coeazyvaghocoxuzngcc), with API origin `https://coeazyvaghocoxuzngcc.supabase.co`. The dashboard URL identifies the project; it does not authenticate the application or apply its schema.

Database connection verified on 2026-10-31. The user applied the schema in the selected project's SQL Editor. Live server-key checks passed for create, read, update, stale-write rejection, insert-only migration, exact owner matching (including reserved characters), and denial of publishable-key access. The earlier local storage migration preserved its D1 snapshot and revision exactly. The current Google-only build remains local while hosting moves to Arshad's account; it has not replaced the former hosted version.

Two isolated, empty synthetic workspaces were used for the live round trip. They contain no business records and have owner IDs beginning `hisabflow-connection-check:`. Their exact IDs are recorded locally in `outputs/supabase-live-check.json`; `outputs/supabase-live-check-cleanup.sql` removes only those two rows through an administrative SQL connection. The application intentionally retains no DELETE privilege.

The database adapter stores the same complete workspace snapshot that D1 stores today. Existing accounting validation, atomic import posting, audit history, and optimistic revision checks remain in the server routes. Original documents remain in the existing private R2 bucket, so their evidence links do not change.

## Apply the schema before switching storage

Inspect the selected project's existing objects first. Apply [the additive migration](../supabase/migrations/20261031000100_hisabflow_workspace.sql) once through an authorized Supabase migration connection or the project's SQL Editor. It creates only `public.hisabflow_workspaces` and `public.hisabflow_save_workspace(text, jsonb, bigint)`, their constraints, comments, and object-specific grants. It does not seed business records or change unrelated tables. If either name already exists, inspect it and reconcile migration history; do not drop it or replace the function blindly.

The table stores a canonical owner ID as text, the workspace as JSONB, a positive JavaScript-safe revision, and the save timestamp. The write function creates a new owner only at expected revision zero; otherwise it updates the exact owner and revision. A conflicting write returns no rows, allowing the API to report a conflict instead of overwriting another tab's change.

## Configure server runtime values

Use the project's **Settings → API Keys** to obtain a server secret key. Supabase recommends secret keys for server code and publishable keys for shipped client code. The HisabFlow adapter uses the privileged key only on its authenticated server. Never put this value in a `NEXT_PUBLIC_` variable, browser bundle, source control, URL, or chat. See [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys).

For local development, copy [`.dev.vars.example`](../.dev.vars.example) into ignored `.dev.vars`, then fill the key locally:

```dotenv
SUPABASE_URL=https://coeazyvaghocoxuzngcc.supabase.co
SUPABASE_SECRET_KEY=YOUR_SERVER_SECRET_KEY
WORKSPACE_STORAGE_PROVIDER=d1
```

An ignored `.env` in the project root can contain these same server variables instead. If `.dev.vars` exists, it takes precedence over `.env`; keep the configuration in one of those files and restart the local server after changes. The connection checker follows that same file precedence and also accepts `NEXT_PUBLIC_SUPABASE_URL` for the nonsecret project URL. It requires `SUPABASE_SECRET_KEY` for privileged server access; `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` alone does not enable workspace storage. Never prefix the secret key with `NEXT_PUBLIC_`.

The placeholder is not a credential. Keep `d1` selected until the schema and live read/write probe have passed. A legacy service-role JWT is supported under the same server-only key variable for compatibility; a publishable or anonymous key cannot serve as this privileged connection.

For direct hosting, configure these names in Cloudflare Workers and store the server key as a secret; see [hosting setup](hosting.md). Local files do not configure the deployed Worker. Keep D1 and R2 bindings available. Select `WORKSPACE_STORAGE_PROVIDER=supabase` only after the schema and live connection checks pass. A configured Supabase failure reports an error and never silently routes writes back to D1.

## Identity and database access

Supabase Auth verifies Google sessions server-side. OAuth uses PKCE, HttpOnly cookies, same-origin initiation, and a one-use ten-minute nonce stored as a hash in D1. The server obtains the user from `auth.getUser()` and resolves its immutable owner mapping; it never trusts a browser-supplied owner or merely matching email addresses. Newly authenticated Google accounts receive `supabase:<verified-user-UUID>` unless an existing verified mapping already assigns a canonical owner. All workspace, upload, download, and evidence checks use that same owner. Former hosting identity headers and cookies do not authenticate the app.

Google authentication uses `SUPABASE_PUBLISHABLE_KEY`; workspace storage uses the separate server-only secret. Set `HISABFLOW_APP_ORIGIN` and Supabase's **Site URL** to the actual HTTPS production origin, add the exact `<origin>/auth/callback` under **Redirect URLs**, and save both settings. An unaccepted callback falls back to Site URL; leaving Site URL at localhost can send a production sign-in there. Start a fresh sign-in after updating URL settings. Changing hosting or login does not automatically claim legacy workspaces or copy their R2 evidence. Existing records remain untouched until any required ownership transfer is explicitly reviewed.

The migration enables RLS, removes table access from `PUBLIC`, `anon`, and `authenticated`, and creates no client policies. Only `service_role` receives table `SELECT`, `INSERT`, and `UPDATE`; it receives no table `DELETE` grant from this migration. The exact write RPC is executable only by `service_role` and runs as its caller with an empty search path. These controls are specific to the new HisabFlow objects. [Supabase's Data API security guide](https://supabase.com/docs/guides/api/securing-your-api) describes how grants and RLS work together; its [database functions guide](https://supabase.com/docs/guides/database/functions) covers function privileges.

The server secret bypasses RLS, so the application must keep its current authentication and owner-scoped queries. The database restrictions prevent public/client access; they do not replace the server's per-user authorization.

## Verify the connection

`npm run check:supabase` reads the private server configuration and checks table access plus the save function's validation guard without writing business rows. It does not prove every INSERT/UPDATE permission or activate the provider. Finish the controlled round-trip check below before cutover.

Before activation, inspect the schema and privileges without printing workspace data or keys:

```sql
select c.relrowsecurity, c.relforcerowsecurity
from pg_catalog.pg_class as c
join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'hisabflow_workspaces';

select role_name,
       pg_catalog.has_table_privilege(role_name, 'public.hisabflow_workspaces', 'SELECT') as can_select,
       pg_catalog.has_table_privilege(role_name, 'public.hisabflow_workspaces', 'INSERT') as can_insert,
       pg_catalog.has_table_privilege(role_name, 'public.hisabflow_workspaces', 'UPDATE') as can_update,
       pg_catalog.has_table_privilege(role_name, 'public.hisabflow_workspaces', 'DELETE') as can_delete,
       pg_catalog.has_function_privilege(role_name, 'public.hisabflow_save_workspace(text,jsonb,bigint)', 'EXECUTE') as can_call_rpc
from (values ('anon'), ('authenticated'), ('service_role')) as roles(role_name);

select p.prosecdef, p.proconfig
from pg_catalog.pg_proc as p
where p.oid = 'public.hisabflow_save_workspace(text,jsonb,bigint)'::pg_catalog.regprocedure;
```

Expected: RLS enabled; `anon` and `authenticated` have no listed privileges; `service_role` has select/insert/update/RPC execution, without delete; `prosecdef` is false and `proconfig` includes an empty search path. No `pg_policies` rows should exist for this table.

Verify a synthetic workspace through the server-side adapter: create at revision zero, read it back, update once, and confirm a stale write returns a conflict without changing data. Also verify an unsigned app request still receives `401`, and a signed user can access only the workspace selected by their server identity. Remove probe data using an authorized administrative connection; the app itself intentionally has no delete permission.

## Existing D1 workspaces and rollback

The app includes an additive D1 migration for `workspace_storage_locks(owner_id, target, locked_at)`. SQLite `BEFORE INSERT`, `BEFORE UPDATE`, and `BEFORE DELETE` triggers prevent writes to a locked owner's D1 workspace, including writes from an older deployed API version. The lock table starts empty: publishing this migration while D1 remains selected does not move records or activate Supabase.

For each authenticated canonical owner, the Supabase path first completes a successful read against the configured Supabase table. Only then does it serialize a D1 lock and read the owner's latest D1 snapshot. If Supabase is empty for that owner, it copies that frozen snapshot using insert-if-missing, preserving the exact data, revision, and audit history. It never overwrites an existing Supabase workspace. Concurrent first loads converge on the saved target row; source documents remain in R2. This storage migration preserves an existing owner key; it does not transfer ownership between login accounts.

The owner lock remains if copying fails, allowing a retry to use the same frozen source rather than creating divergent D1 writes. A request explicitly selecting D1 for a locked owner returns `503`; it does not serve a stale copy. The database triggers close the overlap with older API versions, so pausing requests or manually draining old Workers is optional operational caution rather than a requirement for this migration protocol.

The D1 copy is retained, but becomes historical after Supabase accepts new writes. Switching back to D1 without a reviewed resynchronization can lose visibility of those new records. Rollback requires comparing current revisions, reconciling newer Supabase snapshots back into D1, and deliberately releasing the owner's storage lock through an authorized migration procedure. Retaining D1 alone is not a synchronized backup, and simply changing the provider does not unlock it.

Do not report the database connected until authenticated live access, the schema, and a real round-trip probe have been verified. Preparing these files or knowing the project URL does not establish a connection.
