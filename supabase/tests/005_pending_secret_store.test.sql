begin;
select plan(9);

insert into auth.users (id, email)
values ('12121212-1212-4121-8121-121212121212', 'pending-secret@example.test');
insert into public.workspaces (id, name)
values ('34343434-3434-4343-8343-343434343434', 'Pending secret workspace');
insert into public.bank_connections (id, workspace_id, provider, aspsp_name, aspsp_country, status, created_by)
values
  ('56565656-5656-4565-8565-565656565656', '34343434-3434-4343-8343-343434343434', 'enablebanking', 'Pending Bank', 'PT', 'authorization_pending', '12121212-1212-4121-8121-121212121212'),
  ('78787878-7878-4787-8787-787878787878', '34343434-3434-4343-8343-343434343434', 'enablebanking', 'Revoking Bank', 'PT', 'revocation_pending', '12121212-1212-4121-8121-121212121212'),
  ('90909090-9090-4090-8090-909090909090', '34343434-3434-4343-8343-343434343434', 'enablebanking', 'Revoked Bank', 'PT', 'revoked', '12121212-1212-4121-8121-121212121212'),
  ('abababab-abab-4aba-8aba-abababababab', '34343434-3434-4343-8343-343434343434', 'enablebanking', 'Compatibility Bank', 'PT', 'revocation_pending', '12121212-1212-4121-8121-121212121212');

set local role service_role;
set local request.jwt.claim.role = 'service_role';

select lives_ok(
  $$select public.store_pending_bank_connection_secret('56565656-5656-4565-8565-565656565656', 'pending-session-secret')$$,
  'service role stores a secret through the pending-only RPC'
);
select ok(
  (select vault_secret_id is not null from public.bank_connections where id = '56565656-5656-4565-8565-565656565656'),
  'the pending connection receives a Vault secret reference'
);
select throws_ok(
  $$select public.store_pending_bank_connection_secret('78787878-7878-4787-8787-787878787878', 'revoking-session-secret')$$,
  'P0002',
  null,
  'a revocation-pending connection cannot acquire a secret through the pending-only RPC'
);
select ok(
  (select vault_secret_id is null from public.bank_connections where id = '78787878-7878-4787-8787-787878787878'),
  'the revocation-pending connection remains without a secret'
);
select throws_ok(
  $$select public.store_pending_bank_connection_secret('90909090-9090-4090-8090-909090909090', 'revoked-session-secret')$$,
  'P0002',
  null,
  'a revoked connection cannot acquire a secret through the pending-only RPC'
);
select ok(
  (select vault_secret_id is null from public.bank_connections where id = '90909090-9090-4090-8090-909090909090'),
  'the revoked connection remains without a secret'
);
select lives_ok(
  $$select public.store_bank_connection_secret('abababab-abab-4aba-8aba-abababababab', 'compatibility-session-secret')$$,
  'the existing general secret-store RPC remains compatible with revocation recovery'
);
select ok(
  (select vault_secret_id is not null from public.bank_connections where id = 'abababab-abab-4aba-8aba-abababababab'),
  'the existing general secret-store RPC still stores its secret'
);
reset role;
select ok(
  coalesce(has_function_privilege('service_role', to_regprocedure('public.store_pending_bank_connection_secret(uuid,text)'), 'execute'), false)
    and not coalesce(has_function_privilege('anon', to_regprocedure('public.store_pending_bank_connection_secret(uuid,text)'), 'execute'), false)
    and not coalesce(has_function_privilege('authenticated', to_regprocedure('public.store_pending_bank_connection_secret(uuid,text)'), 'execute'), false),
  'only the service role can execute the pending-only secret-store RPC'
);

select * from finish();
rollback;
