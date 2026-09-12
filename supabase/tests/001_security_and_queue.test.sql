begin;
select plan(19);

insert into auth.users (id, email)
values
  ('11111111-1111-1111-1111-111111111111', 'owner@example.test'),
  ('22222222-2222-2222-2222-222222222222', 'other@example.test');

insert into public.workspaces (id, name)
values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Owner workspace'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Other workspace');

insert into public.workspace_members (workspace_id, user_id, role)
values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'owner');

insert into public.workspace_ai_policies (workspace_id, updated_by)
values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222');

select ok(
  not has_table_privilege('anon', 'public.transactions', 'select,insert,update,delete'),
  'anonymous callers have no transaction privileges'
);
select ok(
  not has_table_privilege('authenticated', 'public.transactions', 'insert,update,delete'),
  'authenticated callers cannot directly mutate transactions'
);
select ok(
  has_table_privilege('authenticated', 'public.transactions', 'select'),
  'authenticated callers receive only the read capability guarded by RLS'
);

set local role anon;
select throws_ok(
  $$select * from public.workspaces$$,
  '42501',
  null,
  'anonymous callers cannot read workspaces'
);

set local role authenticated;
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select results_eq(
  $$select name from public.workspaces order by name$$,
  array['Owner workspace'],
  'a member reads only their active workspace'
);
select results_eq(
  $$select role::text from public.workspace_members where workspace_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'$$,
  array['owner'],
  'a member reads their own membership'
);
select throws_ok(
  $$insert into public.transactions (workspace_id, bank_connection_id, account_id, source_fingerprint, amount_minor, currency, booking_date, status)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'forged', 1, 'EUR', current_date, 'booked')$$,
  '42501',
  null,
  'a member cannot bypass command boundaries with direct transaction writes'
);

set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select is_empty(
  $$select * from public.workspaces where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'$$,
  'a forged workspace identifier returns no other workspace'
);
select is_empty(
  $$select * from public.workspace_members where workspace_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'$$,
  'a non-member cannot inspect another workspace membership'
);

reset role;
insert into public.domain_events (
  workspace_id, aggregate_type, aggregate_id, sequence, event_type, schema_version, payload_hash
) values (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bank_connection', '33333333-3333-3333-3333-333333333333', 1,
  'BankConnectionCreated', 1, decode(repeat('00', 32), 'hex')
);
select throws_ok(
  $$update public.domain_events set event_type = 'forged'$$,
  '55000',
  'append-only relation domain_events cannot be modified',
  'domain events are immutable even for table owners'
);
select results_eq(
  $$select event_type from public.domain_events$$,
  array['BankConnectionCreated'],
  'the rejected mutation leaves the event unchanged'
);
set local role service_role;
set local request.jwt.claim.role = 'service_role';
select lives_ok(
  $$select public.erase_workspace_domain_events('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')$$,
  'the service erasure boundary can remove domain events'
);
reset role;
select is_empty(
  $$select * from public.domain_events where workspace_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'$$,
  'domain events are removed by workspace erasure'
);

set local role service_role;
set local request.jwt.claim.role = 'service_role';
select isnt(
  public.enqueue_finch_job(
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'bank.sync',
    '{"connection_id":"33333333-3333-3333-3333-333333333333"}'::jsonb,
    'connection:33333333-3333-3333-3333-333333333333:initial'
  ),
  null::uuid,
  'the service worker enqueues a durable job'
);
reset role;
select results_eq(
  $$select status::text from public.job_requests where workspace_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'$$,
  array['queued'],
  'the durable job begins queued'
);
set local role service_role;
set local request.jwt.claim.role = 'service_role';
select results_eq(
  $$select count(*)::integer from public.claim_finch_jobs('44444444-4444-4444-4444-444444444444', 10)$$,
  array[1],
  'one worker receives one queue lease'
);
reset role;
select results_eq(
  $$select status::text from public.job_requests where workspace_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'$$,
  array['running'],
  'claim transitions the job to running'
);
select set_config('finch.test_job_id', (
  select id::text
  from public.job_requests
  where workspace_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    and idempotency_key = 'connection:33333333-3333-3333-3333-333333333333:initial'
), true);
select set_config('finch.test_message_id', (
  select msg_id::text
  from pgmq.q_finch_jobs
  where message ->> 'job_id' = current_setting('finch.test_job_id')
), true);
set local role service_role;
set local request.jwt.claim.role = 'service_role';
select results_eq(
  $$
    select public.fail_finch_job(
      '44444444-4444-4444-4444-444444444444',
      current_setting('finch.test_message_id')::bigint,
      current_setting('finch.test_job_id')::uuid,
      true,
      'provider_unavailable'
    )::text
  $$,
  array['retry'],
  'a retryable failure is rescheduled rather than abandoned'
);
reset role;
select results_eq(
  $$select status::text from public.job_requests where workspace_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'$$,
  array['retry'],
  'retry removes the worker lease and retains durable job state'
);

select * from finish();
rollback;
