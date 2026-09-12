# Finch

Finch is a Supabase-native personal-finance service. It receives bank data through Enable Banking, keeps receipt originals in private Storage, and exposes authenticated REST endpoints.

This is a fresh cloud deployment. It does not deploy or publicly serve the former local SQLite/MCP runtime.

## Runtime

- Supabase Auth and Postgres RLS establish user and workspace access.
- Postgres stores tenant-scoped financial data, immutable domain/audit events, export/deletion state, and PGMQ jobs.
- Vault holds provider credentials and per-connection bank sessions.
- Private Storage holds receipt originals and generated export parts.
- Edge Functions provide the API, bank callback, and stateless worker.

The client supplies `x-finch-workspace` only as a requested context. The API verifies active membership from the authenticated Supabase user before every workspace action.

## MCP status

`@finch/mcp` is transitional, in-process test support for legacy regressions. It is not a deployable public MCP runtime, and its legacy stdio executable fails closed. The approved replacement is an agent-only Streamable HTTP MCP exposing `exec` and `docs`; it is not implemented yet.

## Local development

Prerequisites: Bun, Docker, and the Supabase CLI (installed by `bun install`).

```bash
bun install
bunx supabase start
bun run supabase:reset
bun run supabase:bootstrap:local
bun run test:cloud
```

`supabase:reset` creates an empty local project. `supabase:bootstrap:local` defaults `FINCH_SUPABASE_SCHEMA_MODE` to `bootstrap`, which refuses a non-empty `public` schema before applying the fresh `supabase/schemas/finch.sql` schema. It does not migrate existing data; set the mode to `existing` to deliberately skip schema mutation for a database managed elsewhere.

Run the complete local validation suite with:

```bash
bun run typecheck
bun run supabase:test
bun run test:cloud
```

## Edge Functions

| Function | Purpose |
| --- | --- |
| `api` | Authenticated workspace, bank, receipt, search, export, deletion, AI, and payment API. |
| `bank-callback` | Handles opaque Enable Banking authorization state and stores the provider session in Vault. |
| `worker-run` | Claims PGMQ jobs for sync, embeddings, exports, cleanup, deletion, payment polling, and summaries. |
| `mcp` | Authenticated remote MCP JSON-RPC transport. |

All functions validate user tokens themselves, so deploy them with `--no-verify-jwt`. The bank callback and worker have their own narrow authentication mechanisms.

## Security model

- Browser/client roles have no direct Storage object access; uploads and downloads use short-lived signed URLs.
- Raw bank-provider references, Vault IDs, receipt object keys, payment redirect state, and queued payloads are not client-readable.
- User reads are RLS-scoped. Safe views expose only intended fields where raw rows contain server-only values.
- Payment, export, and workspace deletion require an `aal2` Supabase Auth token.
- AI work is opt-in per workspace. Prompts contain a fixed aggregate only; credentials and full source records are not sent to the model.
- Jobs have idempotency keys, worker leases, bounded retries, delayed redelivery, and a PGMQ dead-letter archive.

## Deployment

See [docs/CLOUD_DEPLOYMENT.md](docs/CLOUD_DEPLOYMENT.md) for the fresh-project bootstrap, Vault/Edge secret configuration, Edge deployment, scheduled worker, and production validation procedure.
