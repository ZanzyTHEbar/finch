# Superseded: Exec-MCP isolation design (G10)

This document is superseded by `docs/design/connectrpc-cutover.md`. The active
design exposes exactly `exec` and `docs` through agent-only Streamable HTTP MCP,
uses a real per-request TypeScript process/container isolate, and calls lib
directly rather than ConnectRPC. Do not implement the direct-tool or worker-thread
design below.

Goal: collapse the 19 tools in `packages/mcp/src/server.ts` (`TOOLS` +
`toolEffect` switch) into `exec` + `describe`, with every run isolated,
tenant-scoped, bounded, and audited. `buildMcpServer` keeps its signature;
`runTool` becomes a dispatcher over an allowlisted plan.

## Isolate

- Worker boundary: `exec` never runs in-process. `runTool` serializes the
  decoded plan and hands it to a worker (worker_threads; processes if native
  deps forbid threads) that provides a fresh `FinchMcpEnv` layer per run.
- Allowed imports inside the worker: `@finch/lib/*` (phase 1: the current
  handler bodies hoisted from `server.ts`), `@finch/core` schemas/errors,
  repository/provider Tags. Forbidden: `@modelcontextprotocol/sdk`,
  ` drizzle`/SQL clients, `process.env`, network fetch, `main.ts` layer
  singletons (`FinchMcpLive`, `MigratedDb` handles cross runs).
- The MCP host keeps only `TOOLS`-metadata (`describe` output), `decodeInput`
  pre-validation, and `textResult`/`safeJson` shaping. Secrets and DB files
  never cross into the host response path beyond today's `errorPayload` fields.

## Tenant scoping

- `tenantId` stays server-bound, never model-chosen: the host resolves it from
  the session (today every input struct carries `TenantId` — e.g.
  `SearchFinancesInput`, `SyncBankInput`, `PaymentIdInput`) and injects it;
  worker re-decodes with `TenantId` and rejects mismatches as `TenantMismatch`.
- `authorizeBankSession`-style cross-checks (`BankAuthIntentRepository.get(state)`
  → `intent.tenantId !== input.tenantId` → `TenantMismatch`) become a lib-level
  guard applied to every exec plan, not per-tool code.
- Capabilities: per-tenant allowlist over plan verbs
  (`finances.search`, `bank.sync`, `payments.submit`, …); `list_aspsps`
  (no tenant today via `ListAspspsInput`) is the only unscoped verb. Denied
  verbs fail as `ValidationFailed` before the worker spawns.

## Limits

- Timeout: one `Effect.timeout(30s)` around the worker run (kills runaway
  `sync_bank`/`hybridSearch`); timeout maps to `ProviderUnavailable`, surfaced
  through the existing `Effect.matchCause` path in `runTool`.
- Call caps: max 1 plan verb + max 3 store/provider calls per `exec`
  (today `authorizeBankSession` already chains 4: intents→bank→sessions);
  deeper flows must be split by the caller. `match_receipts` fan-out stays
  inside `ReceiptMatcher.match`, not N exec rounds.
- Payload caps: input ≤ 64 KiB post-`decodeInput`; `textResult` output truncated
  at 256 KiB (today unbounded `JSON.stringify`); `topK`/`limit` clamped to ≤ 100
  (`PositiveInt` schemas gain `.pipe(Schema.lessThanOrEqualTo(100))`).

## Audit

- One event per exec run appended via `EventStore` (`aggregateType: "mcp.exec"`,
  `eventType: "ExecRun"`, actor `"mcp.exec"`): `{ tenantId, verb, argsHash,
  durationMs, outcome: ok | <_tag>, truncated }`. Never log full args
  (may carry `code`/`state`/PII) — hash only, same pattern as
  `capture_receipt`'s idempotent `${tenantId}:${imageHash}` keying.
- Transport log line per run (`toolEffect` name → plan verb, `_tag` on failure)
  reusing `errorPayload`'s `SAFE_ERROR_FIELDS` allowlist.
- `describe` calls are not audited (static metadata, no env access).

## Migration

1. Phase 0 — hoist: move the 19 handler bodies (`searchFinances` … `getBankStatus`)
   unchanged into `lib/*`; `toolEffect` delegates. No contract change.
2. Phase 1 — `describe`: add a `describe` tool returning the `TOOLS` table
   (names + input schemas); keep all 19 callable.
3. Phase 2 — `exec`: add `exec({ verb, args })` behind capabilities + limits +
   audit; port read-only verbs first (`search_finances`, `get_transaction`,
   `get_receipt`, `list_unmatched_receipts`, `get_bank_status`, `list_aspsps`,
   `list_payments`, `get_payment`), then writers, payments last
   (`create_payment`/`submit_payment`/`delete_payment` need stricter caps).
4. Phase 3 — deprecate: mark the 19 direct tools deprecated in `describe`,
   route `toolEffect` cases through `exec`, then remove cases once clients
   migrate. `bank-service.ts`/`search-service.ts` RPCs are untouched throughout.
