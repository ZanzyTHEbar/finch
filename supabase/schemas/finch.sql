-- Finch is a fresh Supabase deployment. This declarative schema provisions an
-- empty cloud project; it intentionally contains no SQLite import, legacy
-- tables, compatibility views, or data transformation.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector with schema extensions;
create extension if not exists pgmq;
create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists supabase_vault with schema vault;

create schema if not exists private;
revoke all on schema private from public;
revoke all on schema public from anon;
grant usage on schema public to authenticated;

create type public.workspace_role as enum ('owner', 'admin', 'member', 'viewer');
create type public.workspace_state as enum ('active', 'deleting', 'deleted');
create type public.bank_connection_status as enum (
  'authorization_pending', 'active', 'expired', 'revocation_pending', 'revoked', 'error'
);
create type public.job_kind as enum (
  'bank.sync', 'search.embed', 'ai.summary', 'payment.status.poll', 'export.create', 'workspace.purge', 'storage.cleanup'
);
create type public.job_status as enum ('queued', 'running', 'succeeded', 'retry', 'dead', 'cancelled');
create type public.export_status as enum ('queued', 'running', 'ready', 'failed', 'expired');
create type public.deletion_status as enum ('queued', 'running', 'blocked', 'completed', 'failed');
create type public.ai_mode as enum ('disabled', 'embeddings', 'assistant');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspaces (
  id uuid primary key default extensions.gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 120),
  state public.workspace_state not null default 'active',
  deletion_requested_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (state = 'active' and deletion_requested_at is null and deleted_at is null)
    or (state = 'deleting' and deletion_requested_at is not null and deleted_at is null)
    or (state = 'deleted' and deletion_requested_at is not null and deleted_at is not null)
  )
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.workspace_role not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_members_user_id_idx on public.workspace_members(user_id, workspace_id);

create table public.workspace_ai_policies (
  workspace_id uuid primary key references public.workspaces(id) on delete restrict,
  mode public.ai_mode not null default 'disabled',
  embedding_provider text,
  embedding_model text,
  assistant_provider text,
  assistant_model text,
  policy_version integer not null default 1 check (policy_version > 0),
  updated_by uuid not null references auth.users(id) on delete restrict,
  updated_at timestamptz not null default now(),
  check (
    (mode = 'disabled' and embedding_provider is null and embedding_model is null and assistant_provider is null and assistant_model is null)
    or (mode = 'embeddings' and embedding_provider is not null and embedding_model is not null and assistant_provider is null and assistant_model is null)
    or (mode = 'assistant' and embedding_provider is not null and embedding_model is not null and assistant_provider is not null and assistant_model is not null)
  )
);

create table public.bank_connections (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  provider text not null check (provider = 'enablebanking'),
  provider_connection_ref text,
  vault_secret_id uuid,
  aspsp_name text not null,
  aspsp_country char(2) not null check (aspsp_country ~ '^[A-Z]{2}$'),
  status public.bank_connection_status not null default 'authorization_pending',
  consent_expires_at timestamptz,
  last_synced_at timestamptz,
  safe_error_code text,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id)
);
create index bank_connections_workspace_status_idx on public.bank_connections(workspace_id, status);
create index bank_connections_workspace_created_idx on public.bank_connections(workspace_id, created_at desc, id desc);
create unique index bank_connections_provider_ref_unique on public.bank_connections(provider, provider_connection_ref) where provider_connection_ref is not null;

create table public.bank_authorizations (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  connection_id uuid not null,
  user_id uuid not null references auth.users(id) on delete restrict,
  state_hash bytea not null unique check (octet_length(state_hash) = 32),
  return_path text not null check (return_path like '/%' and return_path not like '//%' and position(chr(92) in return_path) = 0),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, connection_id) references public.bank_connections(workspace_id, id) on delete restrict,
  check (expires_at > created_at),
  check (used_at is null or used_at <= now() + interval '1 minute')
);
create index bank_authorizations_connection_idx on public.bank_authorizations(connection_id, expires_at) where used_at is null;

create table public.accounts (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  bank_connection_id uuid not null,
  external_ref text not null,
  name text not null,
  account_type text not null check (account_type in ('checking', 'savings', 'cash', 'credit', 'other')),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  status text not null check (status in ('active', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (bank_connection_id, external_ref),
  foreign key (workspace_id, bank_connection_id) references public.bank_connections(workspace_id, id) on delete restrict
);
create index accounts_workspace_idx on public.accounts(workspace_id, created_at desc, id desc);

create table public.transactions (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  bank_connection_id uuid not null,
  account_id uuid not null,
  source_fingerprint text not null,
  external_transaction_id text,
  amount_minor numeric(20, 0) not null check (amount_minor <> 0),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  booking_date date not null,
  value_date date,
  raw_description text not null default '',
  merchant_name text,
  counterparty_name text,
  status text not null check (status in ('booked', 'pending', 'reversed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (bank_connection_id, source_fingerprint),
  foreign key (workspace_id, bank_connection_id) references public.bank_connections(workspace_id, id) on delete restrict,
  foreign key (workspace_id, account_id) references public.accounts(workspace_id, id) on delete restrict
);
create index transactions_workspace_booking_idx on public.transactions(workspace_id, booking_date desc, id);
create index transactions_account_booking_idx on public.transactions(workspace_id, account_id, booking_date desc, id desc);

create table public.transaction_observations (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  transaction_id uuid not null,
  bank_connection_id uuid not null,
  source_fingerprint text not null,
  observed_at timestamptz not null default now(),
  payload_hash bytea not null check (octet_length(payload_hash) = 32),
  provider_event_ref text,
  unique (workspace_id, id),
  unique (bank_connection_id, source_fingerprint, payload_hash),
  foreign key (workspace_id, transaction_id) references public.transactions(workspace_id, id) on delete restrict,
  foreign key (workspace_id, bank_connection_id) references public.bank_connections(workspace_id, id) on delete restrict
);
create index transaction_observations_workspace_idx on public.transaction_observations(workspace_id, observed_at desc);

create table public.receipts (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  -- Nullable while the legacy Edge route is still creating receipt rows.
  file_name text,
  idempotency_key text,
  sha256 bytea not null check (octet_length(sha256) = 32),
  object_key text not null unique check (object_key ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}$'),
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'application/pdf')),
  byte_size bigint not null check (byte_size > 0 and byte_size <= 10485760),
  total_minor numeric(20, 0),
  currency char(3) check (currency is null or currency ~ '^[A-Z]{3}$'),
  merchant text,
  receipt_date date,
  upload_state text not null check (upload_state in ('pending', 'ready', 'failed')),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id)
);
create index receipts_workspace_created_idx on public.receipts(workspace_id, created_at desc, id desc);
create unique index receipts_workspace_idempotency_key_unique
  on public.receipts(workspace_id, idempotency_key)
  where idempotency_key is not null;
create unique index receipts_workspace_sha256_unique
  on public.receipts(workspace_id, sha256)
  where upload_state <> 'failed';

create table public.receipt_matches (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  transaction_id uuid not null,
  receipt_id uuid not null,
  status text not null check (status in ('proposed', 'confirmed', 'rejected')),
  score numeric(5, 4) not null check (score between 0 and 1),
  decided_by uuid references auth.users(id) on delete restrict,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, transaction_id, receipt_id),
  foreign key (workspace_id, transaction_id) references public.transactions(workspace_id, id) on delete restrict,
  foreign key (workspace_id, receipt_id) references public.receipts(workspace_id, id) on delete restrict,
  check ((status = 'proposed' and decided_at is null and decided_by is null) or (status <> 'proposed' and decided_at is not null))
);

create table public.payment_orders (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  bank_connection_id uuid not null,
  provider_payment_ref text unique,
  client_request_id uuid not null,
  status text not null check (status in ('created', 'authorization_pending', 'submitting', 'submitted', 'accepted', 'rejected', 'submission_unknown')),
  creditor_name text not null,
  creditor_iban text not null,
  amount_minor numeric(20, 0) not null check (amount_minor > 0),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  remittance text,
  state_hash bytea not null unique check (octet_length(state_hash) = 32),
  return_path text not null check (return_path like '/%' and return_path not like '//%' and position(chr(92) in return_path) = 0),
  state_expires_at timestamptz not null,
  state_used_at timestamptz,
  authorization_url text,
  safe_error_code text,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, client_request_id),
  unique (workspace_id, id),
  foreign key (workspace_id, bank_connection_id) references public.bank_connections(workspace_id, id) on delete restrict,
  check (state_expires_at > created_at),
  check (state_used_at is null or state_used_at <= now() + interval '1 minute')
);
create index payment_orders_workspace_idx on public.payment_orders(workspace_id, created_at desc);

create table public.payment_provider_events (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  payment_id uuid not null,
  provider_event_ref text,
  status text not null,
  payload_hash bytea not null check (octet_length(payload_hash) = 32),
  observed_at timestamptz not null default now(),
  unique nulls not distinct (payment_id, provider_event_ref),
  foreign key (workspace_id, payment_id) references public.payment_orders(workspace_id, id) on delete restrict
);

create table public.finance_documents (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  source_type text not null check (source_type in ('account', 'transaction', 'receipt', 'summary')),
  source_id uuid not null,
  content text not null,
  content_hash bytea not null check (octet_length(content_hash) = 32),
  search_vector tsvector generated always as (to_tsvector('simple', content)) stored,
  embedding extensions.vector(1024),
  embedding_model text,
  embedding_policy_version integer,
  updated_at timestamptz not null default now(),
  unique (workspace_id, source_type, source_id),
  check ((embedding is null and embedding_model is null and embedding_policy_version is null) or (embedding is not null and embedding_model is not null and embedding_policy_version is not null))
);
create index finance_documents_workspace_fts_idx on public.finance_documents using gin(search_vector);
create index finance_documents_embedding_idx on public.finance_documents using hnsw (embedding extensions.vector_cosine_ops) where embedding is not null;

create table public.finance_summaries (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  period_start date not null,
  period_end date not null,
  content text not null,
  content_hash bytea not null check (octet_length(content_hash) = 32),
  policy_version integer not null check (policy_version > 0),
  model text not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, period_start, period_end, policy_version),
  check (period_end >= period_start)
);
create index finance_summaries_workspace_period_idx on public.finance_summaries(workspace_id, period_end desc);

create table public.aggregate_sequences (
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  aggregate_type text not null,
  aggregate_id uuid not null,
  next_sequence bigint not null default 1 check (next_sequence > 0),
  primary key (workspace_id, aggregate_type, aggregate_id)
);

create table public.domain_events (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  aggregate_type text not null,
  aggregate_id uuid not null,
  sequence bigint not null,
  event_type text not null,
  schema_version integer not null check (schema_version > 0),
  payload jsonb not null default '{}'::jsonb,
  payload_hash bytea not null check (octet_length(payload_hash) = 32),
  dedupe_key text,
  actor_id uuid references auth.users(id) on delete restrict,
  correlation_id uuid,
  occurred_at timestamptz not null default now(),
  unique (workspace_id, aggregate_type, aggregate_id, sequence),
  check (payload ?& array['authorization_code', 'provider_session', 'private_key', 'access_token'] is false)
);
create index domain_events_workspace_occurred_idx on public.domain_events(workspace_id, occurred_at desc);
create unique index domain_events_workspace_dedupe_key on public.domain_events(workspace_id, dedupe_key) where dedupe_key is not null;

create table public.audit_events (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete restrict,
  actor_id uuid references auth.users(id) on delete restrict,
  action text not null,
  resource_type text not null,
  resource_id uuid,
  outcome text not null check (outcome in ('success', 'denied', 'failed')),
  safe_error_code text,
  correlation_id uuid not null default extensions.gen_random_uuid(),
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  check (metadata ?& array['authorization_code', 'provider_session', 'private_key', 'access_token', 'iban', 'prompt', 'response'] is false)
);
create index audit_events_workspace_occurred_idx on public.audit_events(workspace_id, occurred_at desc);

create table public.job_requests (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  kind public.job_kind not null,
  payload jsonb not null,
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  status public.job_status not null default 'queued',
  attempts integer not null default 0 check (attempts >= 0 and attempts <= 8),
  available_at timestamptz not null default now(),
  lease_owner uuid,
  lease_expires_at timestamptz,
  lease_message_id bigint,
  safe_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (workspace_id, kind, idempotency_key),
  check (
    (status = 'running' and lease_owner is not null and lease_expires_at is not null and lease_message_id is not null)
    or (status <> 'running' and lease_owner is null and lease_expires_at is null and lease_message_id is null)
  ),
  check ((status in ('succeeded', 'dead', 'cancelled')) = (completed_at is not null))
);
create index job_requests_claim_idx on public.job_requests(status, available_at) where status in ('queued', 'retry');
create index job_requests_workspace_idx on public.job_requests(workspace_id, created_at desc);

create table public.data_exports (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  requested_by uuid not null references auth.users(id) on delete restrict,
  status public.export_status not null default 'queued',
  expires_at timestamptz,
  safe_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'ready') = (expires_at is not null))
);

create table public.data_export_parts (
  id uuid primary key default extensions.gen_random_uuid(),
  export_id uuid not null references public.data_exports(id) on delete restrict,
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  ordinal integer not null check (ordinal >= 1),
  object_key text not null unique check (object_key ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9]{4}\.tar\.gz$'),
  byte_size bigint not null check (byte_size > 0),
  sha256 bytea not null check (octet_length(sha256) = 32),
  created_at timestamptz not null default now(),
  unique (export_id, ordinal)
);
create index data_export_parts_workspace_idx on public.data_export_parts(workspace_id, export_id, ordinal);

create table public.deletion_requests (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null unique references public.workspaces(id) on delete restrict,
  requested_by uuid not null references auth.users(id) on delete restrict,
  status public.deletion_status not null default 'queued',
  safe_error_code text,
  remote_revocation_complete boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create function private.reject_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_table_name = 'domain_events'
     and tg_op = 'DELETE'
     and (select auth.role()) = 'service_role'
     and current_setting('finch.allow_domain_event_erasure', true) = 'on'
  then
    return old;
  end if;
  raise exception 'append-only relation % cannot be modified', tg_table_name using errcode = '55000';
end;
$$;

create function private.enforce_bank_connection_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = old.status then
    return new;
  end if;
  if (old.status = 'authorization_pending' and new.status in ('active', 'expired', 'revocation_pending', 'revoked', 'error'))
    or (old.status = 'active' and new.status in ('expired', 'revocation_pending', 'error'))
    or (old.status = 'expired' and new.status in ('revocation_pending', 'revoked'))
    or (old.status = 'revocation_pending' and new.status in ('revoked', 'error'))
    or (old.status = 'error' and new.status in ('authorization_pending', 'revocation_pending', 'revoked'))
  then
    return new;
  end if;
  raise exception 'invalid bank connection transition: % -> %', old.status, new.status using errcode = '22023';
end;
$$;

create function private.require_active_bank_connection()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- A share lock makes a disconnect wait for writes that began while active,
  -- and makes later sync writes re-check the committed connection state.
  perform 1
  from public.bank_connections as c
  where c.id = new.bank_connection_id
    and c.workspace_id = new.workspace_id
    and c.status = 'active'
  for share;
  if not found then
    raise exception 'bank connection is not active' using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger profiles_touch_updated_at before update on public.profiles for each row execute function private.touch_updated_at();
create trigger workspaces_touch_updated_at before update on public.workspaces for each row execute function private.touch_updated_at();
create trigger workspace_members_touch_updated_at before update on public.workspace_members for each row execute function private.touch_updated_at();
create trigger bank_connections_touch_updated_at before update on public.bank_connections for each row execute function private.touch_updated_at();
create trigger accounts_touch_updated_at before update on public.accounts for each row execute function private.touch_updated_at();
create trigger transactions_touch_updated_at before update on public.transactions for each row execute function private.touch_updated_at();
create trigger receipts_touch_updated_at before update on public.receipts for each row execute function private.touch_updated_at();
create trigger receipt_matches_touch_updated_at before update on public.receipt_matches for each row execute function private.touch_updated_at();
create trigger payment_orders_touch_updated_at before update on public.payment_orders for each row execute function private.touch_updated_at();
create trigger job_requests_touch_updated_at before update on public.job_requests for each row execute function private.touch_updated_at();
create trigger data_exports_touch_updated_at before update on public.data_exports for each row execute function private.touch_updated_at();
create trigger deletion_requests_touch_updated_at before update on public.deletion_requests for each row execute function private.touch_updated_at();
create trigger bank_connection_valid_transition before update on public.bank_connections for each row execute function private.enforce_bank_connection_transition();
create trigger accounts_active_bank_connection before insert or update on public.accounts for each row execute function private.require_active_bank_connection();
create trigger transactions_active_bank_connection before insert or update on public.transactions for each row execute function private.require_active_bank_connection();
create trigger transaction_observations_active_bank_connection before insert on public.transaction_observations for each row execute function private.require_active_bank_connection();
create trigger domain_events_immutable before update or delete on public.domain_events for each row execute function private.reject_mutation();
create trigger audit_events_immutable before update or delete on public.audit_events for each row execute function private.reject_mutation();
-- Observation/provider streams are append-only for all application callers.
-- Service-only deletion remains necessary for a completed erasure request.
create trigger transaction_observations_immutable before update on public.transaction_observations for each row execute function private.reject_mutation();
create trigger payment_provider_events_immutable before update on public.payment_provider_events for each row execute function private.reject_mutation();

create function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''));
  return new;
end;
$$;
create trigger auth_user_profile after insert on auth.users for each row execute function private.handle_new_user();

create function private.has_workspace_role(p_workspace_id uuid, p_roles public.workspace_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members as m
    join public.workspaces as w on w.id = m.workspace_id
    where m.workspace_id = p_workspace_id
      and m.user_id = (select auth.uid())
      and m.revoked_at is null
      and w.state = 'active'
      and m.role = any(p_roles)
  );
$$;

create function private.require_service_role()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
end;
$$;

create function private.require_owner_aal2(p_workspace_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_workspace_role(p_workspace_id, array['owner']::public.workspace_role[]) then
    raise exception 'workspace owner required' using errcode = '42501';
  end if;
  if coalesce((select auth.jwt() ->> 'aal'), '') <> 'aal2' then
    raise exception 'recent multi-factor authentication required' using errcode = '42501';
  end if;
end;
$$;

create function private.write_audit(
  p_workspace_id uuid,
  p_actor_id uuid,
  p_action text,
  p_resource_type text,
  p_resource_id uuid,
  p_outcome text,
  p_safe_error_code text default null,
  p_correlation_id uuid default null,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.audit_events (
    workspace_id, actor_id, action, resource_type, resource_id, outcome, safe_error_code, correlation_id, metadata
  ) values (
    p_workspace_id, p_actor_id, p_action, p_resource_type, p_resource_id, p_outcome,
    p_safe_error_code, coalesce(p_correlation_id, extensions.gen_random_uuid()), p_metadata
  );
$$;

create function public.fail_pending_receipt_upload(
  p_workspace_id uuid,
  p_receipt_id uuid,
  p_actor_id uuid,
  p_safe_error_code text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_upload_state text;
begin
  perform private.require_service_role();
  if p_safe_error_code not in ('receipt_hash_mismatch', 'receipt_metadata_mismatch') then
    raise exception 'invalid receipt upload failure code' using errcode = '22023';
  end if;

  update public.receipts
  set upload_state = 'failed'
  where workspace_id = p_workspace_id
    and id = p_receipt_id
    and upload_state = 'pending'
  returning upload_state into v_upload_state;

  if found then
    perform private.write_audit(
      p_workspace_id,
      p_actor_id,
      'receipt.upload_failed',
      'receipt',
      p_receipt_id,
      'failed',
      p_safe_error_code
    );
    return 'failed';
  end if;

  select upload_state into v_upload_state
  from public.receipts
  where workspace_id = p_workspace_id
    and id = p_receipt_id;

  if not found then
    return 'not_found';
  end if;
  if v_upload_state = 'failed' then
    return 'already_failed';
  end if;
  return 'not_pending';
end;
$$;

create function public.create_workspace(p_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
begin
  if (select auth.uid()) is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  insert into public.workspaces (name) values (trim(p_name)) returning id into v_workspace_id;
  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_workspace_id, (select auth.uid()), 'owner');
  insert into public.workspace_ai_policies (workspace_id, updated_by) values (v_workspace_id, (select auth.uid()));
  perform private.write_audit(v_workspace_id, (select auth.uid()), 'workspace.created', 'workspace', v_workspace_id, 'success');
  return v_workspace_id;
end;
$$;

create function public.set_workspace_ai_policy(
  p_workspace_id uuid,
  p_mode public.ai_mode,
  p_embedding_provider text default null,
  p_embedding_model text default null,
  p_assistant_provider text default null,
  p_assistant_model text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.has_workspace_role(p_workspace_id, array['owner', 'admin']::public.workspace_role[]) then
    raise exception 'workspace administrator required' using errcode = '42501';
  end if;
  update public.workspace_ai_policies
  set mode = p_mode,
      embedding_provider = case when p_mode in ('embeddings', 'assistant') then nullif(trim(p_embedding_provider), '') else null end,
      embedding_model = case when p_mode in ('embeddings', 'assistant') then nullif(trim(p_embedding_model), '') else null end,
      assistant_provider = case when p_mode = 'assistant' then nullif(trim(p_assistant_provider), '') else null end,
      assistant_model = case when p_mode = 'assistant' then nullif(trim(p_assistant_model), '') else null end,
      policy_version = policy_version + 1,
      updated_by = (select auth.uid()),
      updated_at = now()
  where workspace_id = p_workspace_id;
  if not found then
    raise exception 'workspace AI policy not found' using errcode = 'P0002';
  end if;
  perform private.write_audit(p_workspace_id, (select auth.uid()), 'ai.policy.updated', 'workspace_ai_policy', p_workspace_id, 'success');
end;
$$;

create function private.enqueue_finch_job(
  p_workspace_id uuid,
  p_kind public.job_kind,
  p_payload jsonb,
  p_idempotency_key text,
  p_delay_seconds integer default 0
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job_id uuid;
begin
  if p_delay_seconds < 0 or p_delay_seconds > 2592000 then
    raise exception 'job delay must be between zero and 30 days' using errcode = '22023';
  end if;
  insert into public.job_requests (workspace_id, kind, payload, idempotency_key)
  values (p_workspace_id, p_kind, p_payload, p_idempotency_key)
  on conflict (workspace_id, kind, idempotency_key) do nothing
  returning id into v_job_id;

  if v_job_id is null then
    select id into v_job_id
    from public.job_requests
    where workspace_id = p_workspace_id and kind = p_kind and idempotency_key = p_idempotency_key;
    return v_job_id;
  end if;

  update public.job_requests
  set available_at = now() + make_interval(secs => p_delay_seconds)
  where id = v_job_id;
  perform pgmq.send('finch_jobs', jsonb_build_object('job_id', v_job_id), p_delay_seconds);
  return v_job_id;
end;
$$;

create function public.enqueue_finch_job(
  p_workspace_id uuid,
  p_kind public.job_kind,
  p_payload jsonb,
  p_idempotency_key text,
  p_delay_seconds integer default 0
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_service_role();
  return private.enqueue_finch_job(p_workspace_id, p_kind, p_payload, p_idempotency_key, p_delay_seconds);
end;
$$;

create function public.append_domain_event(
  p_workspace_id uuid,
  p_aggregate_type text,
  p_aggregate_id uuid,
  p_event_type text,
  p_schema_version integer,
  p_payload jsonb,
  p_payload_hash bytea,
  p_actor_id uuid default null,
  p_correlation_id uuid default null,
  p_dedupe_key text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sequence bigint;
  v_event_id uuid;
begin
  perform private.require_service_role();
  insert into public.aggregate_sequences (workspace_id, aggregate_type, aggregate_id, next_sequence)
  values (p_workspace_id, p_aggregate_type, p_aggregate_id, 2)
  on conflict (workspace_id, aggregate_type, aggregate_id)
  do update set next_sequence = public.aggregate_sequences.next_sequence + 1
  returning next_sequence - 1 into v_sequence;
  insert into public.domain_events (
    workspace_id, aggregate_type, aggregate_id, sequence, event_type, schema_version,
    payload, payload_hash, actor_id, correlation_id, dedupe_key
  ) values (
    p_workspace_id, p_aggregate_type, p_aggregate_id, v_sequence, p_event_type, p_schema_version,
    p_payload, p_payload_hash, p_actor_id, p_correlation_id, p_dedupe_key
  ) on conflict do nothing returning id into v_event_id;
  if v_event_id is null and p_dedupe_key is not null then
    select id into v_event_id
    from public.domain_events
    where workspace_id = p_workspace_id and dedupe_key = p_dedupe_key;
  end if;
  return v_event_id;
end;
$$;

create function public.search_finances(p_workspace_id uuid, p_query text, p_limit integer default 20)
returns table (
  document_id uuid,
  source_type text,
  source_id uuid,
  content text,
  rank real
)
language sql
stable
security invoker
set search_path = ''
as $$
  select d.id, d.source_type, d.source_id, d.content,
         ts_rank_cd(d.search_vector, websearch_to_tsquery('simple', p_query)) as rank
  from public.finance_documents as d
  where d.workspace_id = p_workspace_id
    and private.has_workspace_role(p_workspace_id, array['owner', 'admin', 'member', 'viewer']::public.workspace_role[])
    and d.search_vector @@ websearch_to_tsquery('simple', p_query)
  order by rank desc, d.id
  limit least(greatest(p_limit, 1), 50);
$$;

create function public.claim_finch_jobs(p_worker_id uuid, p_limit integer default 10)
returns table (
  message_id bigint,
  job_id uuid,
  workspace_id uuid,
  kind public.job_kind,
  payload jsonb,
  attempts integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_message record;
  v_job public.job_requests%rowtype;
  v_job_id uuid;
  v_scanned integer := 0;
  v_claimed integer := 0;
begin
  perform private.require_service_role();
  if p_limit < 1 or p_limit > 25 then
    raise exception 'job claim limit must be between 1 and 25' using errcode = '22023';
  end if;

  while v_scanned < 25 and v_claimed < p_limit loop
    select * into v_message from pgmq.read('finch_jobs', 300, 1);
    exit when not found;
    v_scanned := v_scanned + 1;

    begin
      v_job_id := (v_message.message ->> 'job_id')::uuid;
    exception when invalid_text_representation then
      if not pgmq.delete('finch_jobs', v_message.msg_id) then
        raise exception 'malformed job queue message could not be deleted' using errcode = 'P0001';
      end if;
      continue;
    end;

    update public.job_requests as j
      set status = 'dead',
        lease_owner = null,
        lease_expires_at = null,
        lease_message_id = null,
        safe_error_code = 'lease_expired_max_attempts',
        completed_at = now()
    where j.id = v_job_id
      and j.status = 'running'
      and j.lease_expires_at <= now()
      and j.lease_message_id = v_message.msg_id
      and j.attempts >= 8;
    if found then
      if not pgmq.archive('finch_jobs', v_message.msg_id) then
        raise exception 'expired job queue message could not be archived' using errcode = 'P0001';
      end if;
      continue;
    end if;

    update public.job_requests as j
    set status = 'running',
        attempts = j.attempts + 1,
        lease_owner = p_worker_id,
        lease_expires_at = now() + interval '5 minutes',
        lease_message_id = v_message.msg_id,
        safe_error_code = null
    where j.id = v_job_id
      and (
        j.status in ('queued', 'retry')
        or (
          j.status = 'running'
          and j.lease_expires_at <= now()
          and j.lease_message_id = v_message.msg_id
        )
      )
      and j.available_at <= now()
    returning * into v_job;

    if found then
      message_id := v_message.msg_id;
      job_id := v_job.id;
      workspace_id := v_job.workspace_id;
      kind := v_job.kind;
      payload := v_job.payload;
      attempts := v_job.attempts;
      v_claimed := v_claimed + 1;
      return next;
      continue;
    end if;

    select * into v_job from public.job_requests where id = v_job_id;
    if not found
       or v_job.status in ('succeeded', 'dead', 'cancelled')
       or (v_job.status = 'running' and v_job.lease_message_id is distinct from v_message.msg_id)
    then
      if not pgmq.delete('finch_jobs', v_message.msg_id) then
        raise exception 'stale job queue message could not be deleted' using errcode = 'P0001';
      end if;
    end if;
  end loop;
end;
$$;

create function public.complete_finch_job(p_worker_id uuid, p_message_id bigint, p_job_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_service_role();
  update public.job_requests
  set status = 'succeeded', lease_owner = null, lease_expires_at = null, lease_message_id = null, completed_at = now()
  where id = p_job_id
    and status = 'running'
    and lease_owner = p_worker_id
    and lease_message_id = p_message_id
    and lease_expires_at > now();
  if not found then
    return false;
  end if;
  if not pgmq.delete('finch_jobs', p_message_id) then
    raise exception 'job queue message could not be completed' using errcode = 'P0001';
  end if;
  delete from public.job_requests where id = p_job_id and kind = 'workspace.purge';
  return true;
end;
$$;

create function public.renew_finch_job(p_worker_id uuid, p_message_id bigint, p_job_id uuid, p_lease_seconds integer default 300)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_queue_updated boolean;
begin
  perform private.require_service_role();
  if p_lease_seconds < 60 or p_lease_seconds > 900 then
    raise exception 'job lease must be between 60 and 900 seconds' using errcode = '22023';
  end if;
  update public.job_requests
  set lease_expires_at = now() + make_interval(secs => p_lease_seconds)
  where id = p_job_id
    and status = 'running'
    and lease_owner = p_worker_id
    and lease_message_id = p_message_id
    and lease_expires_at > now();
  if not found then
    return false;
  end if;
  select exists(select 1 from pgmq.set_vt('finch_jobs', p_message_id, p_lease_seconds)) into v_queue_updated;
  if not v_queue_updated then
    raise exception 'job queue lease could not be renewed' using errcode = 'P0001';
  end if;
  return true;
end;
$$;

create function public.cancel_workspace_jobs(p_workspace_id uuid, p_exclude_job_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_service_role();
  delete from pgmq.q_finch_jobs
  where (message ->> 'job_id')::uuid in (
    select id from public.job_requests where workspace_id = p_workspace_id and id <> p_exclude_job_id
  );
  delete from pgmq.a_finch_jobs
  where (message ->> 'job_id')::uuid in (
    select id from public.job_requests where workspace_id = p_workspace_id and id <> p_exclude_job_id
  );
  delete from public.job_requests where workspace_id = p_workspace_id and id <> p_exclude_job_id;
end;
$$;

create function public.fail_finch_job(
  p_worker_id uuid,
  p_message_id bigint,
  p_job_id uuid,
  p_retryable boolean,
  p_safe_error_code text
)
returns public.job_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.job_requests%rowtype;
  v_delay_seconds integer;
  v_payment_id uuid;
begin
  perform private.require_service_role();
  select * into v_job
  from public.job_requests
  where id = p_job_id
    and status = 'running'
    and lease_owner = p_worker_id
    and lease_message_id = p_message_id
    and lease_expires_at > now()
  for update;
  if not found then
    raise exception 'job lease is not owned by this worker' using errcode = '42501';
  end if;

  if p_retryable and v_job.attempts < 8 then
    v_delay_seconds := least(3600, 30 * power(2, greatest(v_job.attempts - 1, 0))::integer);
    update public.job_requests
    set status = 'retry',
        available_at = now() + make_interval(secs => v_delay_seconds),
        lease_owner = null,
        lease_expires_at = null,
        lease_message_id = null,
        safe_error_code = left(coalesce(p_safe_error_code, 'provider_unavailable'), 120)
    where id = p_job_id;
    if not pgmq.delete('finch_jobs', p_message_id) then
      raise exception 'job queue message could not be retried' using errcode = 'P0001';
    end if;
    perform pgmq.send('finch_jobs', jsonb_build_object('job_id', p_job_id), v_delay_seconds);
    return 'retry';
  end if;

  update public.job_requests
    set status = 'dead',
        lease_owner = null,
        lease_expires_at = null,
        lease_message_id = null,
        safe_error_code = left(coalesce(p_safe_error_code, 'terminal_failure'), 120),
      completed_at = now()
  where id = p_job_id;
  if not pgmq.archive('finch_jobs', p_message_id) then
    raise exception 'job queue message could not be dead-lettered' using errcode = 'P0001';
  end if;
  if v_job.kind = 'payment.status.poll' then
    begin
      v_payment_id := (v_job.payload ->> 'payment_id')::uuid;
    exception when invalid_text_representation then
      v_payment_id := null;
    end;
    if v_payment_id is not null then
      update public.payment_orders as p
      set status = 'submission_unknown',
          safe_error_code = 'payment_status_poll_exhausted'
      where p.id = v_payment_id
        and p.workspace_id = v_job.workspace_id
        and p.status in ('created', 'authorization_pending', 'submitting', 'submitted');
      if found then
        perform private.write_audit(
          v_job.workspace_id,
          null,
          'payment.status_poll_exhausted',
          'payment_order',
          v_payment_id,
          'failed',
          'payment_status_poll_exhausted'
        );
      end if;
    end if;
  end if;
  perform private.write_audit(v_job.workspace_id, null, 'job.dead_lettered', 'job_request', p_job_id, 'failed', left(coalesce(p_safe_error_code, 'terminal_failure'), 120));
  return 'dead';
end;
$$;

create function public.get_worker_secret(p_name text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret text;
begin
  perform private.require_service_role();
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = p_name;
  if v_secret is null then
    raise exception 'required vault secret is missing' using errcode = 'P0001';
  end if;
  return v_secret;
end;
$$;

create function public.store_bank_connection_secret(p_connection_id uuid, p_session_secret text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
begin
  perform private.require_service_role();
  if char_length(p_session_secret) = 0 then
    raise exception 'session secret must not be blank' using errcode = '22023';
  end if;
  select vault.create_secret(p_session_secret, 'bank_connection_' || p_connection_id::text, 'Finch bank session secret') into v_secret_id;
  update public.bank_connections set vault_secret_id = v_secret_id where id = p_connection_id;
  if not found then
    raise exception 'bank connection not found' using errcode = 'P0002';
  end if;
  return v_secret_id;
end;
$$;

create function public.store_pending_bank_connection_secret(p_connection_id uuid, p_session_secret text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
begin
  perform private.require_service_role();
  if coalesce(char_length(p_session_secret), 0) = 0 then
    raise exception 'session secret must not be blank' using errcode = '22023';
  end if;

  perform 1
  from public.bank_connections
  where id = p_connection_id
    and status = 'authorization_pending'
  for update;
  if not found then
    raise exception 'authorization-pending bank connection not found' using errcode = 'P0002';
  end if;

  select vault.create_secret(p_session_secret, 'bank_connection_' || p_connection_id::text, 'Finch bank session secret') into v_secret_id;
  update public.bank_connections
  set vault_secret_id = v_secret_id
  where id = p_connection_id
    and status = 'authorization_pending';
  if not found then
    raise exception 'authorization-pending bank connection not found' using errcode = 'P0002';
  end if;
  return v_secret_id;
end;
$$;

create function public.read_bank_connection_secret(p_connection_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret text;
begin
  perform private.require_service_role();
  select d.decrypted_secret into v_secret
  from public.bank_connections as c
  join vault.decrypted_secrets as d on d.id = c.vault_secret_id
  where c.id = p_connection_id and c.status in ('active', 'expired', 'revocation_pending', 'error');
  if v_secret is null then
    raise exception 'active bank connection secret not found' using errcode = 'P0002';
  end if;
  return v_secret;
end;
$$;

create function public.destroy_bank_connection_secret(p_connection_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
begin
  perform private.require_service_role();
  select vault_secret_id into v_secret_id from public.bank_connections where id = p_connection_id for update;
  if v_secret_id is not null then
    perform vault.delete_secret(v_secret_id);
  end if;
  update public.bank_connections set vault_secret_id = null where id = p_connection_id;
end;
$$;

create function public.complete_bank_disconnect(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_actor_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status public.bank_connection_status;
  v_secret_id uuid;
begin
  perform private.require_service_role();

  select c.status, c.vault_secret_id into v_status, v_secret_id
  from public.bank_connections as c
  where c.workspace_id = p_workspace_id
    and c.id = p_connection_id
    and c.status in ('revocation_pending', 'revoked')
  for update;
  if not found then
    raise exception 'revocation-pending or revoked bank connection not found' using errcode = 'P0002';
  end if;

  if v_secret_id is not null then
    delete from vault.secrets where id = v_secret_id;
  end if;
  update public.bank_connections
  set vault_secret_id = null,
      status = 'revoked'
  where workspace_id = p_workspace_id
    and id = p_connection_id;
  if v_status = 'revoked' then
    return true;
  end if;
  perform private.write_audit(
    p_workspace_id,
    p_actor_id,
    'bank.connection.disconnected',
    'bank_connection',
    p_connection_id,
    'success'
  );
  return true;
end;
$$;

create function public.erase_workspace_domain_events(p_workspace_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_service_role();
  perform set_config('finch.allow_domain_event_erasure', 'on', true);
  delete from public.domain_events where workspace_id = p_workspace_id;
end;
$$;

create function public.consume_bank_authorization(p_state_hash bytea)
returns table (authorization_id uuid, workspace_id uuid, connection_id uuid, user_id uuid, return_path text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_service_role();
  return query
  update public.bank_authorizations
  set used_at = now()
  where state_hash = p_state_hash
    and used_at is null
    and expires_at > now()
  returning id, public.bank_authorizations.workspace_id, public.bank_authorizations.connection_id, public.bank_authorizations.user_id, public.bank_authorizations.return_path;
end;
$$;

create function public.resolve_payment_callback(
  p_state_hash bytea,
  p_resolution text,
  p_provider_payment_ref text,
  p_provider_status text,
  p_resolved_status text
)
returns table (payment_id uuid, workspace_id uuid, user_id uuid, return_path text, status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payment public.payment_orders%rowtype;
  v_result_status text;
begin
  perform private.require_service_role();
  if p_resolution not in ('provider_error', 'verification_failed', 'verified') then
    raise exception 'invalid payment callback resolution' using errcode = '22023';
  end if;

  select * into v_payment
  from public.payment_orders
  where state_hash = p_state_hash
  for update;
  if not found or v_payment.state_used_at is not null or v_payment.state_expires_at <= now() then
    return;
  end if;

  if p_resolution = 'verified' then
    if p_provider_payment_ref is null
      or p_provider_payment_ref is distinct from v_payment.provider_payment_ref
      or nullif(trim(p_provider_status), '') is null
      or p_resolved_status not in ('authorization_pending', 'submitted', 'accepted', 'rejected')
    then
      raise exception 'invalid verified payment callback' using errcode = '22023';
    end if;
    update public.payment_orders as p
    set state_used_at = now(),
        status = case when p.status in ('accepted', 'rejected') then p.status else p_resolved_status end,
        safe_error_code = case when p.status in ('accepted', 'rejected') then p.safe_error_code else null end
    where p.id = v_payment.id
    returning p.status into v_result_status;
    insert into public.payment_provider_events (
      workspace_id, payment_id, provider_event_ref, status, payload_hash
    ) values (
      v_payment.workspace_id,
      v_payment.id,
      p_provider_payment_ref || ':' || p_provider_status,
      p_provider_status,
      extensions.digest(convert_to(jsonb_build_array(p_provider_payment_ref, p_provider_status)::text, 'UTF8'), 'sha256')
    ) on conflict do nothing;
    if v_result_status in ('authorization_pending', 'submitted') then
      perform private.enqueue_finch_job(
        v_payment.workspace_id,
        'payment.status.poll',
        jsonb_build_object('payment_id', v_payment.id),
        'payment-status:' || v_payment.id::text || ':initial'
      );
    end if;
    perform private.write_audit(v_payment.workspace_id, v_payment.created_by, 'payment.authorization.verified', 'payment_order', v_payment.id, 'success');
  elsif p_resolution = 'provider_error' then
    update public.payment_orders as p
    set state_used_at = now(),
        status = case when p.status in ('accepted', 'rejected') then p.status else 'rejected' end,
        safe_error_code = case when p.status in ('accepted', 'rejected') then p.safe_error_code else 'payment_authorization_failed' end
    where p.id = v_payment.id
    returning p.status into v_result_status;
    perform private.write_audit(v_payment.workspace_id, v_payment.created_by, 'payment.authorization.failed', 'payment_order', v_payment.id, 'failed', 'payment_authorization_failed');
  else
    update public.payment_orders as p
    set state_used_at = now(),
        status = case when p.status in ('accepted', 'rejected') then p.status else 'submission_unknown' end,
        safe_error_code = case when p.status in ('accepted', 'rejected') then p.safe_error_code else 'payment_provider_verification_failed' end
    where p.id = v_payment.id
    returning p.status into v_result_status;
    perform private.write_audit(v_payment.workspace_id, v_payment.created_by, 'payment.authorization.verification_failed', 'payment_order', v_payment.id, 'failed', 'payment_provider_verification_failed');
  end if;

  return query
  select v_payment.id, v_payment.workspace_id, v_payment.created_by, v_payment.return_path, v_result_status;
end;
$$;

create function public.request_data_export(p_workspace_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_export_id uuid;
begin
  perform private.require_owner_aal2(p_workspace_id);
  insert into public.data_exports (workspace_id, requested_by) values (p_workspace_id, (select auth.uid())) returning id into v_export_id;
  perform private.enqueue_finch_job(p_workspace_id, 'export.create', jsonb_build_object('export_id', v_export_id), v_export_id::text);
  perform private.write_audit(p_workspace_id, (select auth.uid()), 'export.requested', 'data_export', v_export_id, 'success');
  return v_export_id;
end;
$$;

create function public.request_workspace_deletion(p_workspace_id uuid, p_confirm boolean)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deletion_id uuid;
begin
  if not p_confirm then
    raise exception 'explicit deletion confirmation required' using errcode = '22023';
  end if;
  perform private.require_owner_aal2(p_workspace_id);
  update public.workspaces set state = 'deleting', deletion_requested_at = now() where id = p_workspace_id and state = 'active';
  if not found then
    raise exception 'workspace is not active' using errcode = 'P0002';
  end if;
  insert into public.deletion_requests (workspace_id, requested_by) values (p_workspace_id, (select auth.uid())) returning id into v_deletion_id;
  perform private.enqueue_finch_job(p_workspace_id, 'workspace.purge', jsonb_build_object('deletion_id', v_deletion_id), v_deletion_id::text);
  perform private.write_audit(p_workspace_id, (select auth.uid()), 'workspace.deletion_requested', 'deletion_request', v_deletion_id, 'success');
  return v_deletion_id;
end;
$$;

create view public.bank_connections_safe
with (security_barrier = true)
as
select id, workspace_id, provider, aspsp_name, aspsp_country, status, consent_expires_at, last_synced_at, safe_error_code, created_at, updated_at
from public.bank_connections
where (select private.has_workspace_role(workspace_id, array['owner', 'admin', 'member', 'viewer']::public.workspace_role[]));

create view public.receipts_safe
with (security_barrier = true)
as
select id, workspace_id, file_name, encode(sha256, 'hex') as sha256, mime_type, byte_size, total_minor, currency, merchant, receipt_date, upload_state, created_by, created_at, updated_at
from public.receipts
where (select private.has_workspace_role(workspace_id, array['owner', 'admin', 'member', 'viewer']::public.workspace_role[]));

create view public.payment_orders_safe
with (security_barrier = true)
as
select id, workspace_id, status, authorization_url, safe_error_code, created_at, updated_at
from public.payment_orders
where (select private.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

create view public.data_exports_safe
with (security_barrier = true)
as
select id, workspace_id, requested_by, status, expires_at, safe_error_code, created_at, updated_at
from public.data_exports
where (select private.has_workspace_role(workspace_id, array['owner']::public.workspace_role[]));

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_ai_policies enable row level security;
alter table public.bank_connections enable row level security;
alter table public.bank_authorizations enable row level security;
alter table public.accounts enable row level security;
alter table public.transactions enable row level security;
alter table public.transaction_observations enable row level security;
alter table public.receipts enable row level security;
alter table public.receipt_matches enable row level security;
alter table public.payment_orders enable row level security;
alter table public.payment_provider_events enable row level security;
alter table public.finance_documents enable row level security;
alter table public.finance_summaries enable row level security;
alter table public.aggregate_sequences enable row level security;
alter table public.domain_events enable row level security;
alter table public.audit_events enable row level security;
alter table public.job_requests enable row level security;
alter table public.data_exports enable row level security;
alter table public.data_export_parts enable row level security;
alter table public.deletion_requests enable row level security;

create policy profiles_self_select on public.profiles for select to authenticated using (id = (select auth.uid()));
create policy workspaces_member_select on public.workspaces for select to authenticated using ((select private.has_workspace_role(id, array['owner', 'admin', 'member', 'viewer']::public.workspace_role[])));
create policy workspace_members_member_select on public.workspace_members for select to authenticated using ((select private.has_workspace_role(workspace_id, array['owner', 'admin', 'member', 'viewer']::public.workspace_role[])));
create policy workspace_ai_policies_admin_select on public.workspace_ai_policies for select to authenticated using ((select private.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[])));
create policy bank_connections_member_select on public.bank_connections for select to authenticated using ((select private.has_workspace_role(workspace_id, array['owner', 'admin', 'member', 'viewer']::public.workspace_role[])));
create policy bank_authorizations_self_select on public.bank_authorizations for select to authenticated using (user_id = (select auth.uid()) and (select private.has_workspace_role(workspace_id, array['owner', 'admin', 'member', 'viewer']::public.workspace_role[])));
create policy accounts_member_select on public.accounts for select to authenticated using ((select private.has_workspace_role(workspace_id, array['owner', 'admin', 'member', 'viewer']::public.workspace_role[])));
create policy transactions_member_select on public.transactions for select to authenticated using ((select private.has_workspace_role(workspace_id, array['owner', 'admin', 'member', 'viewer']::public.workspace_role[])));
create policy transaction_observations_admin_select on public.transaction_observations for select to authenticated using ((select private.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[])));
create policy receipts_member_select on public.receipts for select to authenticated using ((select private.has_workspace_role(workspace_id, array['owner', 'admin', 'member', 'viewer']::public.workspace_role[])));
create policy receipt_matches_member_select on public.receipt_matches for select to authenticated using ((select private.has_workspace_role(workspace_id, array['owner', 'admin', 'member', 'viewer']::public.workspace_role[])));
create policy payment_orders_admin_select on public.payment_orders for select to authenticated using ((select private.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[])));
create policy payment_provider_events_admin_select on public.payment_provider_events for select to authenticated using ((select private.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[])));
create policy finance_documents_member_select on public.finance_documents for select to authenticated using ((select private.has_workspace_role(workspace_id, array['owner', 'admin', 'member', 'viewer']::public.workspace_role[])));
create policy finance_summaries_member_select on public.finance_summaries for select to authenticated using ((select private.has_workspace_role(workspace_id, array['owner', 'admin', 'member', 'viewer']::public.workspace_role[])));
create policy domain_events_admin_select on public.domain_events for select to authenticated using ((select private.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[])));
create policy audit_events_owner_select on public.audit_events for select to authenticated using ((select private.has_workspace_role(workspace_id, array['owner']::public.workspace_role[])));
create policy data_exports_owner_select on public.data_exports for select to authenticated using ((select private.has_workspace_role(workspace_id, array['owner']::public.workspace_role[])));
create policy data_export_parts_owner_select on public.data_export_parts for select to authenticated using ((select private.has_workspace_role(workspace_id, array['owner']::public.workspace_role[])));
create policy deletion_requests_owner_select on public.deletion_requests for select to authenticated using ((select private.has_workspace_role(workspace_id, array['owner']::public.workspace_role[])));

revoke all on all tables in schema public from anon, authenticated;
grant select on public.profiles, public.workspaces, public.workspace_members, public.workspace_ai_policies, public.accounts, public.transactions, public.receipt_matches, public.finance_documents, public.finance_summaries to authenticated;
grant select on public.bank_connections_safe, public.receipts_safe, public.payment_orders_safe, public.data_exports_safe to authenticated;
grant all privileges on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

revoke all on all functions in schema public from public, anon, authenticated;
grant execute on function public.create_workspace(text) to authenticated;
grant execute on function public.set_workspace_ai_policy(uuid, public.ai_mode, text, text, text, text) to authenticated;
grant execute on function public.request_data_export(uuid) to authenticated;
grant execute on function public.request_workspace_deletion(uuid, boolean) to authenticated;
grant execute on function public.search_finances(uuid, text, integer) to authenticated;
grant execute on function public.enqueue_finch_job(uuid, public.job_kind, jsonb, text, integer) to service_role;
grant execute on function public.claim_finch_jobs(uuid, integer) to service_role;
grant execute on function public.complete_finch_job(uuid, bigint, uuid) to service_role;
grant execute on function public.renew_finch_job(uuid, bigint, uuid, integer) to service_role;
grant execute on function public.cancel_workspace_jobs(uuid, uuid) to service_role;
grant execute on function public.fail_finch_job(uuid, bigint, uuid, boolean, text) to service_role;
grant execute on function public.get_worker_secret(text) to service_role;
grant execute on function public.store_bank_connection_secret(uuid, text) to service_role;
grant execute on function public.store_pending_bank_connection_secret(uuid, text) to service_role;
grant execute on function public.read_bank_connection_secret(uuid) to service_role;
grant execute on function public.destroy_bank_connection_secret(uuid) to service_role;
grant execute on function public.complete_bank_disconnect(uuid, uuid, uuid) to service_role;
grant execute on function public.erase_workspace_domain_events(uuid) to service_role;
grant execute on function public.consume_bank_authorization(bytea) to service_role;
grant execute on function public.resolve_payment_callback(bytea, text, text, text, text) to service_role;
grant execute on function public.append_domain_event(uuid, text, uuid, text, integer, jsonb, bytea, uuid, uuid, text) to service_role;
grant execute on function public.fail_pending_receipt_upload(uuid, uuid, uuid, text) to service_role;

revoke all on schema private from anon, authenticated, service_role;
revoke all on all functions in schema private from public, anon, authenticated, service_role;
grant usage on schema private to authenticated;
grant execute on function private.has_workspace_role(uuid, public.workspace_role[]) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('receipt-originals', 'receipt-originals', false, 10485760, array['image/jpeg', 'image/png', 'application/pdf']),
  ('exports', 'exports', false, 104857600, null)
on conflict (id) do update
set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

revoke all on table storage.objects, storage.buckets from anon, authenticated;
create policy storage_authenticated_denied on storage.objects as restrictive for all to authenticated using (false) with check (false);
create policy storage_buckets_authenticated_denied on storage.buckets as restrictive for all to authenticated using (false) with check (false);

do $$
begin
  perform pgmq.create('finch_jobs');
exception when duplicate_table then
  null;
end;
$$;
