# Deploy Finch to Supabase

This procedure initializes an empty Supabase project. Do not use it against a project containing Finch prototype data: the schema is a direct replacement, not a migration.

## 1. Bootstrap the empty project

Authenticate and link the intended project:

```bash
bunx supabase login
bunx supabase link --project-ref <project-ref>
```

Set `FINCH_SUPABASE_DB_URL` to that project's direct Postgres connection string, then apply the schema once:

```bash
export FINCH_SUPABASE_DB_URL='postgresql://...'
bun run supabase:bootstrap
```

`FINCH_SUPABASE_SCHEMA_MODE` defaults to `bootstrap`; it refuses a non-empty `public` schema before applying `supabase/schemas/finch.sql`. For a live-test database whose schema is managed elsewhere, run `FINCH_SUPABASE_SCHEMA_MODE=existing bun run supabase:bootstrap`; this validates the mode and makes no schema mutation.

The deploying database user must be able to create the extensions used by `supabase/schemas/finch.sql`: `pgmq`, `pg_cron`, `pg_net`, `supabase_vault`, and `vector`.

## 2. Configure secrets

Set Edge Function secrets. Generate `FINCH_WORKER_TOKEN` with at least 32 random bytes and keep it out of source control and client applications.

```bash
export FINCH_WORKER_TOKEN="$(openssl rand -hex 32)"
bunx supabase secrets set \
  FINCH_WORKER_TOKEN="$FINCH_WORKER_TOKEN" \
  FINCH_PUBLIC_APP_ORIGIN='https://app.example.com' \
  FINCH_BANK_CALLBACK_URL='https://<project-ref>.supabase.co/functions/v1/bank-callback' \
  ENABLEBANKING_BASE_URL='https://api.enablebanking.com' \
  OPENCODE_LLM_BASE_URL='https://llm.example.com/v1'
```

Store provider credentials and the scheduler's copy of the worker token in Vault through the Supabase SQL editor, replacing only the values below:

```sql
select vault.create_secret('<enable-banking-application-id>', 'enablebanking_application_id');
select vault.create_secret('<enable-banking-rs256-private-key>', 'enablebanking_private_key');
select vault.create_secret('<provider-psu-ip>', 'enablebanking_psu_ip');
select vault.create_secret('<provider-user-agent>', 'enablebanking_psu_user_agent');
select vault.create_secret('<the-value-of-FINCH_WORKER_TOKEN>', 'finch_worker_token');
select vault.create_secret('<opencode-api-key>', 'opencode_api_key');
```

Never put provider credentials, worker tokens, user bank sessions, authorization codes, or private object keys in Edge secrets intended for clients, MCP parameters, job payloads, logs, or domain events.

`FINCH_PUBLIC_APP_ORIGIN` is the single HTTPS origin for post-provider browser redirects. Bank authorization and payment requests accept only a relative `returnPath`; configure `FINCH_BANK_CALLBACK_URL` as the Enable Banking redirect URL registered with the provider.

Enable TOTP MFA in **Authentication → Multi-Factor Authentication** before inviting users. Payments, export requests, and workspace deletion require a fresh `aal2` token; users must enroll and verify TOTP before those operations are available.

## 3. Deploy the functions

```bash
for function in api bank-callback worker-run mcp; do
  bunx supabase functions deploy "$function" --no-verify-jwt
done
```

Supabase injects `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` into deployed Edge Functions. Do not configure client-side service-role access.

## 4. Schedule the worker

Create a one-minute worker trigger in the SQL editor. Replace the function URL with the deployed project URL; the token remains in Vault.

```sql
select cron.schedule(
  'finch-worker',
  '* * * * *',
  $$
    select net.http_post(
      url := 'https://<project-ref>.supabase.co/functions/v1/worker-run',
      headers := jsonb_build_object(
        'content-type', 'application/json',
        'x-worker-token', (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'finch_worker_token'
        )
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    );
  $$
);
```

The worker claims one job per invocation and renews its PGMQ lease while it runs. PGMQ lease expiry makes abandoned jobs available to the next invocation; it does not need a persistent process.

## 5. Production checks

1. Create a test user and workspace through Supabase Auth and `POST /functions/v1/api/workspaces`.
2. Verify a forged `x-finch-workspace` returns `404` and raw `receipts`/`payment_orders` reads are denied.
3. Request a receipt upload intent, upload through its signed URL, finalize it, and verify the object cannot be fetched without a signed URL.
4. Queue a non-provider job and confirm `worker-run` marks it complete. Confirm an injected retryable failure is delayed, then dead-lettered after the maximum attempt count.
5. Confirm `aal1` tokens cannot create payments, exports, or deletion requests.
6. Use a test bank connection to verify callback, sync, provider-session Vault storage, and remote revocation before enabling real users.

Run `bun run typecheck`, `bun run supabase:test`, and `bun run test:cloud` before each deployment. The cloud suite has no Enable Banking sandbox: it verifies that an unverified/forged callback is marked `submission_unknown`, not completed. Validate a successful provider `GET /payments/{ref}` callback with test credentials before production.

## Payment uncertainty

Provider creation uncertainty and exhausted status polls are safety-marked `submission_unknown`; Finch never automatically re-POSTs a payment or exposes a public reconciliation/requeue endpoint. G10 must define an operator-reviewed reconciliation workflow before any recovery capability is added.
