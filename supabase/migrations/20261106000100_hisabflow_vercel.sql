-- Additive Vercel backend support. This does not copy, claim, or reassign owners.
-- Apply after 20261031000100_hisabflow_workspace.sql. Existing objects with
-- these names must be inspected rather than replaced or dropped.
begin;

create table public.hisabflow_auth_identity_links (
  google_user_id text primary key,
  owner_id text not null unique,
  created_at timestamptz not null default pg_catalog.statement_timestamp(),
  constraint hisabflow_identity_google_valid check (
    pg_catalog.char_length(google_user_id) between 1 and 200
    and pg_catalog.char_length(pg_catalog.btrim(google_user_id)) > 0
    and google_user_id !~ '[[:cntrl:]]'
  ),
  constraint hisabflow_identity_owner_valid check (
    pg_catalog.char_length(owner_id) between 1 and 200
    and pg_catalog.char_length(pg_catalog.btrim(owner_id)) > 0
    and owner_id !~ '[[:cntrl:]]'
  )
);

create table public.hisabflow_auth_oauth_flows (
  nonce_hash text primary key check (nonce_hash ~ '^[0-9a-f]{64}$'),
  intent text not null check (intent in ('signin', 'link')),
  sites_owner_id text,
  expires_at bigint not null,
  created_at bigint not null,
  constraint hisabflow_oauth_owner_valid check (
    (intent = 'signin' and sites_owner_id is null)
    or (intent = 'link' and sites_owner_id is not null
      and pg_catalog.char_length(sites_owner_id) between 1 and 200
      and pg_catalog.char_length(pg_catalog.btrim(sites_owner_id)) > 0
      and sites_owner_id !~ '[[:cntrl:]]')
  ),
  constraint hisabflow_oauth_time_valid check (
    created_at between 0 and 9007199254740991
    and expires_at between 0 and 9007199254740991
    and expires_at > created_at
    and expires_at - created_at <= 600000
  )
);
create index hisabflow_oauth_expiry_idx on public.hisabflow_auth_oauth_flows (expires_at);

alter table public.hisabflow_auth_identity_links enable row level security;
alter table public.hisabflow_auth_oauth_flows enable row level security;
revoke all privileges on table public.hisabflow_auth_identity_links,
  public.hisabflow_auth_oauth_flows from public, anon, authenticated, service_role;

-- No UPDATE/DELETE privilege exists on immutable identity links.
grant select, insert on table public.hisabflow_auth_identity_links to service_role;
grant select, insert, delete on table public.hisabflow_auth_oauth_flows to service_role;

create function public.hisabflow_link_google_identity(p_google_user_id text, p_owner_id text)
returns table(google_user_id text, owner_id text)
language plpgsql volatile security invoker set search_path = ''
as $hisabflow$
begin
  insert into public.hisabflow_auth_identity_links (google_user_id, owner_id)
  values (p_google_user_id, p_owner_id)
  on conflict do nothing;

  -- Both unique keys must still name this exact pair. No conflict updates it.
  if not exists (
    select 1 from public.hisabflow_auth_identity_links as linked
    where linked.google_user_id = p_google_user_id and linked.owner_id = p_owner_id
  ) then
    raise exception 'Identity pair conflicts with an existing link.' using errcode = '23505';
  end if;
  return query select linked.google_user_id, linked.owner_id
    from public.hisabflow_auth_identity_links as linked
    where linked.google_user_id = p_google_user_id and linked.owner_id = p_owner_id;
end;
$hisabflow$;

create function public.hisabflow_create_oauth_flow(
  p_nonce_hash text, p_intent text, p_sites_owner_id text,
  p_expires_at bigint, p_created_at bigint
)
returns boolean
language plpgsql volatile security invoker set search_path = ''
as $hisabflow$
begin
  -- An indexed cleanup cannot remove any still-valid flow.
  delete from public.hisabflow_auth_oauth_flows where expires_at <= p_created_at;
  insert into public.hisabflow_auth_oauth_flows
    (nonce_hash, intent, sites_owner_id, expires_at, created_at)
  values (p_nonce_hash, p_intent, p_sites_owner_id, p_expires_at, p_created_at);
  return true;
end;
$hisabflow$;

create function public.hisabflow_consume_oauth_flow(p_nonce_hash text, p_now bigint)
returns table(nonce_hash text, intent text, sites_owner_id text, expires_at bigint, created_at bigint)
language plpgsql volatile security invoker set search_path = ''
as $hisabflow$
begin
  if p_nonce_hash is null or p_nonce_hash !~ '^[0-9a-f]{64}$'
    or p_now is null or p_now not between 0 and 9007199254740991 then
    raise exception 'Invalid OAuth flow request.' using errcode = '22023';
  end if;
  -- DELETE locks the row and returns it once, including racing callbacks.
  -- Expired or future flows are deleted as well, but never returned as valid.
  return query with consumed as (
    delete from public.hisabflow_auth_oauth_flows as pending
    where pending.nonce_hash = p_nonce_hash
    returning pending.nonce_hash, pending.intent, pending.sites_owner_id,
      pending.expires_at, pending.created_at
  ) select consumed.nonce_hash, consumed.intent, consumed.sites_owner_id,
      consumed.expires_at, consumed.created_at
    from consumed where consumed.expires_at > p_now and consumed.created_at <= p_now;
end;
$hisabflow$;

revoke all privileges on function public.hisabflow_link_google_identity(text, text),
  public.hisabflow_create_oauth_flow(text, text, text, bigint, bigint),
  public.hisabflow_consume_oauth_flow(text, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.hisabflow_link_google_identity(text, text),
  public.hisabflow_create_oauth_flow(text, text, text, bigint, bigint),
  public.hisabflow_consume_oauth_flow(text, bigint) to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('hisabflow-documents', 'hisabflow-documents', false, 20971520,
  array['application/pdf', 'text/csv', 'text/plain', 'image/png', 'image/jpeg', 'application/octet-stream']);

-- Other project storage policies cannot grant browser access to this bucket.
-- The server uses a service-only key and checks the exact authenticated owner.
create policy hisabflow_documents_server_only on storage.objects
  as restrictive for all to anon, authenticated
  using (bucket_id <> 'hisabflow-documents')
  with check (bucket_id <> 'hisabflow-documents');

notify pgrst, 'reload schema';
commit;
