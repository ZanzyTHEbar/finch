begin;
select plan(20);

delete from pgmq.q_finch_jobs;
delete from pgmq.a_finch_jobs;

insert into auth.users (id, email)
values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'queue-recovery@example.test');
insert into public.workspaces (id, name)
values ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'Queue recovery workspace');
insert into public.bank_connections (id, workspace_id, provider, aspsp_name, aspsp_country, created_by)
values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'enablebanking', 'Example Bank', 'PT', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
insert into public.payment_orders (
  id, workspace_id, bank_connection_id, provider_payment_ref, client_request_id, status, creditor_name, creditor_iban,
  amount_minor, currency, state_hash, return_path, state_expires_at, created_by
) values (
  'ffffffff-ffff-4fff-8fff-ffffffffffff', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'provider-payment-poll', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'submitted', 'Example Creditor', 'PT50000201231234567890154', 100, 'EUR', decode(repeat('99', 32), 'hex'), '/payments/poll', now() + interval '1 hour', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
);
select pgmq.send('finch_jobs', '{"job_id":"not-a-uuid"}'::jsonb);
select pgmq.send('finch_jobs', '{"job_id":"00000000-0000-0000-0000-000000000001"}'::jsonb);
insert into public.job_requests (id, workspace_id, kind, payload, idempotency_key, status, completed_at)
values (
  '00000000-0000-0000-0000-000000000002',
  'cccccccc-cccc-cccc-cccc-cccccccccccc',
  'bank.sync',
  '{}'::jsonb,
  'terminal-message',
  'succeeded',
  now()
);
select pgmq.send('finch_jobs', '{"job_id":"00000000-0000-0000-0000-000000000002"}'::jsonb);

set local role service_role;
set local request.jwt.claim.role = 'service_role';
select isnt(
  public.enqueue_finch_job(
    'cccccccc-cccc-cccc-cccc-cccccccccccc',
    'payment.status.poll',
    '{"payment_id":"ffffffff-ffff-4fff-8fff-ffffffffffff"}'::jsonb,
    'crash-recovery'
  ),
  null::uuid,
  'a durable job is enqueued after a malformed queue message'
);
select set_config('finch.test_job_id', (
  select id::text
  from public.job_requests
  where workspace_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
    and idempotency_key = 'crash-recovery'
), true);
create temporary table finch_test_initial_claim as
select * from public.claim_finch_jobs('66666666-6666-6666-8666-666666666666', 1);
select results_eq(
  $$select count(*)::integer from finch_test_initial_claim$$,
  array[1],
  'a malformed message does not consume the worker claim opportunity'
);
select results_eq(
  $$select job_id::text from finch_test_initial_claim$$,
  array[current_setting('finch.test_job_id')],
  'the first worker claims the valid job behind the malformed message'
);
select results_eq(
  $$select lease_message_id::text from public.job_requests where id = current_setting('finch.test_job_id')::uuid$$,
  (select array_agg(message_id::text) from finch_test_initial_claim),
  'the first claim binds its PGMQ message to the database lease'
);
reset role;
select is_empty(
  $$select 1 from pgmq.q_finch_jobs where message ->> 'job_id' in ('not-a-uuid', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002')$$,
  'malformed, missing, and terminal messages are removed before valid work is claimed'
);
set local role service_role;
set local request.jwt.claim.role = 'service_role';
select set_config('finch.test_other_job_id', public.enqueue_finch_job(
  'cccccccc-cccc-cccc-cccc-cccccccccccc',
  'bank.sync',
  '{"connection_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"}'::jsonb,
  'wrong-message'
)::text, true);
reset role;
select set_config('finch.test_other_message_id', (
  select msg_id::text
  from pgmq.q_finch_jobs
  where message ->> 'job_id' = current_setting('finch.test_other_job_id')
), true);
set local role service_role;
set local request.jwt.claim.role = 'service_role';
select ok(
  not public.renew_finch_job(
    '66666666-6666-6666-8666-666666666666',
    current_setting('finch.test_other_message_id')::bigint,
    current_setting('finch.test_job_id')::uuid
  ),
  'a worker cannot renew a job with another job message'
);
select ok(
  not public.complete_finch_job(
    '66666666-6666-6666-8666-666666666666',
    current_setting('finch.test_other_message_id')::bigint,
    current_setting('finch.test_job_id')::uuid
  ),
  'a worker cannot complete a job with another job message'
);
select throws_ok(
  $$select public.fail_finch_job(
    '66666666-6666-6666-8666-666666666666',
    current_setting('finch.test_other_message_id')::bigint,
    current_setting('finch.test_job_id')::uuid,
    true,
    'provider_unavailable'
  )$$,
  '42501',
  'job lease is not owned by this worker',
  'a worker cannot fail a job with another job message'
);
select results_eq(
  $$select status::text from public.job_requests where id = current_setting('finch.test_job_id')::uuid$$,
  array['running'],
  'wrong-message lifecycle calls leave the job running'
);
do $$
begin
  if not exists (select 1 from finch_test_initial_claim) then
    insert into finch_test_initial_claim
    select * from public.claim_finch_jobs('66666666-6666-6666-8666-666666666666', 1);
  end if;
end;
$$;
reset role;
update public.job_requests set lease_expires_at = now() - interval '1 second' where id = current_setting('finch.test_job_id')::uuid;
update pgmq.q_finch_jobs
set vt = now() - interval '1 second'
where message ->> 'job_id' = current_setting('finch.test_job_id');

set local role service_role;
set local request.jwt.claim.role = 'service_role';
create temporary table finch_test_reclaim as
select * from public.claim_finch_jobs('77777777-7777-7777-8777-777777777777', 1);
select results_eq(
  $$select count(*)::integer from finch_test_reclaim$$,
  array[1],
  'a fresh worker reclaims an expired lease'
);
select results_eq(
  $$select job_id::text from finch_test_reclaim$$,
  array[current_setting('finch.test_job_id')],
  'the fresh worker reclaims the fixture job'
);
select results_eq(
  $$select lease_message_id::text from public.job_requests where id = current_setting('finch.test_job_id')::uuid$$,
  (select array_agg(message_id::text) from finch_test_reclaim),
  'reclaim retains the PGMQ message binding'
);

reset role;
select set_config('finch.test_message_id', (
  select message_id::text
  from finch_test_reclaim
), true);

set local role service_role;
set local request.jwt.claim.role = 'service_role';
select ok(
  public.renew_finch_job(
    '77777777-7777-7777-8777-777777777777',
    current_setting('finch.test_message_id')::bigint,
    current_setting('finch.test_job_id')::uuid
  ),
  'the owning worker renews its queue and database lease'
);

reset role;
select results_eq(
  $$select attempts from public.job_requests where id = current_setting('finch.test_job_id')::uuid$$,
  array[2],
  'reclaim records a second delivery attempt'
);
update public.job_requests set attempts = 8 where id = current_setting('finch.test_job_id')::uuid;

set local role service_role;
set local request.jwt.claim.role = 'service_role';
select results_eq(
  $$
    select public.fail_finch_job(
      '77777777-7777-7777-8777-777777777777',
      current_setting('finch.test_message_id')::bigint,
      current_setting('finch.test_job_id')::uuid,
      true,
      'provider_unavailable'
    )::text
  $$,
  array['dead'],
  'the maximum attempt transitions a job to the dead-letter archive'
);

reset role;
select results_eq(
  $$select status::text from public.job_requests where id = current_setting('finch.test_job_id')::uuid$$,
  array['dead'],
  'dead-letter state is durable'
);
select results_eq(
  $$select count(*)::integer from public.job_requests where id = current_setting('finch.test_job_id')::uuid and lease_owner is null and lease_expires_at is null and lease_message_id is null$$,
  array[1],
  'dead-lettering clears every lease field'
);
select results_eq(
  $$select count(*)::integer from pgmq.a_finch_jobs where message ->> 'job_id' = current_setting('finch.test_job_id')$$,
  array[1],
  'the queue message is archived exactly once'
);
select results_eq(
  $$select status::text || ':' || safe_error_code from public.payment_orders where id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'$$,
  array['submission_unknown:payment_status_poll_exhausted'],
  'a dead payment poll marks only its submitted payment as submission unknown'
);
select results_eq(
  $$select action || ':' || safe_error_code from public.audit_events where resource_type = 'payment_order' and resource_id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'$$,
  array['payment.status_poll_exhausted:payment_status_poll_exhausted'],
  'the payment safety transition is audited'
);

select * from finish();
rollback;
