begin;
select plan(10);

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
  'a durable job is enqueued'
);
select results_eq(
  $$select count(*)::integer from public.claim_finch_jobs('66666666-6666-6666-8666-666666666666', 1)$$,
  array[1],
  'the first worker owns the initial lease'
);
select set_config('finch.test_job_id', (
  select id::text
  from public.job_requests
  where workspace_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
    and idempotency_key = 'crash-recovery'
), true);

reset role;
update public.job_requests set lease_expires_at = now() - interval '1 second' where workspace_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
update pgmq.q_finch_jobs
set vt = now() - interval '1 second'
where message ->> 'job_id' = current_setting('finch.test_job_id');

set local role service_role;
set local request.jwt.claim.role = 'service_role';
select results_eq(
  $$select count(*)::integer from public.claim_finch_jobs('77777777-7777-7777-8777-777777777777', 1)$$,
  array[1],
  'a fresh worker reclaims an expired lease'
);

reset role;
select set_config('finch.test_message_id', (
  select msg_id::text
  from pgmq.q_finch_jobs
  where message ->> 'job_id' = current_setting('finch.test_job_id')
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
  $$select attempts from public.job_requests where workspace_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'$$,
  array[2],
  'reclaim records a second delivery attempt'
);
update public.job_requests set attempts = 8 where workspace_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

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
  $$select status::text from public.job_requests where workspace_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'$$,
  array['dead'],
  'dead-letter state is durable'
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
