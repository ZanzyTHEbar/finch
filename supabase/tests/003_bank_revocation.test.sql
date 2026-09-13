begin;
select plan(15);

insert into auth.users (id, email)
values ('88888888-8888-4888-8888-888888888888', 'revocation@example.test');
insert into public.workspaces (id, name)
values ('99999999-9999-4999-8999-999999999999', 'Revocation workspace');
insert into public.bank_connections (id, workspace_id, provider, aspsp_name, aspsp_country, created_by)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '99999999-9999-4999-8999-999999999999', 'enablebanking', 'Example Bank', 'PT', '88888888-8888-4888-8888-888888888888');

update public.bank_connections set status = 'revocation_pending' where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
select results_eq(
  $$select status::text from public.bank_connections where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'$$,
  array['revocation_pending'],
  'a pending authorization can enter deletion revocation'
);

update public.bank_connections set status = 'revoked' where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
select results_eq(
  $$select status::text from public.bank_connections where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'$$,
  array['revoked'],
  'a connection without a provider session can be terminally revoked'
);

insert into public.bank_connections (id, workspace_id, provider, aspsp_name, aspsp_country, status, created_by)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '99999999-9999-4999-8999-999999999999', 'enablebanking', 'Active Bank', 'PT', 'active', '88888888-8888-4888-8888-888888888888');
insert into public.accounts (id, workspace_id, bank_connection_id, external_ref, name, account_type, currency, status)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '99999999-9999-4999-8999-999999999999', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'active-account', 'Active account', 'checking', 'EUR', 'active');
insert into public.transactions (id, workspace_id, bank_connection_id, account_id, source_fingerprint, amount_minor, currency, booking_date, status)
values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '99999999-9999-4999-8999-999999999999', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'active-transaction', 1, 'EUR', current_date, 'booked');
update public.bank_connections set status = 'revocation_pending' where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

select throws_ok(
  $$update public.accounts set name = 'Blocked account write' where id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'$$,
  '55000',
  'bank connection is not active',
  'account writes stop when revocation begins'
);
select throws_ok(
  $$update public.transactions set raw_description = 'Blocked transaction write' where id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'$$,
  '55000',
  'bank connection is not active',
  'transaction writes stop when revocation begins'
);
select throws_ok(
  $$insert into public.transaction_observations (workspace_id, transaction_id, bank_connection_id, source_fingerprint, payload_hash)
    values ('99999999-9999-4999-8999-999999999999', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'blocked-observation', decode(repeat('00', 32), 'hex'))$$,
  '55000',
  'bank connection is not active',
  'transaction observations stop when revocation begins'
);
select ok(
  exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and indexname = 'bank_connections_workspace_created_idx'
  ),
  'connection pagination has its workspace and descending cursor index'
);

insert into public.bank_connections (id, workspace_id, provider, aspsp_name, aspsp_country, status, created_by)
values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', '99999999-9999-4999-8999-999999999999', 'enablebanking', 'Disconnect Bank', 'PT', 'revocation_pending', '88888888-8888-4888-8888-888888888888');
set local role service_role;
set local request.jwt.claim.role = 'service_role';
select public.store_bank_connection_secret('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'disconnect-session-secret');
select results_eq(
  $$select public.complete_bank_disconnect('99999999-9999-4999-8999-999999999999', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', '88888888-8888-4888-8888-888888888888')::text$$,
  array['true'],
  'service completion atomically reports a completed bank disconnect'
);
reset role;
select ok(
  (select status = 'revoked' and vault_secret_id is null from public.bank_connections where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),
  'completion revokes the scoped connection and clears its Vault secret reference'
);
select ok(
  not exists (select 1 from vault.secrets where name = 'bank_connection_eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),
  'completion deletes the Vault secret'
);
select ok(
  exists (
    select 1
    from public.audit_events
    where workspace_id = '99999999-9999-4999-8999-999999999999'
      and actor_id = '88888888-8888-4888-8888-888888888888'
      and action = 'bank.connection.disconnected'
      and resource_type = 'bank_connection'
      and resource_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
      and outcome = 'success'
  ),
  'completion records its safe success audit with the actor'
);
select ok(
  has_function_privilege('service_role', 'public.complete_bank_disconnect(uuid,uuid,uuid)', 'execute')
    and not has_function_privilege('anon', 'public.complete_bank_disconnect(uuid,uuid,uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.complete_bank_disconnect(uuid,uuid,uuid)', 'execute'),
  'only the service role can execute bank disconnect completion'
);

insert into public.bank_connections (id, workspace_id, provider, aspsp_name, aspsp_country, status, created_by)
values ('ffffffff-ffff-4fff-8fff-ffffffffffff', '99999999-9999-4999-8999-999999999999', 'enablebanking', 'Retry Bank', 'PT', 'revocation_pending', '88888888-8888-4888-8888-888888888888');
set local role service_role;
set local request.jwt.claim.role = 'service_role';
select public.store_bank_connection_secret('ffffffff-ffff-4fff-8fff-ffffffffffff', 'retry-session-secret');
select throws_ok(
  $$select public.complete_bank_disconnect('99999999-9999-4999-8999-999999999999', 'ffffffff-ffff-4fff-8fff-ffffffffffff', '00000000-0000-4000-8000-000000000000')$$,
  '23503',
  null,
  'a failed completion transaction rolls back'
);
reset role;
select ok(
  (
    select c.status = 'revocation_pending'
      and c.vault_secret_id is not null
      and exists (select 1 from vault.secrets as s where s.id = c.vault_secret_id)
    from public.bank_connections as c
    where c.id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  ),
  'a failed completion leaves the connection and secret retryable'
);

insert into public.bank_connections (id, workspace_id, provider, aspsp_name, aspsp_country, status, created_by)
values ('11111111-1111-4111-8111-111111111111', '99999999-9999-4999-8999-999999999999', 'enablebanking', 'Already Revoked Bank', 'PT', 'revoked', '88888888-8888-4888-8888-888888888888');
set local role service_role;
set local request.jwt.claim.role = 'service_role';
select public.store_bank_connection_secret('11111111-1111-4111-8111-111111111111', 'already-revoked-session-secret');
select lives_ok(
  $$select public.complete_bank_disconnect('99999999-9999-4999-8999-999999999999', '11111111-1111-4111-8111-111111111111', '88888888-8888-4888-8888-888888888888')$$,
  'completion is idempotent after a concurrent terminal revocation'
);
reset role;
select ok(
  not exists (select 1 from vault.secrets where name = 'bank_connection_11111111-1111-4111-8111-111111111111')
    and (select vault_secret_id is null from public.bank_connections where id = '11111111-1111-4111-8111-111111111111'),
  'idempotent completion deletes a secret left by a terminal revocation race'
);

select * from finish();
rollback;
