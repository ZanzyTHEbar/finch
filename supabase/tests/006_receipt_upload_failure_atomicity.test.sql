begin;
select plan(13);

insert into auth.users (id, email)
values ('11111111-1111-4111-8111-111111111111', 'receipt-failure-owner@example.test');

insert into public.workspaces (id, name)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Receipt failure workspace');

insert into public.receipts (
  id, workspace_id, sha256, object_key, mime_type, byte_size, upload_state, created_by
) values
  (
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    decode(repeat('00', 32), 'hex'),
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'application/pdf',
    1,
    'pending',
    '11111111-1111-4111-8111-111111111111'
  ),
  (
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    decode(repeat('11', 32), 'hex'),
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/dddddddd-dddd-4ddd-8ddd-dddddddddddd/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    'application/pdf',
    1,
    'pending',
    '11111111-1111-4111-8111-111111111111'
  );

select ok(
  has_function_privilege('service_role', 'public.fail_pending_receipt_upload(uuid,uuid,uuid,text)', 'execute'),
  'only the service role receives the receipt failure transition capability'
);
select ok(
  not has_function_privilege('anon', 'public.fail_pending_receipt_upload(uuid,uuid,uuid,text)', 'execute'),
  'anonymous callers cannot execute the receipt failure transition'
);
select ok(
  not has_function_privilege('authenticated', 'public.fail_pending_receipt_upload(uuid,uuid,uuid,text)', 'execute'),
  'authenticated callers cannot execute the receipt failure transition'
);

set local role service_role;
set local request.jwt.claim.role = 'service_role';
select results_eq(
  $$select public.fail_pending_receipt_upload(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    '11111111-1111-4111-8111-111111111111',
    'receipt_hash_mismatch'
  )$$,
  array['failed'],
  'the service role atomically fails a pending receipt'
);
reset role;
select results_eq(
  $$select upload_state from public.receipts where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'$$,
  array['failed'],
  'the receipt is failed'
);
select results_eq(
  $$select action || ':' || resource_id::text || ':' || safe_error_code
    from public.audit_events
    where resource_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'$$,
  array['receipt.upload_failed:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:receipt_hash_mismatch'],
  'the failed receipt and audit record are linked'
);

set local role service_role;
set local request.jwt.claim.role = 'service_role';
select results_eq(
  $$select public.fail_pending_receipt_upload(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    '11111111-1111-4111-8111-111111111111',
    'receipt_hash_mismatch'
  )$$,
  array['already_failed'],
  'a raced already-failed receipt has a usable result'
);
reset role;
select results_eq(
  $$select count(*)::integer from public.audit_events where resource_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'$$,
  array[1],
  'a raced already-failed receipt does not add a duplicate audit record'
);

set local role service_role;
set local request.jwt.claim.role = 'service_role';
select throws_ok(
  $$select public.fail_pending_receipt_upload(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    '11111111-1111-4111-8111-111111111111',
    'receipt_untrusted_error'
  )$$,
  '22023',
  'invalid receipt upload failure code',
  'the service role cannot supply an arbitrary failure code'
);
reset role;

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
select throws_ok(
  $$select public.fail_pending_receipt_upload(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    '11111111-1111-4111-8111-111111111111',
    'receipt_hash_mismatch'
  )$$,
  '42501',
  null,
  'an authenticated caller cannot invoke the service-only function'
);
reset role;

create function public.finch_test_reject_receipt_upload_failure_audit()
returns trigger
language plpgsql
as $$
begin
  if new.action = 'receipt.upload_failed'
    and new.resource_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  then
    raise exception 'test receipt upload failure audit rejection';
  end if;
  return new;
end;
$$;
create trigger finch_test_reject_receipt_upload_failure_audit
before insert on public.audit_events
for each row execute function public.finch_test_reject_receipt_upload_failure_audit();

set local role service_role;
set local request.jwt.claim.role = 'service_role';
select throws_ok(
  $$select public.fail_pending_receipt_upload(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    '11111111-1111-4111-8111-111111111111',
    'receipt_metadata_mismatch'
  )$$,
  'P0001',
  'test receipt upload failure audit rejection',
  'an audit write failure rejects the combined transition'
);
reset role;
select results_eq(
  $$select upload_state from public.receipts where id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'$$,
  array['pending'],
  'an audit write failure rolls the receipt transition back'
);
select is_empty(
  $$select 1 from public.audit_events where resource_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'$$,
  'an audit write failure leaves no failed receipt audit record'
);

drop trigger finch_test_reject_receipt_upload_failure_audit on public.audit_events;
drop function public.finch_test_reject_receipt_upload_failure_audit();

select * from finish();
rollback;
