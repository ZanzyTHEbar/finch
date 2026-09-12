# Finch Reconciliation — ChatGPT Production Architecture vs Current State

Date: 2026-09-09
Scope: Full codebase audit against 20-point production architecture

## Summary

| Category | Status |
|----------|--------|
| Core architecture (hexagonal, Effect, event-sourced) | ✅ Done |
| Multi-tenant by design | ✅ Done |
| Bank provider adapter pattern | ✅ Done |
| LLM adapter pattern | ✅ Done |
| Search + retrieval pipeline | ✅ Done |
| Receipt matching + reconciliation | ✅ Done |
| Payment persistence (event-sourced) | ✅ Done |
| MCP server (19 tools) | ✅ Done |
| ConnectRPC services | ✅ Done |
| CI + test infrastructure | ✅ Done |
| @finch/lib extraction | ❌ Not started |
| exec-MCP (single-tool isolate) | ❌ Not started |
| Bank connection lifecycle (pending→active→expired→revoked) | ❌ Not started |
| Async bank sync (queue + worker) | ❌ Not started |
| Credential vault / KMS | ❌ Not started |
| User data-control surface | ❌ Not started |
| Audit trail (security-significant events) | ❌ Not started |
| AI data policy configuration | ❌ Not started |
| Tenant CRUD API | ❌ Not started |

## Point-by-Point Reconciliation

### 1. Customer never sees provider credentials ✅ DONE
**ChatGPT**: "Your customers should never interact with the bank provider API credentials at all."
**Current**: Enable Banking credentials (`applicationId`, `privateKeyPem`) stored in keyring/env. MCP tools take `tenantId` — no credential exposure. Customer only performs bank authorization/consent.
**Evidence**: `packages/enablebanking/src/client.ts` loads config from `AppConfigTag`, not from user input. `packages/mcp/src/server.ts` tools never expose credentials.

### 2. Don't model credentials as user-supplied ✅ DONE
**ChatGPT**: "Do not make your domain model User → EnableBankingCredentials."
**Current**: No `EnableBankingCredentials` table. Domain model is `Tenant → BankSession → Accounts → Transactions`. Provider credentials are infrastructure config.
**Evidence**: `bank_sessions` table has `tenant_id` + `session_id`. No user-supplied credential fields.

### 3. Every banking connection has security boundary ⚠️ PARTIAL
**ChatGPT**: "Give every banking connection its own security boundary" with `status: pending|active|expired|revoked|error`.
**Current**: `bank_sessions` is binary (exists or doesn't). `bank_auth_intents` tracks auth state. No explicit lifecycle status.
**Gap**: Need `BankConnection` entity with status lifecycle. Current model is `BankSession` (session_id + tenant_id) — no pending/active/expired/revoked states.
**Fix**: Add `status` column to `bank_sessions` or create new `bank_connections` table with lifecycle.

### 4. Multi-tenant architecture ✅ DONE
**ChatGPT**: "Make Finch itself multi-tenant."
**Current**: All 14 tables have `tenant_id` FK. Tenant scoping enforced at repository level. `TenantMismatch` error for cross-tenant access.
**Evidence**: `packages/db/src/repositories/*.ts` — every query scopes by `tenant_id`. `BankAuthIntentRepository.put` rejects cross-tenant reuse.

### 5. Stateless Kubernetes pods ❌ NOT APPLICABLE (yet)
**ChatGPT**: "Your application pods should contain no durable state."
**Current**: Local SQLite file. Single-process architecture. Not designed for K8s.
**Assessment**: This is a cloud-deployment concern. Current architecture is local-first. When cloud deployment is needed, migrate SQLite → PostgreSQL + object storage + queue.
**Recommendation**: Defer until cloud deployment is planned. Keep local SQLite for v1.

### 6. Async bank sync ❌ NOT DONE
**ChatGPT**: "Bank synchronization should happen on connection, periodically, on demand."
**Current**: `sync_bank` in MCP server is synchronous — calls `BankIngest.syncSince` and waits. No queue, no worker, no background processing.
**Gap**: Need async job queue for bank sync. Currently synchronous.
**Fix**: Use existing `jobs` table + `JobRepository` for async bank sync. Create worker that polls `listDue` and executes sync.

### 7. Two-stage data model ✅ DONE (conceptually)
**ChatGPT**: "Separate source-of-truth banking data from Finch intelligence."
**Current**:
- Source-of-truth: `accounts`, `transactions`, `receipts`, `bank_sessions`, `payments`
- Intelligence: `search_documents`, `embeddings`, `summaries`, `reconciliations`
**Evidence**: Two-stage separation exists. `search_documents` are derived from source tables. `embeddings` are derived from search documents.

### 8. Credential vault / KMS ❌ NOT DONE
**ChatGPT**: "Introduce a dedicated Credential Vault instead of putting provider session artifacts directly into PostgreSQL in plaintext."
**Current**: Keys in keyring (bun:secrets) or env vars. No envelope encryption. No KMS/Vault.
**Gap**: No secret manager/KMS integration. Keyring is sufficient for local-first v1.
**Recommendation**: Defer until cloud deployment. Local keyring is appropriate for v1.

### 9. LLM tenant boundary ✅ DONE
**ChatGPT**: "Do not send all customer transactions into an LLM context."
**Current**: `hybridSearch` takes `tenantId` in input. All searches scoped by tenant. LLM only receives relevant records for the query.
**Evidence**: `packages/search/src/hybrid.ts` — `HybridSearchInput` includes `tenantId`. Search documents are tenant-scoped.

### 10. AI data policy ❌ NOT DONE
**ChatGPT**: "Your users should be able to understand what happens with their data."
**Current**: Config has `enableDistillation` and `enableReranker` flags. No user-facing AI policy UI.
**Gap**: No user-facing data policy configuration. No export/delete controls.
**Fix**: Add `ai_policy` section to `finch.toml` and/or MCP tool for user to configure.

### 11. Enable Banking auth model ✅ DONE
**ChatGPT**: "Enable Banking already gives you the right user-facing authorization model."
**Current**: `start_bank_auth` → Enable Banking `/auth` → redirect URL → user authorizes → `authorize_bank_session` with code.
**Evidence**: `packages/mcp/src/server.ts` — `start_bank_auth` tool calls `BankProvider.startAuthorization`. `authorize_bank_session` calls `BankProvider.createSession`.

### 12. Portugal as initial market ✅ DONE
**ChatGPT**: "Enable Banking currently lists extensive Portuguese AISP coverage."
**Current**: `listAspsps` takes optional `country` filter. Portuguese banks supported.
**Evidence**: `packages/enablebanking/src/client.ts` — `listAspsps()` calls Enable Banking `/aspsps` endpoint.

### 13. Regulatory model (AISP vs TPP) ❌ NOT DOCUMENTED
**ChatGPT**: "For Finch v1, I would strongly investigate Model A first."
**Current**: No regulatory architecture documentation. Code doesn't distinguish AISP vs TPP.
**Gap**: Need regulatory architecture doc explaining which model Finch uses.
**Fix**: Add `docs/design/regulatory.md` explaining Model A (Enable Banking as regulated AISP).

### 14. Commercial relationship with Enable Banking ❌ NOT IN CODE
**ChatGPT**: "The exact commercial/reseller/subscriber arrangement is something I would get in writing."
**Assessment**: Business/legal concern, not code. Defer to business planning.

### 15. API as domain capability ⚠️ PARTIAL (design exists, not implemented)
**ChatGPT**: "Make your API expose banking as a domain capability."
**Current**: Domain logic duplicated in `server.ts` (MCP) and `bank-service.ts` (Connect). `lib-surface.md` design doc exists but `@finch/lib` not built.
**Gap**: `@finch/lib` doesn't exist. Domain logic is duplicated across transport layers.
**Fix**: Implement `@finch/lib` per `docs/design/lib-surface.md`.

### 16. Provider credentials as infrastructure-level ✅ DONE
**ChatGPT**: "Make provider credentials infrastructure-level."
**Current**: Credentials in `finch.toml` / keyring. `AppConfig` loads them at boot. Not scattered through application code.
**Evidence**: `packages/core/src/config/config.ts` — `AppConfigLive` loads all credentials from keyring/env.

### 17. Sessions should be ephemeral ⚠️ PARTIAL
**ChatGPT**: "Bank authorization sessions should be workflow objects with lifecycle."
**Current**: `bank_sessions` is persistent table (one session per tenant). `bank_auth_intents` tracks auth state. Both are persistent, not ephemeral.
**Gap**: Sessions don't have pending/active/expired/revoked lifecycle.
**Fix**: Add status lifecycle to bank sessions per ChatGPT Point 3.

### 18. Full audit trail ⚠️ PARTIAL (event sourcing exists, security events missing)
**ChatGPT**: "Record security-significant events."
**Current**: Event sourcing provides audit trail. Events include `tenant_id`, `aggregate_type`, `event_type`, `occurred_at`. But no explicit security-significant events (`bank.connection.created`, `bank.authorization.started`, etc.).
**Gap**: Need security-significant audit events.
**Fix**: Add `BankConnectionCreated`, `BankAuthorizationStarted`, `BankAuthorizationCompleted`, `BankSyncStarted`, `BankSyncCompleted` events.

### 19. User data-control surface ❌ NOT DONE
**ChatGPT**: "Give the user an actual data-control surface."
**Current**: MCP tools provide `get_bank_status`, `delete_bank_session`, `list_payments`, `delete_payment`. No data export, deletion, or privacy controls.
**Gap**: No user-facing data export, deletion, or privacy controls.
**Fix**: Add `export_data`, `delete_account`, `data_privacy_settings` MCP tools.

### 20. Final architecture ❌ NOT APPLICABLE (yet)
**ChatGPT**: "Cloud-native with PostgreSQL, object storage, queues, K8s."
**Current**: Local SQLite, single-process, MCP stdio.
**Assessment**: Cloud deployment is a future concern. Current architecture is appropriate for v1 local-first product.
**Recommendation**: Defer until cloud deployment is planned.

## Prioritized Gaps

### P0 — Must fix (blocks production use)
None. Current architecture is functional for v1 local-first product.

### P1 — Should fix (improves production readiness)
1. **Bank connection lifecycle** (Points 3, 17) — Add status to `bank_sessions`
2. **Async bank sync** (Point 6) — Use jobs table for background sync
3. **Security audit events** (Point 18) — Add security-significant events
4. **@finch/lib extraction** (Point 15) — Eliminate domain logic duplication

### P2 — Nice to have (improves user experience)
5. **User data-control surface** (Point 19) — Export/delete/privacy controls
6. **AI data policy** (Point 10) — User-facing AI configuration
7. **Tenant CRUD** (Point 4) — API for tenant management
8. **Regulatory documentation** (Point 13) — Document AISP model

### P3 — Defer (cloud deployment concerns)
9. **Credential vault / KMS** (Point 8) — Defer until cloud
10. **Stateless K8s pods** (Point 5) — Defer until cloud
11. **PostgreSQL migration** (Point 20) — Defer until cloud
