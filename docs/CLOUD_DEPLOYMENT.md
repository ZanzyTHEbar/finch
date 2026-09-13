# Deploy Finch to Self-Hosted Supabase

Finch has one supported production runtime: a self-hosted Supabase deployment
with its native Auth, Postgres, RLS, private Storage, Vault, PGMQ, Edge
Functions, `pg_cron`, and `pg_net` services. The Edge API is the only
application control plane.

Do not add Authentik, Infisical, OpenBao, Kubernetes, ConnectRPC, a generated
client runtime, or another API/worker runtime to this deployment. Finch does
not initiate, transfer, or cancel payments. PostgreSQL lexical search is the
supported search path; semantic retrieval is deferred.

This procedure initializes an empty Supabase project. Do not use it against a
project containing Finch prototype data: the schema is a direct replacement,
not a migration.

## 1. Bootstrap the empty project

Provision the upstream self-hosted Supabase service bundle on an
operator-owned host and assign its public API domain before applying Finch.
Set `FINCH_SUPABASE_DB_URL` to that host's operator-only direct Postgres
connection string, then apply the schema once:

```bash
export FINCH_SUPABASE_DB_URL='postgresql://...'
bun run supabase:bootstrap
```

`FINCH_SUPABASE_SCHEMA_MODE` defaults to `bootstrap`; it refuses a non-empty
`public` schema before applying `supabase/schemas/finch.sql`. For a live-test
database whose schema is managed elsewhere, run
`FINCH_SUPABASE_SCHEMA_MODE=existing bun run supabase:bootstrap`; this
validates the mode and makes no schema mutation.

The deploying database user must be able to create the extensions used by
`supabase/schemas/finch.sql`: `pgcrypto`, `pgmq`, `pg_cron`, `pg_net`,
`supabase_vault`, and `vector`. Direct database and Storage-backend access is
operator-only; application clients use Auth/RLS, signed URLs, or the Edge
Functions.

## 2. Configure Auth, origins, and secrets

Configure Supabase Auth before inviting users:

1. Set the HTTPS site URL and exact additional redirect URLs to the Finch
   browser origin.
2. Configure operator-owned SMTP, password policy, refresh-token policy, and
   TOTP MFA.
3. Enable TOTP MFA in **Authentication -> Multi-Factor Authentication**.
   Export requests and workspace deletion require a fresh `aal2` token.

`FINCH_PUBLIC_APP_ORIGIN` is the one HTTPS origin for post-provider browser
redirects. Bank authorization accepts only a relative `returnPath`.
`FINCH_BANK_CALLBACK_URL` is the registered Enable Banking redirect URL.

The current Edge response helper sends `Access-Control-Allow-Origin: *`.
That is not an enforced browser-origin allowlist; Auth redirects and callback
origins remain restricted by the configuration above. Adding strict Edge CORS
enforcement is separate work.

Generate `FINCH_WORKER_TOKEN` with at least 32 random bytes. Put the following
values in an operator-owned environment file supplied only to the native Edge
Runtime services; do not use Supabase Cloud CLI secret management for a
self-hosted deployment.

```dotenv
FINCH_WORKER_TOKEN=<openssl rand -hex 32 output>
FINCH_PUBLIC_APP_ORIGIN=https://app.example.com
FINCH_BANK_CALLBACK_URL=https://api.example.com/functions/v1/bank-callback
ENABLEBANKING_BASE_URL=https://api.enablebanking.com
OPENCODE_LLM_BASE_URL=https://llm.example.com/v1
```

Store provider credentials and the scheduler's copy of the worker token in
Vault through the Supabase SQL editor, replacing only the values below:

```sql
select vault.create_secret('<enable-banking-application-id>', 'enablebanking_application_id');
select vault.create_secret('<enable-banking-rs256-private-key>', 'enablebanking_private_key');
select vault.create_secret('<provider-psu-ip>', 'enablebanking_psu_ip');
select vault.create_secret('<provider-user-agent>', 'enablebanking_psu_user_agent');
select vault.create_secret('<the-value-of-FINCH_WORKER_TOKEN>', 'finch_worker_token');
select vault.create_secret('<opencode-api-key>', 'opencode_api_key');
```

`voyage_api_key` is operator-owned Vault data if an enabled workspace AI policy
uses it; it does not make semantic retrieval a supported Finch capability.
Operators also own Supabase platform keys, TLS keys, database credentials,
SMTP credentials, and Storage-backend credentials. Assign rotation owners and
rotate each value independently.

Never put provider credentials, worker tokens, user bank sessions,
authorization codes, private object keys, or any other secret in source,
browser configuration, MCP parameters, job payloads, logs, or domain events.

## 3. Persisted services and private data

Postgres is the system of record for tenant-scoped data, immutable domain and
audit events, job state, and RLS policy. The service-role key is available only
to Edge Functions; clients receive neither that key nor direct mutation rights.

`search_finances` is the tenant-scoped PostgreSQL lexical search RPC using
`websearch_to_tsquery`. Do not configure an embedding/vector retrieval API as
a supported search feature.

Storage buckets are private:

| Bucket | Purpose | Policy |
| --- | --- | --- |
| `receipt-originals` | JPEG, PNG, and PDF receipt originals up to 10 MiB | Signed upload/download URLs only |
| `exports` | Generated export parts up to 100 MiB | Signed download URLs only |

Signed URLs may contain an object key, so keys must be opaque and
non-sensitive. Storage credentials and bucket listings are never client-visible.
Do not make a bucket public to simplify an integration.

## 4. Deploy the Edge routes

Run four instances of the upstream `supabase/edge-runtime` service, not a
second application runtime. Mount the complete `supabase/functions` tree at
`/home/deno/functions` in every instance so each function can resolve its
shared imports. Configure each native Edge Runtime `--main-service` as one of
`/home/deno/functions/api`, `bank-callback`, `worker-run`, or `mcp`.

Supply every instance with the upstream Supabase runtime values
`JWT_SECRET`, `SUPABASE_URL`, `SUPABASE_PUBLIC_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_DB_URL`, plus the operator-owned
Finch environment file and `FUNCTIONS_VERIFY_JWT=false`. In the upstream
Compose bundle this becomes the Edge Runtime container's `VERIFY_JWT=false`;
set `VERIFY_JWT=false` directly when not using that Compose mapping. This is
the self-hosted equivalent of the local `verify_jwt = false` settings: all
four routes apply their own narrower authentication shown below.

Configure the upstream API gateway to dispatch these exact prefixes to the
matching Edge Runtime instance, preserving the suffix passed to the function:

| Public prefix | Edge Runtime service |
| --- | --- |
| `/functions/v1/api` | `api` |
| `/functions/v1/bank-callback` | `bank-callback` |
| `/functions/v1/worker-run` | `worker-run` |
| `/functions/v1/mcp` | `mcp` |

The standard self-hosted gateway route for `/functions/v1/` is not sufficient
when these functions run as separate native Edge Runtime services. Place these
four rules before that catch-all route. Restart the gateway and all four
services after changing mounts, routing, or environment. No `supabase
functions deploy` call is part of this contract.

Supabase injects `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and
`SUPABASE_SERVICE_ROLE_KEY` into deployed Edge Functions. Do not configure
client-side service-role access.

`--no-verify-jwt` is deliberate: each route has its own narrow authentication
boundary.

| Route | Authentication | Purpose |
| --- | --- | --- |
| `/functions/v1/api` | Supabase user bearer token verified in the function | Authenticated REST API; rechecks workspace membership |
| `/functions/v1/bank-callback` | Opaque stored callback state | Enable Banking callback and browser redirect |
| `/functions/v1/worker-run` | `x-worker-token` equals `FINCH_WORKER_TOKEN` | Stateless PGMQ worker invocation |
| `/functions/v1/mcp` | Supabase user bearer token forwarded to the API boundary | Authenticated remote MCP JSON-RPC transport |

## 5. Schedule the worker

Create a one-minute worker trigger in the SQL editor. Replace the function URL
with the deployed project URL; the token remains in Vault.

```sql
select cron.schedule(
  'finch-worker',
  '* * * * *',
  $$
    select net.http_post(
      url := 'https://api.example.com/functions/v1/worker-run',
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

PGMQ delivery is at least once. Job idempotency keys prevent duplicate enqueue,
a lease is five minutes, retryable failures use bounded delayed backoff, and the
eighth failed delivery is archived in the dead-letter queue. Each scheduled
invocation claims and handles at most one valid job. A bounded claim scan drops
malformed, missing, and terminal messages rather than letting them block valid
work behind them.

## 6. Backups, restore, and health

Back up encrypted Postgres data and the private Storage object backend. The
Postgres backup scope includes Auth, Storage metadata, Vault data, PGMQ tables,
and extension state. Define an operator-owned RPO, RTO, retention period,
backup target, host sizing, and restore-drill cadence before production.

Run a restore drill before launch and after material infrastructure changes.
It must prove Auth login, RLS isolation, signed Storage access, job
enqueue/claim, and all four Edge routes against the restored environment.

Monitor and alert on:

1. Gateway, Auth, REST, Storage, and Edge route reachability.
2. Database readiness and required extension availability.
3. PGMQ depth, expired leases, dead jobs, and repeated empty claims caused by
   stale messages.
4. `pg_cron` execution and failed `pg_net` worker requests.
5. Backup completion and restore-drill results.

## 7. Production checks

1. Create a test user and workspace through Supabase Auth and
   `POST /functions/v1/api/workspaces`.
2. Verify a forged `x-finch-workspace` returns `404` and raw
   `receipts`/`payment_orders` reads are denied.
3. Request a receipt upload intent, upload through its signed URL, finalize it,
   and verify the object cannot be fetched without a signed URL.
4. Queue a non-provider job and confirm `worker-run` marks it complete. Confirm
   an injected retryable failure is delayed, then dead-lettered after the
   maximum attempt count.
5. Confirm `aal1` tokens cannot create exports or deletion requests.
6. Use a test bank connection to verify callback, sync, provider-session Vault
   storage, and remote revocation before enabling real users.

Run `bun run typecheck`, `bun run supabase:test`, and `bun run test:cloud`
before each deployment. The cloud suite has no Enable Banking sandbox: it
verifies that an unverified/forged pre-existing payment callback is marked
`submission_unknown`, not completed. Validate passive provider
`GET /payments/{ref}` reconciliation with test credentials before production.

## Payment uncertainty

Pre-existing payment records with exhausted status polls remain safety-marked
`submission_unknown`; Finch exposes no public payment reconciliation or requeue
endpoint. A data-retention migration must decide the removal plan for those
records and passive reconciliation.
