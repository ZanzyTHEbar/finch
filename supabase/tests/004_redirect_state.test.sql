begin;
select plan(15);

insert into auth.users (id, email)
values
  ('10101010-1010-4010-8010-101010101010', 'state-owner@example.test'),
  ('20202020-2020-4020-8020-202020202020', 'state-other@example.test');
insert into public.workspaces (id, name)
values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'State owner workspace'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'State other workspace');
insert into public.bank_connections (id, workspace_id, provider, aspsp_name, aspsp_country, created_by)
values
  ('aaaaaaaa-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000001', 'enablebanking', 'Example Bank', 'PT', '10101010-1010-4010-8010-101010101010'),
  ('bbbbbbbb-2222-4222-8222-222222222222', 'bbbbbbbb-0000-4000-8000-000000000002', 'enablebanking', 'Example Bank', 'PT', '20202020-2020-4020-8020-202020202020');

insert into public.bank_authorizations (workspace_id, connection_id, user_id, state_hash, return_path, expires_at, created_at)
values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-1111-4111-8111-111111111111', '10101010-1010-4010-8010-101010101010', decode(repeat('11', 32), 'hex'), '/bank/complete?source=provider#done', now() + interval '1 hour', now()),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'bbbbbbbb-2222-4222-8222-222222222222', '20202020-2020-4020-8020-202020202020', decode(repeat('22', 32), 'hex'), '/bank/expired', now() - interval '1 second', now() - interval '1 hour');
insert into public.payment_orders (
  id, workspace_id, bank_connection_id, provider_payment_ref, client_request_id, status, creditor_name, creditor_iban,
  amount_minor, currency, state_hash, return_path, state_expires_at, created_by, created_at
) values
  ('aaaaaaaa-3333-4333-8333-333333333333', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-1111-4111-8111-111111111111', 'provider-payment-33', 'aaaaaaaa-4444-4444-8444-444444444444', 'authorization_pending', 'Example Creditor', 'PT50000201231234567890154', 100, 'EUR', decode(repeat('33', 32), 'hex'), '/payments/complete?source=provider#done', now() + interval '1 hour', '10101010-1010-4010-8010-101010101010', now()),
  ('bbbbbbbb-3333-4333-8333-333333333333', 'bbbbbbbb-0000-4000-8000-000000000002', 'bbbbbbbb-2222-4222-8222-222222222222', 'provider-payment-44', 'bbbbbbbb-4444-4444-8444-444444444444', 'authorization_pending', 'Other Creditor', 'PT50000201231234567890154', 100, 'EUR', decode(repeat('44', 32), 'hex'), '/payments/expired', now() - interval '1 second', '20202020-2020-4020-8020-202020202020', now() - interval '1 hour'),
  ('aaaaaaaa-5555-4555-8555-555555555555', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-1111-4111-8111-111111111111', 'provider-payment-55', 'aaaaaaaa-6666-4666-8666-666666666666', 'authorization_pending', 'Invalid Creditor', 'PT50000201231234567890154', 100, 'EUR', decode(repeat('55', 32), 'hex'), '/payments/invalid', now() + interval '1 hour', '10101010-1010-4010-8010-101010101010', now()),
  ('aaaaaaaa-7777-4777-8777-777777777777', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-1111-4111-8111-111111111111', 'provider-payment-66', 'aaaaaaaa-8888-4888-8888-888888888888', 'authorization_pending', 'Unknown Creditor', 'PT50000201231234567890154', 100, 'EUR', decode(repeat('66', 32), 'hex'), '/payments/unknown', now() + interval '1 hour', '10101010-1010-4010-8010-101010101010', now()),
  ('aaaaaaaa-9999-4999-8999-999999999999', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-1111-4111-8111-111111111111', 'provider-payment-77', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'accepted', 'Accepted Creditor', 'PT50000201231234567890154', 100, 'EUR', decode(repeat('77', 32), 'hex'), '/payments/accepted', now() + interval '1 hour', '10101010-1010-4010-8010-101010101010', now());

set local role service_role;
set local request.jwt.claim.role = 'service_role';

select results_eq(
  $$select workspace_id::text || ':' || user_id::text || ':' || return_path from public.consume_bank_authorization(decode(repeat('11', 32), 'hex'))$$,
  array['aaaaaaaa-0000-4000-8000-000000000001:10101010-1010-4010-8010-101010101010:/bank/complete?source=provider#done'],
  'bank state resolves only to its stored workspace, user, and return path'
);
select is_empty(
  $$select * from public.consume_bank_authorization(decode(repeat('11', 32), 'hex'))$$,
  'a consumed bank state cannot be reused'
);
select is_empty(
  $$select * from public.consume_bank_authorization(decode(repeat('22', 32), 'hex'))$$,
  'an expired bank state cannot be consumed'
);
select results_eq(
  $$select workspace_id::text || ':' || user_id::text || ':' || return_path || ':' || status from public.resolve_payment_callback(decode(repeat('33', 32), 'hex'), 'verified', 'provider-payment-33', 'ACTC', 'submitted')$$,
  array['aaaaaaaa-0000-4000-8000-000000000001:10101010-1010-4010-8010-101010101010:/payments/complete?source=provider#done:submitted'],
  'verified provider data atomically resolves payment state and returns its stored path and status'
);
select is(
  (select count(*)::integer from public.payment_provider_events where payment_id = 'aaaaaaaa-3333-4333-8333-333333333333'),
  1,
  'verified provider data records one provider event'
);
select is(
  (select count(*)::integer from public.job_requests where kind = 'payment.status.poll' and payload ->> 'payment_id' = 'aaaaaaaa-3333-4333-8333-333333333333'),
  1,
  'verified non-terminal provider data queues one status poll'
);
select is_empty(
  $$select * from public.resolve_payment_callback(decode(repeat('33', 32), 'hex'), 'verified', 'provider-payment-33', 'ACTC', 'submitted')$$,
  'a resolved payment callback cannot be replayed'
);
select is_empty(
  $$select * from public.resolve_payment_callback(decode(repeat('44', 32), 'hex'), 'verified', 'provider-payment-44', 'ACTC', 'submitted')$$,
  'an expired payment state cannot be resolved'
);
select is(
  (select state_used_at is not null from public.payment_orders where state_hash = decode(repeat('33', 32), 'hex')),
  true,
  'payment state consumption is committed with callback resolution'
);
select throws_ok(
  $$select * from public.resolve_payment_callback(decode(repeat('55', 32), 'hex'), 'verified', 'provider-payment-55', 'ACTC', 'unsafe')$$,
  '22023',
  null,
  'invalid verified data rolls back callback resolution'
);
select is(
  (select state_used_at is null and status = 'authorization_pending' from public.payment_orders where state_hash = decode(repeat('55', 32), 'hex')),
  true,
  'a failed resolver transaction leaves state and payment unchanged'
);
select results_eq(
  $$select status from public.resolve_payment_callback(decode(repeat('66', 32), 'hex'), 'verification_failed', null, null, null)$$,
  array['submission_unknown'],
  'unverified provider callback is consumed and marked unknown'
);
select is(
  (select state_used_at is not null and safe_error_code = 'payment_provider_verification_failed' from public.payment_orders where state_hash = decode(repeat('66', 32), 'hex')),
  true,
  'unknown callback state records only a safe verification error'
);
select results_eq(
  $$select status from public.resolve_payment_callback(decode(repeat('77', 32), 'hex'), 'provider_error', null, null, null)$$,
  array['accepted'],
  'provider callback errors do not downgrade accepted payments'
);
select is(
  (select status = 'accepted' from public.payment_orders where state_hash = decode(repeat('77', 32), 'hex')),
  true,
  'terminal payment status remains accepted'
);

select * from finish();
rollback;
