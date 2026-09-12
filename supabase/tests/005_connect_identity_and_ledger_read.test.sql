begin;
select plan(21);

insert into auth.users (id, email)
values
  ('11111111-0000-4000-8000-000000000001', 'identity-a@example.test'),
  ('22222222-0000-4000-8000-000000000002', 'identity-b@example.test');

insert into public.workspaces (id, name)
values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'Active workspace'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'Other workspace'),
  ('cccccccc-0000-4000-8000-000000000003', 'Disabled workspace');

insert into public.workspace_members (workspace_id, user_id, role)
values
  ('aaaaaaaa-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000001', 'member'),
  ('cccccccc-0000-4000-8000-000000000003', '11111111-0000-4000-8000-000000000001', 'viewer');

select is(
  (select relrowsecurity from pg_class where oid = 'public.authentik_subject_profiles'::regclass),
  true,
  'Authentik subject mappings have RLS enabled'
);
select is(
  (select count(*)::integer from pg_policies where schemaname = 'public' and tablename = 'authentik_subject_profiles'),
  0,
  'Authentik subject mappings have no caller policy'
);
select ok(
  not has_table_privilege('anon', 'public.authentik_subject_profiles', 'select,insert,update,delete'),
  'anonymous callers cannot access Authentik subject mappings'
);
select ok(
  not has_table_privilege('authenticated', 'public.authentik_subject_profiles', 'select,insert,update,delete'),
  'authenticated callers cannot access Authentik subject mappings'
);
select ok(
  not has_function_privilege('anon', 'public.link_authentik_subject_profile(text,text,uuid)', 'execute'),
  'anonymous callers cannot link Authentik subjects'
);
select ok(
  not has_function_privilege('authenticated', 'public.link_authentik_subject_profile(text,text,uuid)', 'execute'),
  'authenticated callers cannot link Authentik subjects'
);
select ok(
  has_function_privilege('service_role', 'public.link_authentik_subject_profile(text,text,uuid)', 'execute'),
  'service role can link Authentik subjects'
);
select ok(
  not has_function_privilege('anon', 'public.resolve_authentik_workspace_access(text,text,uuid)', 'execute'),
  'anonymous callers cannot resolve Authentik workspace access'
);
select ok(
  not has_function_privilege('authenticated', 'public.resolve_authentik_workspace_access(text,text,uuid)', 'execute'),
  'authenticated callers cannot resolve Authentik workspace access'
);
select ok(
  has_function_privilege('service_role', 'public.resolve_authentik_workspace_access(text,text,uuid)', 'execute'),
  'service role can resolve Authentik workspace access'
);

set local role service_role;
set local request.jwt.claim.role = 'service_role';
select throws_ok(
  $$select public.link_authentik_subject_profile('', 'subject-a', '11111111-0000-4000-8000-000000000001')$$,
  '22023',
  null,
  'blank issuers are rejected'
);
select throws_ok(
  $$select public.link_authentik_subject_profile('https://id.example.test', '   ', '11111111-0000-4000-8000-000000000001')$$,
  '22023',
  null,
  'blank subjects are rejected'
);
select lives_ok(
  $$select public.link_authentik_subject_profile('https://id.example.test', 'subject-a', '11111111-0000-4000-8000-000000000001')$$,
  'service role links an existing profile once'
);
select lives_ok(
  $$select public.link_authentik_subject_profile('https://id.example.test', 'subject-a', '11111111-0000-4000-8000-000000000001')$$,
  'repeating the exact link is idempotent'
);
select throws_ok(
  $$select public.link_authentik_subject_profile('https://id.example.test', 'subject-a', '22222222-0000-4000-8000-000000000002')$$,
  '23505',
  null,
  'a subject cannot silently relink to another profile'
);
select throws_ok(
  $$select public.link_authentik_subject_profile('https://id.example.test', 'subject-b', '11111111-0000-4000-8000-000000000001')$$,
  '23505',
  null,
  'a profile cannot silently relink to another subject'
);
select results_eq(
  $$select role::text from public.resolve_authentik_workspace_access('https://id.example.test', 'subject-a', 'aaaaaaaa-0000-4000-8000-000000000001')$$,
  array['member'],
  'the exact mapping and active membership resolve to the stored role'
);
select is(
  pg_get_function_result('public.resolve_authentik_workspace_access(text,text,uuid)'::regprocedure),
  'TABLE(role workspace_role)'::text,
  'the resolver exposes no profile or membership detail'
);
select is_empty(
  $$select * from public.resolve_authentik_workspace_access('https://id.example.test', 'subject-a', 'bbbbbbbb-0000-4000-8000-000000000002')$$,
  'a mapping does not authorize another workspace'
);
update public.workspace_members
set revoked_at = now()
where workspace_id = 'aaaaaaaa-0000-4000-8000-000000000001'
  and user_id = '11111111-0000-4000-8000-000000000001';
select is_empty(
  $$select * from public.resolve_authentik_workspace_access('https://id.example.test', 'subject-a', 'aaaaaaaa-0000-4000-8000-000000000001')$$,
  'revoked memberships are denied'
);
update public.workspaces
set state = 'deleting', deletion_requested_at = now()
where id = 'cccccccc-0000-4000-8000-000000000003';
select is_empty(
  $$select * from public.resolve_authentik_workspace_access('https://id.example.test', 'subject-a', 'cccccccc-0000-4000-8000-000000000003')$$,
  'disabled workspaces are denied'
);

select * from finish();
rollback;
