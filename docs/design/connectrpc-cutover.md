# ConnectRPC-first parity and retirement plan

## Decision

Finch exposes machine-to-machine and machine-to-browser application capabilities
through ConnectRPC. MCP is a separate, agent-only, standards-compliant Streamable
HTTP adapter. Provider callbacks remain HTTPS only because their providers require
it. Every adapter calls the same adapter-agnostic `@finch/lib` capability surface;
adapters contain authentication, protocol translation, and response shaping only.

Supabase remains the persistence, queue, object-storage, and Auth infrastructure.
It is not the application API surface and Edge Functions do not host business
logic after this cutover. Cross-process Finch traffic uses ConnectRPC.

## Non-negotiable boundaries

```text
ConnectRPC client ────────────> ConnectRPC adapter ─┐
MCP agent ─> Streamable HTTP MCP adapter ─> isolate ─┼─> @finch/lib use case ─> port ─> infrastructure
Provider callback ───────────────────────────────────┤                               ├─> Supabase
Queue worker ────────────────────────────────────────┘                               ├─> Infisical / KMS
                                                                                └─> banking / AI provider
```

- `@finch/lib` imports domain types, contracts, and port interfaces only. It does
  not import ConnectRPC, MCP, Supabase, Drizzle, provider SDKs, environment
  variables, or secret-manager clients.
- A trusted `PrincipalContext` is created by an adapter after authentication.
  Tenant/workspace identity supplied by a caller is a requested scope, never an
  authority. Lib use cases authorize the selected workspace through a membership
  port.
- An in-process ConnectRPC, callback, or worker adapter calls lib directly. A
  separately deployed Finch application adapter uses ConnectRPC; it never queries
  Supabase or providers itself.
- MCP is never behind ConnectRPC. Its host invokes a bounded, in-process lib
  capability bridge from the isolate and is the only adapter allowed to offer
  agent composition.
- The MCP adapter implements the pinned current MCP Streamable HTTP and OAuth
  resource-server requirements at implementation time. It exposes only `exec`
  and `docs`; stdio is retired and WebSocket transport is omitted unless a
  release-pinned MCP requirement makes it necessary.

## MCP execution boundary

`docs` returns the versioned generated TypeScript SDK reference, capability
descriptions, input/output schemas, authorization limits, and examples. It never
reads workspace data.

`exec` accepts bounded TypeScript that imports the generated SDK. It runs in a
per-request, capability-minimal TypeScript isolate with no filesystem, network,
environment, process, dynamic import, or native-addon access. The generated SDK
serializes protobuf-contract calls over a host bridge. The bridge enforces the
authenticated `PrincipalContext`, capability allowlist, input/output limits,
deadline, call budget, and audit event, then invokes lib directly. The isolate
does not receive database, provider, Supabase, Infisical, or KMS credentials.

`node:vm` is not an acceptable security boundary. The implementation must use a
real process/container isolate with a restricted TypeScript runtime and a narrow
IPC bridge; its protocol is internal IPC, not stdio MCP. Each `exec` has a hard
deadline, bounded memory/CPU, one principal, and a bounded number of SDK calls.

## Credential boundary

Infisical owns low-cardinality runtime secrets: provider application credentials,
provider private keys, AI credentials, OAuth-client credentials, and service
configuration. The Finch workload authenticates to Infisical with a machine
identity; secrets are resolved at process start or bounded refresh and are never
logged, returned by an RPC, or stored in domain events.

Per-workspace bank-session material is high-cardinality and must not create one
Infisical secret per bank connection. Store ciphertext and encryption metadata in
Postgres; encrypt each session with a fresh data-encryption key and wrap that key
with OpenBao Transit. Only the infrastructure secret port can decrypt it. Rotate
the Transit key every 90 days, retain old key versions for decrypt/rewrap, and
keep recovery material offline under the Finch platform owner's two-person
break-glass process. Supabase Vault, Bun keyring, TOML credentials, and
Edge-function secrets are removed from the production credential path.

Initial Docker deployments use an Infisical Universal Auth machine identity as a
read-only Docker secret. Kubernetes replaces that bootstrap secret with a
service-account identity. Infisical holds the short-lived OpenBao application
credential; application code never receives an administrative KMS token.

The first identity provider is self-hosted Authentik. Authentik issues Finch's
OIDC tokens, has Google configured as its first upstream source, and exposes JWKS
for the ConnectRPC and MCP adapters. Supabase is an infrastructure dependency,
not the public identity issuer; the Supabase persistence adapter maps Authentik
subjects to Finch profiles and membership records.

### Connect OIDC resolver configuration

`AuthentikPrincipalResolver` accepts only HTTPS discovery, issuer, and JWKS URLs,
and trusts a discovered JWKS only when its discovery `issuer` exactly matches the
configured issuer. Its `audience` remains the Connect resource audience.

Configure the Authentik provider to issue an explicit access-token-only claim for
Connect tokens, then set `accessTokenClaimName` and `accessTokenClaimValue` to
match it. Finch has no default for this claim; for example, configure
`token_use=access` in both Authentik and the resolver. This prevents ID tokens
from being accepted as Connect access tokens.

## Ranked phases

### P0 — unblock the target contract

1. Run Finch, Authentik, Infisical, and OpenBao under Docker Compose initially;
   make all manifests Kubernetes-compatible from the first deployment artifact.
2. Use Infisical Universal Auth, OpenBao Transit, 90-day key rotation, and the
   documented two-person Finch-platform break-glass process.
3. Use Authentik as the OIDC issuer, Google as the initial upstream provider, and
   separate Finch ConnectRPC and MCP audiences.
4. Freeze protobuf/package versioning, `PrincipalContext`, error model, and the
   use-case/port dependency rule.

Use Testcontainers for integration tests whenever a service is involved. Do not
replace Infisical, OpenBao, Authentik, Supabase, or providers with mocks by
default; a fake is permitted only when a slice documents why its deterministic
benefit outweighs the lost integration evidence.

### P1 — establish the canonical ConnectRPC and lib surface

1. Move protobuf definitions from `packages/connect/proto` into a canonical
   contracts package. Replace caller-controlled `tenant_id` authority with a
   requested workspace scope bound to `PrincipalContext`.
2. Define RPC services for workspace/membership, ledger, receipts, bank,
   reconciliation, search/AI, payments, privacy/export, and job status.
3. Rebuild `@finch/lib` as use cases and port interfaces. Retain reusable domain
   schemas from `packages/core` only after removing configuration and adapter
   dependencies.
4. Add boundary tests proving transport and infrastructure imports cannot enter
   lib, and ConnectRPC contract tests for every capability.

### P2 — replace secret and data infrastructure adapters

1. Implement the Infisical machine-identity secret port and KMS envelope-cipher
   port.
2. Implement Supabase Postgres, Storage, queue, event/audit, and membership ports.
3. Migrate dynamic bank-session ciphertext from Supabase Vault to the KMS-backed
   store. Remove `get_worker_secret`, `*_bank_connection_secret`, and all Vault
   reads only after validated migration and revocation behavior.
4. Keep the queue worker as a thin job adapter calling lib. It can poll PGMQ
   through the Supabase infrastructure port; it must not contain use-case logic.

### P3 — port all product behavior, highest-risk slices first

1. **Bank and payments:** ASPSP discovery; auth start/callback completion;
   connection status, sync, and explicit disconnect/revocation; payment create,
   get, list, delete, submit, status events, and unknown-outcome handling.
2. **Ledger and receipt lifecycle:** account/transaction list and get; receipt
   upload/finalize/download/get/list; content indexing; durable jobs and audit.
3. **Reconciliation:** unmatched list, automatic matching, proposal, confirm,
   reject, conflict guards, and export inclusion.
4. **Search and AI:** lexical plus vector/hybrid RRF search, embeddings,
   reranking, distillation, line-item burst, AI policy, and summaries. Existing
   semantic behavior is not retired by default.
5. **Privacy:** complete export, signed downloads, deletion, remote bank
   revocation, event erasure, storage cleanup, and account/workspace metadata.

Port the current conservative `submission_unknown` behavior without automatic
retry. Payment creation timeout reconciliation is deliberately a post-retirement
gate: do not design or implement it until P5 has removed legacy code and the
capability cutover is complete.

### P4 — replace external adapters

1. Deploy ConnectRPC as Finch's sole application/service API with authenticated
   and internal service routes.
2. Implement an agent-only MCP Streamable HTTP adapter with exactly `exec` and
   `docs`. It validates its OAuth resource token, derives `PrincipalContext`, and
   invokes lib only through the bounded isolate bridge. Implement the current
   protocol discovery, authorization metadata, session, origin, and error
   requirements pinned for the release. Do not add WebSockets without a concrete
   MCP compatibility requirement.
3. Replace the browser/client SDK with a ConnectRPC client. Replace provider
   callback and worker invocation with thin adapters.
4. Disable the REST Edge API and custom MCP JSON-RPC endpoint only after client
   cutover and staging parity have passed.

### P5 — prove parity, then retire legacy

1. Run the capability matrix against both the legacy and ConnectRPC paths in
   staging using deterministic provider doubles and protected provider test
   credentials.
2. Validate auth/RLS equivalent authorization, secret redaction, key rotation,
   callbacks, worker recovery, all payment outcomes, export, and deletion.
3. Remove the SQLite runtime, local Drizzle migrations, `finch.toml`, Bun keyring
   code/tests, stdio MCP, legacy Connect server/client, local eval harnesses, and
   superseded design/gate documents.
4. Remove obsolete Supabase Edge business functions and Vault schema/functions.
   Retain only infrastructure resources still used by the new adapters.

### P6 — payment timeout reconciliation

After P5, obtain the provider-supported idempotency or reconciliation contract,
then implement and validate safe recovery for payment creation timeouts. Until
then, `submission_unknown` is visible to the user and is never automatically
resubmitted.

## Capability disposition

All behavior below is **must-port**; none is retired without explicit approval:

| Capability group | Legacy source | Required target |
| --- | --- | --- |
| Ledger lookup | `packages/lib/src/finances.ts` | ConnectRPC ledger methods for accounts, transactions, receipts, and search |
| Receipt intake | `packages/lib/src/finances.ts`, SQLite projections | ConnectRPC upload/finalize/download/list/get backed by private Storage |
| Reconciliation | `packages/lib/src/matching.ts`, `packages/reconciliation` | ConnectRPC match/list-unmatched/confirm/reject with durable concurrency guards |
| Bank lifecycle | `packages/lib/src/bank.ts` | ConnectRPC discovery/connect/status/sync/disconnect plus callback adapter |
| Payments | `packages/lib/src/payments.ts` | ConnectRPC create/get/list/delete/submit/status with explicit unknown state |
| Hybrid search and AI | `packages/search` and `packages/llm` | ConnectRPC lexical+dense RRF, embedding, rerank, distill, burst, policy, summary |
| Privacy | `packages/mcp/src/server.ts` | ConnectRPC export/deletion/privacy-status with remote revocation |
| Events/jobs | `packages/db` and workers | lib use cases over Supabase event/audit/queue ports |

The following are retirement candidates only after their target replacements pass:

- SQLite/Drizzle repositories, migrations, FTS5/vec0, local job workers, and
  `finch.toml`.
- Bun keyring configuration and all direct secret resolution outside Infisical/KMS.
- Stdio MCP and the current custom HTTP JSON-RPC MCP implementation.
- `packages/connect`'s SQLite server/client; canonical contracts and the new
  ConnectRPC server/client replace it.
- Legacy tests and evals, once their behavioral assertions are preserved as
  ConnectRPC/Supabase contract or staging tests.

## Deletion bar

Legacy code may be deleted only when every `connectrpc-cutover-20260910` gate is
met, including a reviewed capability matrix with no unapproved gaps, staging
evidence for every destructive/provider flow, zero production traffic to legacy
entrypoints, and a successful fresh deployment from the remaining code.

## Owner decisions required
