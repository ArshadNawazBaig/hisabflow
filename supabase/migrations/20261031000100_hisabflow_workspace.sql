-- HisabFlow's Sites-authenticated server is the only Data API caller.
-- This migration is additive and contains no business data or credentials.
-- Apply once through the migration runner. Existing objects with these names
-- must be inspected rather than replaced or dropped.
begin;

create table public.hisabflow_workspaces (
  owner_id text primary key,
  data jsonb not null,
  revision bigint not null default 1,
  updated_at timestamptz not null default pg_catalog.statement_timestamp(),
  constraint hisabflow_workspace_owner_valid check (
    pg_catalog.char_length(owner_id) between 1 and 200
    and pg_catalog.char_length(pg_catalog.btrim(owner_id)) > 0
  ),
  constraint hisabflow_workspace_data_object check (
    pg_catalog.jsonb_typeof(data) = 'object'
  ),
  constraint hisabflow_workspace_data_size check (
    pg_catalog.octet_length(data::text) <= 8388608
  ),
  constraint hisabflow_workspace_revision_valid check (
    revision between 1 and 9007199254740991
  )
);

comment on table public.hisabflow_workspaces is
  'Private HisabFlow workspace snapshots. Access only through the Sites-authenticated application server.';
comment on column public.hisabflow_workspaces.owner_id is
  'Stable Sites user ID; deliberately text, not a Supabase Auth user UUID.';

alter table public.hisabflow_workspaces enable row level security;

-- Remove any Supabase project defaults, including DELETE on service_role.
-- RLS has no client policies: publishable keys and Supabase user sessions
-- cannot read or write this table directly.
revoke all privileges on table public.hisabflow_workspaces
  from public, anon, authenticated, service_role;
grant select, insert, update on table public.hisabflow_workspaces
  to service_role;

create function public.hisabflow_save_workspace(
  p_owner_id text,
  p_data jsonb,
  p_expected_revision bigint
)
returns table(data jsonb, revision bigint)
language plpgsql
volatile
security invoker
set search_path = ''
as $hisabflow$
begin
  if p_owner_id is null
    or pg_catalog.char_length(p_owner_id) not between 1 and 200
    or pg_catalog.char_length(pg_catalog.btrim(p_owner_id)) = 0 then
    raise exception 'A valid workspace owner is required.' using errcode = '22023';
  end if;

  if p_data is null or pg_catalog.jsonb_typeof(p_data) <> 'object' then
    raise exception 'Workspace data must be a JSON object.' using errcode = '22023';
  end if;

  if pg_catalog.octet_length(p_data::text) > 8388608 then
    raise exception 'Workspace data exceeds the 8 MiB limit.' using errcode = '22023';
  end if;

  if p_expected_revision is null
    or p_expected_revision < 0
    or p_expected_revision >= 9007199254740991 then
    raise exception 'The expected workspace revision is invalid.' using errcode = '22023';
  end if;

  if p_expected_revision = 0 then
    return query
      insert into public.hisabflow_workspaces as saved
        (owner_id, data, revision, updated_at)
      values
        (p_owner_id, p_data, 1, pg_catalog.statement_timestamp())
      on conflict (owner_id) do nothing
      returning saved.data, saved.revision;
  else
    return query
      update public.hisabflow_workspaces as saved
      set data = p_data,
          revision = saved.revision + 1,
          updated_at = pg_catalog.statement_timestamp()
      where saved.owner_id = p_owner_id
        and saved.revision = p_expected_revision
      returning saved.data, saved.revision;
  end if;
end;
$hisabflow$;

comment on function public.hisabflow_save_workspace(text, jsonb, bigint) is
  'Atomic workspace compare-and-swap. Expected revision 0 creates once; stale writes return no rows.';

revoke all privileges on function public.hisabflow_save_workspace(text, jsonb, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.hisabflow_save_workspace(text, jsonb, bigint)
  to service_role;

notify pgrst, 'reload schema';
commit;
