# Finch lib product surface (G9)

Goal: a single `@finch/lib` Effect surface that `packages/mcp` and
`packages/connect` both consume, so domain logic is written once and each
adapter stays a thin transport.

## Boundary

Moves into lib (pure domain, Effect signatures, no transport types):

- Tool/business flows now embedded in adapters: `toolEffect`/`searchFinances`/
  `getTransaction`/`captureReceipt`/… in `packages/mcp/src/server.ts`, and the
  `*Effect` family (`listAspspsEffect`, `startBankAuthEffect`,
  `authorizeBankSessionEffect`, `syncBankEffect`, `createPaymentEffect`, …)
  in `packages/connect/src/bank-service.ts` plus `searchEffect` in
  `packages/connect/src/search-service.ts`.
- Input validation currently duplicated per adapter: `decodeInput` +
  Effect-Schema structs (`SearchFinancesInput`, `CaptureReceiptInput`, …) in
  `server.ts` vs `requireText`/`tenantOf` + ad-hoc Schema decodes in
  `bank-service.ts`/`search-service.ts`.
- Error mapping: `errorPayload`/`SAFE_ERROR_FIELDS`/`safeJson` (`server.ts`)
  and `toBankConnectError`/`toConnectError` (`bank-service.ts`,
  `search-service.ts`).

Stays in adapters (transport-owned, never in lib):

- MCP: `TOOLS` table, `CallToolRequestSchema`/`ListToolsRequestSchema`
  wiring, `runTool`, `buildMcpServer`, `CallToolResult` shaping.
- Connect: proto message construction (`create(*Schema, …)`), `ServiceImpl`
  tables, `makeBankService`/`makeSearchService` `ManagedRuntime` handles.
- Composition roots only: `FinchMcpLive`/`BootLive` in
  `packages/mcp/src/main.ts`, `BankLayerLive`/`SearchLayerLive`/
  `ConnectDbLive` in `packages/connect`.

## Modules

`@finch/lib` namespaces (names only; every fn returns `Effect`):

- `lib/finances`: `search(tenantId, text, topK?)`, `getTransaction(tenantId, id)`,
  `getReceipt(tenantId, id)`, `captureReceipt(input)`, `listUnmatched(tenantId, limit?)`
- `lib/bank`: `listAspsps(country?)`, `startAuth(tenantId, aspsp, redirectUrl, state)`,
  `authorizeSession(tenantId, code, state)`, `sync(tenantId, since?)`,
  `status(tenantId)`, `deleteSession(tenantId)`
- `lib/payments`: `create(tenantId, paymentInput)`, `list(tenantId)`,
  `get(tenantId, paymentId)`, `submit(tenantId, paymentId)`, `remove(tenantId, paymentId)`
- `lib/matching`: `match(tenantId)`, `confirm(tenantId, txId, receiptId, by?)`,
  `reject(tenantId, txId, receiptId, reason)`
- `lib/inputs`: `decode(schema, args)` (single Schema gate → `ValidationFailed`)
- `lib/errors`: `toTransportTag(cause)` (single `_tag` → code mapping table)

Effect env for all of the above is today's `FinchMcpEnv` union
(`HybridSearch`, `TransactionRepository`, `ReceiptRepository`, `BankProvider`,
`BankIngest`, `BankSessionRepository`, `BankAuthIntentRepository`,
`EventStore`, `ProjectionRunner`, `ReceiptMatcher`, `BankPayments`).

## Adapter mapping

| Today | After |
|---|---|
| `server.ts: searchFinances/getTransaction/…` (19 closures over `FinchMcpEnv`) | thin wrappers calling `lib/finances.*`, `lib/bank.*`, `lib/matching.*` |
| `server.ts: TOOLS` + JSON schemas | unchanged (transport contract), inputs derived from `lib/inputs` schemas |
| `server.ts: runTool`/`errorPayload`/`safeJson` | `runTool` calls lib fns; formatting delegates to `lib/errors` |
| `bank-service.ts: *Effect` + `requireText`/`tenantOf` | call `lib/bank.*`/`lib/payments.*`; validation via `lib/inputs.decode` |
| `search-service.ts: searchEffect` | calls `lib/finances.search` |
| `main.ts: FinchMcpLive`, `bank-service.ts: BankLayerLive`, `search-service.ts: SearchLayerLive` | unchanged in phase 1; lib takes the env as a parameter, roots keep composing |

## Risks

- Signature churn: 19 MCP tools + 10 bank RPCs + search move at once → migrate
  one namespace at a time (`finances` first, no transport change per step).
- Validation drift: two dialects today (`decodeInput` vs `requireText`) → freeze
  `lib/inputs.decode` semantics (`ValidationFailed`, never throw) before porting.
- Bigint serialization: `safeJson` bigint→string rule must move verbatim into
  lib formatting, else ledger amounts lose precision over JSON.
- Layer double-provision: `MigratedDb`/`ConnectDbLive` memoization relies on
  layer identity — lib must accept env, never construct stores.
