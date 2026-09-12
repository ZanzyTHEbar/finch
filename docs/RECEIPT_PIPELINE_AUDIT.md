# Receipt Pipeline Audit

Audit date: 2026-09-10

## Executive Summary

Finch does not currently have one end-to-end receipt pipeline. The worktree contains two incompatible implementations:

1. **Cloud/Supabase path:** the current intended runtime. It stores a receipt original in private Storage, verifies its SHA-256 hash, stores client-supplied metadata in Postgres, and creates a metadata-only lexical search document. It does not parse receipt contents, enqueue receipt embeddings, or perform receipt matching.
2. **Legacy SQLite path:** a local event-sourced runtime. It accepts a caller-supplied URI and hash, appends `ReceiptCaptured`, projects a SQLite row, creates a search document, queues an embedding, and can match receipts to transactions. The current README explicitly says this runtime is unsupported.

The strongest controls are cloud workspace membership/RLS, private Storage, server-side content hash verification, short-lived download URLs, and durable generic job leasing/retry. The highest risks are:

- Cloud finalization can leave a receipt `ready` but without its derived search document, with no retry or repair path.
- Abandoned, missing, or failed uploads can leave rows and objects that block retry through the workspace/hash uniqueness constraint.
- Cloud matching, OCR/parsing, and receipt embedding are schema or infrastructure concepts only, not an implemented receipt flow.
- Legacy projection failures are persisted as successful events; a duplicate retry skips the failed projection.
- Legacy matching has no database-enforced one-receipt/one-transaction invariant and can overwrite links under concurrency.
- The two contracts have no migration or bridge, and the cloud implementation is uncommitted worktree-only code.

The cloud happy path and database security/queue tests pass locally. Negative receipt lifecycle cases are not covered by the existing cloud test suite and were assessed statically.

## Scope And Evidence

Baseline:

- Repository: `/mnt/common/projects/tools/finch`
- Branch: `main`
- Committed `HEAD`: `b4391da6777a59206a4170de1ae3c66df7199898`
- The tracked diff at audit start contained 47 changed files, 1,823 additions, and 729 deletions; the worktree also contained untracked cloud, documentation, search, and reconciliation paths.
- `supabase/` and most cloud documentation are untracked worktree code. `packages/reconciliation/src/` and `packages/search/src/distill.ts` are also untracked. The base repository does contain the older SQLite receipt schema/repository surfaces.
- No deployment or production runtime evidence was available. Cloud findings describe the current worktree, not deployed behavior.

Evidence labels:

- `BASE`: present in committed `HEAD`.
- `WT`: modified tracked file in the current worktree.
- `WT-ONLY`: untracked or otherwise absent from committed `HEAD`.
- `DOC`: documentation or declared intent, not runtime proof.
- `RUNTIME`: observed in a local validation run.
- `Not evidenced`: no writer, call site, repair path, or test was found within the inspected repository scope.

## What The Pipeline Is

### Cloud receipt model

A cloud receipt is a private uploaded object plus a Postgres metadata row. The row contains a UUID, workspace, SHA-256, object key, MIME type, declared byte size, optional merchant/date/amount/currency, and `pending | ready | failed` state (`supabase/schemas/finch.sql:175-193`). A finalized receipt also has a derived `finance_documents` row containing a text representation of the supplied metadata (`supabase/schemas/finch.sql:248-264`).

The cloud path is therefore an **authenticated document upload and metadata indexing pipeline**, not an OCR or receipt-understanding pipeline.

### Legacy receipt model

A legacy receipt is a tenant-scoped SQLite row with optional transaction link, merchant, amount, currency, date, `imageRef`, `imageHash`, and `captured | matched | unmatched | archived` status (`packages/db/src/schema/receipts.ts:6-34`). Capture creates a logical ID of `${tenantId}:${imageHash}` and persists the URI/hash in an immutable `ReceiptCaptured` event (`packages/mcp/src/server.ts:550-585`).

The legacy path is an **event/project/search/reconcile pipeline**, but it does not upload or verify the original image. Its `imageRef` is only a caller-supplied reference.

## How It Is Implemented

### Cloud components

| Component | Responsibility | Evidence |
|---|---|---|
| REST API | Upload intent, finalize, signed download, list, lexical search | `supabase/functions/api/index.ts:154-253,515-530` |
| Remote MCP | Authenticated wrappers around the REST routes | `supabase/functions/mcp/index.ts:12-83` |
| Auth/workspace boundary | Verifies bearer token, active membership, role, and active workspace | `supabase/functions/_shared/supabase.ts:78-127` |
| Storage | Private `receipt-originals` bucket, 10 MiB, JPEG/PNG/PDF | `supabase/config.toml:118-127`; `supabase/schemas/finch.sql:1153-1162` |
| Source data | `receipts` and `receipt_matches` Postgres tables | `supabase/schemas/finch.sql:175-210` |
| Search projection | `finance_documents` row and generated FTS vector | `supabase/functions/api/index.ts:218-228`; `supabase/schemas/finch.sql:248-264` |
| Worker | Bank sync, generic search embeddings, exports, cleanup, deletion, payments, summaries | `supabase/functions/worker-run/index.ts:757-776` |
| Export/deletion | Includes receipt metadata/originals in exports and deletes workspace objects | `supabase/functions/worker-run/index.ts:359-421,717-754` |

No cloud component calls OCR, image/PDF extraction, receipt matching, or receipt embedding after finalization.

### Legacy components

| Component | Responsibility | Evidence |
|---|---|---|
| Local MCP | `capture_receipt`, receipt reads, matching, confirmation, rejection | `packages/mcp/src/server.ts:246-285,543-585,667-691,895-943` |
| `@finch/lib` | Duplicate business handlers intended for transport reuse | `packages/lib/src/finances.ts:30-79`; `packages/lib/src/matching.ts:24-48` |
| Event store | Validates catalog payloads, computes idempotency key, appends immutable events | `packages/db/src/event-store.ts:130-228`; `packages/db/src/schema/events.ts:5-30` |
| Projection runner | Creates receipt row, search document, embedding job, and match read models | `packages/db/src/projections/runner.ts:128-179,293-347` |
| SQLite receipt repository | Tenant-scoped reads, insert, transaction link, unmatched listing | `packages/db/src/repositories/receipt.ts:10-145` |
| Search | FTS immediately; vector search after `document.embed` drain | `packages/db/drizzle/0001_fts-triggers.sql:2-15`; `packages/search/src/embed-worker.ts:82-165` |
| Matcher | Scores unmatched receipts against booked transactions and appends match events | `packages/reconciliation/src/matcher.ts:107-257` |

## How It Works

### Cloud lifecycle

```text
authenticated workspace request
  -> insert receipts row with upload_state = pending
  -> issue signed Storage upload URL
  -> client uploads to private receipt-originals bucket
  -> finalize downloads object and computes SHA-256
       missing object  -> error; row remains pending
       hash mismatch   -> remove object, delete row, return 422
       hash match      -> mark ready
  -> upsert metadata-only finance_documents row
  -> audit successful finalization
  -> list/download/search/export/deletion can consume the receipt
```

Important state behavior:

| State/event | Actual behavior |
|---|---|
| Upload intent | Inserts `pending` before signed URL creation and audit. |
| Successful upload | Storage accepts a private object; the API does not parse its bytes. |
| Missing object | Finalization returns `receipt_object_missing`; no failure state or audit record is written. |
| Hash mismatch | Object removal is attempted; if removal succeeds, the receipt row is deleted and the request returns 422. If removal fails, the row remains `pending` and the request returns 500. |
| Hash match | Row becomes `ready` before the search document and final audit are written. |
| Search | The searchable content is only `receipt`, merchant, date, total, and currency. Search is lexical SQL FTS. |
| Semantic indexing | No receipt finalization path queues `search.embed`. |
| Matching | `receipt_matches` exists, but no cloud API, MCP tool, job, or worker case writes it. |
| Export | Only ready receipt objects are archived, but every receipt metadata row is assigned an `original_file` name. |
| Workspace deletion | Receipt objects are removed before receipt rows and derived documents are deleted. |

### Legacy lifecycle

```text
local MCP/lib capture_receipt
  -> validate input and derive tenant:imageHash aggregate ID
  -> append ReceiptCaptured event
  -> project receipt row with status = captured
  -> upsert receipt search_documents row
  -> enqueue document.embed
  -> worker drains FTS/vector work when explicitly invoked
  -> matcher lists unmatched receipts and booked transactions
  -> score candidates
       high score -> ReceiptMatched -> link transaction + confirm reconciliation
       lower score -> MatchProposed -> later MatchConfirmed/MatchRejected
```

The event is committed before projection. Projection writes are guarded/idempotent enough for a full rebuild, but there is no automatic projection retry from a duplicate capture request. `ProjectionRunner.rebuild` exists as a manual repair mechanism (`packages/db/src/projections/runner.ts:413-452`).

### Contract comparison

| Concern | Cloud | Legacy | Assessment |
|---|---|---|---|
| Tenant authority | Authenticated user plus workspace membership | Caller-supplied `tenantId` | Conflicting |
| Receipt identity | UUID | `${tenantId}:${imageHash}` | Conflicting |
| Original | Private Storage object | Caller-supplied `sourceUri` | Conflicting |
| Hash | Server verifies uploaded bytes against declared SHA-256 | Caller supplies hash; bytes are never read | Conflicting |
| Status | `pending`, `ready`, `failed` | `captured`, `matched`, `unmatched`, `archived` | Conflicting |
| Search source | Postgres `finance_documents` | SQLite `search_documents` | Conflicting |
| Embedding job | `search.embed` exists, but receipts are not queued | `document.embed` is queued by projection | Unmapped |
| Matching | `receipt_matches` table only | Evented reconciliation and transaction link | Unmapped |
| Migration/bridge | Fresh bootstrap explicitly has no import/compatibility layer | No cloud adapter | Not evidenced |

## Findings

### REC-ARCH-001: Two incompatible receipt contracts have no bridge

- **Runtime:** Shared architecture
- **Provenance:** `WT`/`WT-ONLY` plus `DOC`
- **Status:** Contradicted / Partial
- **Severity:** High
- **Confidence:** High
- **Evidence:** Cloud declares a fresh deployment with no SQLite import or compatibility layer (`README.md:3-5`; `supabase/schemas/finch.sql:1-3`; `scripts/bootstrap-supabase.mjs:5-17`). The cloud and legacy contracts differ in identity, storage, state, search, and matching as shown above.
- **Impact:** It is unclear which receipt behavior is supported, how existing receipts migrate, or whether a receipt created through one transport can be consumed by the other. Documentation claims cloud-only support while reconciliation documentation describes the legacy implementation as done.
- **Direction:** Declare one canonical runtime and explicitly deprecate/isolate the other, or define and test a translation contract before claiming interoperability.

### REC-CLOUD-001: Finalization can publish `ready` without publishing the derived document

- **Runtime:** Cloud
- **Provenance:** `WT-ONLY`
- **Status:** Code-present
- **Severity:** High
- **Confidence:** High
- **Evidence:** `finalizeReceiptUpload` updates `receipts.upload_state` to `ready` at `supabase/functions/api/index.ts:216-217`, then upserts `finance_documents` at `:218-230`, then writes the audit event at `:231`. These are separate operations and there is no finalize job or repair route.
- **Impact:** A document-upsert or audit failure can return an error after the receipt is already ready. A retry receives `receipt_not_pending` at `:205`, while the receipt may be downloadable but absent from search.
- **Direction:** Make publication retryable and idempotent as one durable workflow, or add a repair operation that reconciles ready receipts with derived documents.

### REC-CLOUD-002: Upload failures can leave permanently blocked or orphaned receipts

- **Runtime:** Cloud
- **Provenance:** `WT-ONLY`
- **Status:** Code-present
- **Severity:** High
- **Confidence:** High
- **Evidence:** The row is inserted as `pending` before signed URL creation at `supabase/functions/api/index.ts:169-188`. Missing objects return without changing state at `:205-207`. On hash mismatch, object removal is attempted and the row is deleted only if removal succeeds (`:208-214`). The schema then prevents another row with the same workspace/hash at `supabase/schemas/finch.sql:178-191`. Cleanup only handles export objects or complete workspace deletion (`worker-run/index.ts:498-517,717-754`).
- **Impact:** A failed URL request, abandoned upload, missing object, or failed cleanup can consume the deduplication key and retain a pending row or object with no user-visible reset, retry, delete, or stale-upload cleanup path. The declared `failed` state currently has no receipt transition.
- **Direction:** Add bounded pending/failed cleanup and explicit retry/reset semantics. Make cleanup and state transitions idempotent and observable.

### REC-CLOUD-003: No OCR, parsing, or content extraction is implemented

- **Runtime:** Cloud
- **Provenance:** `WT-ONLY`
- **Status:** Partial
- **Severity:** High if receipt understanding is required; otherwise a product-scope gap
- **Confidence:** High
- **Evidence:** Finalization only downloads the object to hash it at `supabase/functions/api/index.ts:206-208`. The indexed string at `:218-228` is assembled from caller-supplied merchant, date, total, and currency. No parser/OCR call site exists in the receipt route, worker dispatch, or schema.
- **Impact:** The system cannot discover merchant, totals, tax, line items, or dates that are absent or wrong in client metadata. Matching cannot use extracted receipt content.
- **Direction:** Either define receipts explicitly as metadata-only or add a durable parsing/OCR stage with extraction state, confidence, review, and retry semantics.

### REC-CLOUD-004: Ready receipt documents are not queued for semantic embedding

- **Runtime:** Cloud
- **Provenance:** `WT-ONLY`
- **Status:** Partial
- **Severity:** Medium
- **Confidence:** High
- **Evidence:** The generic embedding helper queues `search.embed` at `supabase/functions/worker-run/index.ts:101-117`, and transactions/summaries call it at `:217-229,655-662`. Receipt finalization creates `finance_documents` but never calls the helper (`api/index.ts:216-232`). Public search is lexical FTS (`supabase/schemas/finch.sql:688-709`).
- **Impact:** Receipt search has no semantic/vector path even when workspace AI policy allows embeddings. The remote MCP description implies semantic indexing can be policy-controlled, but receipt finalization does not enter that pipeline.
- **Direction:** Queue receipt embeddings from the same durable publication path, or document and expose lexical-only receipt search.

### REC-CLOUD-005: Cloud receipt matching is schema-only

- **Runtime:** Cloud
- **Provenance:** `WT-ONLY`
- **Status:** Not evidenced / Partial
- **Severity:** High if matching is part of the required receipt pipeline
- **Confidence:** High
- **Evidence:** `receipt_matches` is defined at `supabase/schemas/finch.sql:195-210`, but repository search found no cloud insert/update path. Cloud MCP exposes upload/finalize/download/list tools only (`supabase/functions/mcp/index.ts:12-30`), the API has no matching routes (`api/index.ts:515-537`), and the worker switch has no matching job (`worker-run/index.ts:757-775`).
- **Impact:** Receipts cannot be proposed, confirmed, rejected, or linked to cloud transactions. The table can create the impression that reconciliation is supported when it is not.
- **Direction:** Implement the cloud matching lifecycle or remove/mark the table as planned-only. Define candidate generation, one-to-one constraints, decision authorization, and status projection.

### REC-CLOUD-006: Receipt metadata is client-declared beyond the verified hash

- **Runtime:** Cloud
- **Provenance:** `WT-ONLY`
- **Status:** Code-present
- **Severity:** Medium
- **Confidence:** High
- **Evidence:** Upload intent stores request `mimeType` and `byteSize` at `supabase/functions/api/index.ts:154-180`. Finalization verifies only SHA-256 at `:206-208`; it does not compare the downloaded object size or content signature with the stored values. `receiptDate` is only length-checked at `:179`; the database date conversion is the eventual validator.
- **Impact:** Search/export metadata can misstate file size, MIME type, or date. A valid hash proves byte identity with the client-declared hash, not that the object is a valid receipt or that declared metadata describes it.
- **Direction:** Inspect actual object metadata/content at finalization and validate dates before insert; treat user metadata as untrusted provenance.

### REC-CLOUD-007: Receipt failure paths are not audited and exports can reference missing files

- **Runtime:** Cloud
- **Provenance:** `WT-ONLY`
- **Status:** Code-present
- **Severity:** Medium
- **Confidence:** High
- **Evidence:** Missing-object and hash-mismatch branches return at `supabase/functions/api/index.ts:205-215` without calling `audit`. Successful audit calls occur at `:189,231,241`. Export files are created only for ready receipts at `worker-run/index.ts:370-380`, while every receipt row receives an `original_file` field at `:386-389` and is emitted in the metadata dataset at `:390-395`.
- **Impact:** Operators cannot distinguish failed/missing receipt attempts from absent activity through the audit trail. Exports for pending/failed rows can promise `original_file` entries that are not present in the archive.
- **Direction:** Audit terminal and recoverable receipt failures, and only advertise an archive file when it was included.

### REC-LEGACY-001: Legacy transports trust caller-selected tenant identity

- **Runtime:** Legacy SQLite MCP/Connect
- **Provenance:** `BASE` transport surface plus `WT` handlers
- **Status:** Code-present; contextual risk
- **Severity:** High if exposed beyond a trusted local process
- **Confidence:** High
- **Evidence:** Legacy tool schemas accept `tenantId` directly (`packages/mcp/src/server.ts:100-114,160-168`). `buildMcpServer` dispatches requests without an authentication or tenant-binding layer (`packages/mcp/src/server.ts:1011-1016`). Connect search also accepts request tenant IDs (`packages/connect/src/search-service.ts:96-114`), while the server only binds to loopback (`packages/connect/src/main.ts:28-35`).
- **Impact:** Any caller that can reach these transports can select another tenant ID and read/search that tenant's local data. The risk is reduced only by process/network isolation and the README's unsupported-runtime declaration.
- **Direction:** Do not expose legacy transports as multi-tenant services. Bind tenant identity to an authenticated session or isolate one database/tenant per process.

### REC-LEGACY-002: Duplicate capture retries do not repair failed projections

- **Runtime:** Legacy SQLite
- **Provenance:** `BASE`/`WT`
- **Status:** Code-present
- **Severity:** High
- **Confidence:** High
- **Evidence:** Event insertion commits before projection in `packages/db/src/event-store.ts:176-228`. Capture catches `DuplicateEvent` and skips `projections.project` at `packages/mcp/src/server.ts:550-584` and `packages/lib/src/finances.ts:37-72`. The manual rebuild is the only visible repair path (`packages/db/src/projections/runner.ts:413-452`).
- **Impact:** If receipt row, search document, or job enqueue fails after event commit, retrying the same capture returns `{ duplicate: true }` without repairing derived state. The event is durable but the receipt can be absent from reads/search/jobs until an operator runs a rebuild.
- **Direction:** Make projection delivery durable or have duplicate handling verify and repair all derived receipt state.

### REC-LEGACY-003: Matched receipts retain `status = captured`

- **Runtime:** Legacy SQLite
- **Provenance:** `BASE`/`WT`
- **Status:** Code-present
- **Severity:** Medium
- **Confidence:** High
- **Evidence:** Capture initializes status to `captured` at `packages/db/src/projections/runner.ts:300-309`. `ReceiptRepository.linkTransaction` updates only `transactionId` at `packages/db/src/repositories/receipt.ts:98-105`. Match projection calls link and refreshes the document without changing status at `runner.ts:314-339`. The canonical search text includes that status at `packages/db/src/projections/search-documents.ts:48-65`.
- **Impact:** API rows and search documents report a captured receipt after a successful match. Consumers must infer matching from `transactionId`; the declared `matched` status is not a reliable state.
- **Direction:** Make status transitions explicit and covered by a regression test, or derive status from the transaction link and remove the redundant mutable field.

### REC-LEGACY-004: Source references and hashes are caller-trusted and searchable

- **Runtime:** Legacy SQLite/search/LLM path
- **Provenance:** `WT`
- **Status:** Code-present
- **Severity:** Medium
- **Confidence:** High
- **Evidence:** Legacy capture accepts `imageHash` and `sourceUri` without reading an object (`packages/mcp/src/server.ts:160-168,562-570`). Projection persists them as `imageHash`/`imageRef` (`runner.ts:300-308`). `receiptCanonical` includes `imageRef` in searchable text (`search-documents.ts:48-65`), and default distillation sends that text to the configured LLM (`finch.toml:24-26`; `packages/search/src/distill.ts:4-22,42-50`).
- **Impact:** A caller can register a false hash or a sensitive URI. The URI can appear in search results and external embedding prompts. There is no original-byte integrity check in this runtime.
- **Direction:** Verify content at an owned storage boundary, use opaque internal references, and exclude raw object URLs from search and model prompts.

### REC-LEGACY-005: Matching is not one-to-one or concurrency-safe

- **Runtime:** Legacy reconciliation
- **Provenance:** `WT-ONLY` matcher plus `BASE` schema/repository
- **Status:** Code-present
- **Severity:** High for financial correctness
- **Confidence:** High
- **Evidence:** The matcher builds `takenTx`/`takenRx` in memory and then appends/link events (`packages/reconciliation/src/matcher.ts:110-123,188-220`). The receipt link update has no current-link predicate (`packages/db/src/repositories/receipt.ts:98-105`). The SQLite schema has no unique constraint preventing a transaction or receipt from appearing in multiple pairs; it only has unique `(tenant, transaction, receipt)` pairs (`packages/db/src/schema/reconciliation.ts:7-27`).
- **Impact:** Concurrent matcher runs or manual decisions can select the same transaction/receipt, and a later link can overwrite an earlier transaction link. The in-memory sets do not protect separate processes.
- **Direction:** Enforce ownership/active-link invariants in the database and make selection plus link/decision a guarded transaction.

### REC-LEGACY-006: Reconciliation state transitions are not guarded

- **Runtime:** Legacy reconciliation
- **Provenance:** `BASE`/`WT-ONLY`
- **Status:** Code-present
- **Severity:** Medium
- **Confidence:** High
- **Evidence:** `propose` resets any existing pair to `proposed` at `packages/db/src/repositories/reconciliation.ts:103-120`. `confirm`/`reject` update by pair without requiring current status `proposed` at `:133-157`. The schema only restricts the status vocabulary (`packages/db/src/schema/reconciliation.ts:20-26`).
- **Impact:** A confirmed or rejected decision can be overwritten or reopened without a state conflict. Event history records activity, but the current read model does not enforce a valid decision sequence.
- **Direction:** Add compare-and-set status predicates and explicit transition rules.

### REC-LEGACY-007: Capture deduplication is not solely tenant plus image hash

- **Runtime:** Legacy capture
- **Provenance:** `WT`
- **Status:** Code-present
- **Severity:** Medium
- **Confidence:** High
- **Evidence:** Capture uses the same aggregate ID `${tenantId}:${imageHash}` at `packages/mcp/src/server.ts:555`, but the default event idempotency key includes the complete payload (`packages/core/src/domain/events/envelope.ts:71-95`). A same-hash capture with changed metadata can therefore append another event; projection sees the existing row and skips the insert at `packages/db/src/projections/runner.ts:293-311`.
- **Impact:** The call reports `duplicate: false` while preserving the first metadata and adding an extra event. Callers cannot distinguish a harmless replay from conflicting metadata for the same content identity.
- **Direction:** Make hash identity an explicit unique command key and reject conflicting metadata, or define payload-sensitive versioning intentionally.

### REC-LEGACY-008: Receipt embedding is queued but not continuously serviced; line-item burst is invalid with FK enforcement

- **Runtime:** Legacy search
- **Provenance:** `WT-ONLY`
- **Status:** Partial / Code-present
- **Severity:** Medium for semantic search; Low for the unused burst extension
- **Confidence:** High
- **Evidence:** Receipt projection queues `document.embed` (`packages/db/src/projections/runner.ts:158-179`), but the local MCP process drains at boot only (`packages/mcp/src/main.ts:121-127`), and Connect exposes drain as a host-controlled method (`packages/connect/src/handle.ts:54-61`). The line-item burst writes a formatted ID into an embeddings FK that references `search_documents.id` (`packages/search/src/burst.ts:81-93`; `packages/db/src/schema/embeddings.ts:13-15`). Its test disables foreign keys specifically (`tests/search/burst.test.ts:61-67`).
- **Impact:** New captures can remain lexical-only until an external drain is invoked. Enabling burst under normal FK enforcement fails after creating the search row/vector.
- **Direction:** Give embedding jobs a real scheduler/worker trigger and either remove the unwired burst path or use the returned search-document UUID consistently.

### REC-OPS-001: Default validation does not cover the legacy receipt implementation

- **Runtime:** Repository/CI
- **Provenance:** `WT`
- **Status:** Code-present
- **Severity:** Medium
- **Confidence:** High
- **Evidence:** Root TypeScript includes only `tests/supabase/**/*.ts`, scripts, and `vitest.config.ts` (`tsconfig.json:1-4`). Vitest includes only `tests/supabase/**/*.test.ts` (`vitest.config.ts:3-8`). CI runs `bun run verify` (`.github/workflows/ci.yml:8-18`), which follows the cloud test path. Legacy receipt tests exist but are not part of that default suite.
- **Impact:** Regressions in SQLite receipt projection, matching, and embedding code can pass CI while cloud tests remain green. The repository currently requires Bun's test runner for `bun:sqlite`; a direct Vitest invocation reports no matching configured files or cannot load `bun:sqlite`.
- **Direction:** Choose one supported test command and include the legacy suite if the runtime remains in the repository, or remove/deprecate the legacy code and its tests explicitly.

### REC-DOC-001: Documentation and gates disagree about receipt support

- **Runtime:** Documentation/process
- **Provenance:** `DOC`/`WT-ONLY`
- **Status:** Contradicted
- **Severity:** Low to Medium
- **Confidence:** High
- **Evidence:** README says cloud-only and legacy unsupported (`README.md:3-5`). Reconciliation documentation marks receipt matching done (`docs/RECONCILIATION.md:6-20`) while describing the old local architecture (`:59-76`). `GATES.md:118-121` still marks the multi-line receipt burst gate incomplete.
- **Impact:** Reviewers and operators cannot tell whether receipt matching, line-item extraction, or the local runtime are supported requirements or abandoned work.
- **Direction:** Make the support matrix authoritative and align README, reconciliation docs, gates, CI, and deployment documentation.

## Existing Controls And Positive Evidence

Cloud controls:

- Every cloud receipt operation obtains an authenticated user and active workspace membership (`supabase/functions/_shared/supabase.ts:78-127`).
- Raw table access is restricted by privileges/RLS, and the safe receipt view omits `object_key` (`supabase/schemas/finch.sql:1058-1063,1088-1125`).
- Storage is private, direct authenticated Storage access is denied, and download URLs expire after 60 seconds (`supabase/schemas/finch.sql:1153-1162`; `api/index.ts:235-242`).
- Actual uploaded bytes are SHA-256 hashed before a receipt can become ready (`api/index.ts:206-208`).
- Workspace/transaction and workspace/receipt composite foreign keys prevent cross-workspace cloud match rows (`finch.sql:207-208`).
- Generic worker jobs have leases, delayed retry, bounded attempts, and dead-letter archiving (`finch.sql:711-909`). These controls do not currently cover receipt finalization because it is synchronous.

Legacy controls:

- Event payloads are catalog-validated before insertion (`packages/db/src/event-store.ts:134-152`).
- Event idempotency is tenant-scoped (`packages/db/src/schema/events.ts:23-27`).
- Normal repository reads scope by tenant, and explicit transaction linking/match proposal checks same-tenant ownership (`packages/db/src/repositories/receipt.ts:40-56,84-97`; `packages/db/src/repositories/reconciliation.ts:63-92`).
- Search FTS triggers update documents on insert/update/delete (`packages/db/drizzle/0001_fts-triggers.sql:4-15`).
- Full projection rebuild exists and current legacy receipt/projection/matching tests pass.

## Validation Results

| Command | Result | Notes |
|---|---|---|
| `bun run typecheck` | PASS | Current root TypeScript scope completes successfully. |
| `bun run supabase:reset` | PASS | Disposable local database reset. |
| `bun run supabase:bootstrap:local` | PASS | Fresh cloud schema applied. |
| `bun run supabase:test` | PASS | 3 SQL files, 27 database tests. |
| `bun run test:cloud` | PASS on retry | 4 Edge/Auth/RLS tests passed after the local database finished restarting. The first immediate run hit a transient Auth-to-Postgres connection refusal. |
| `bun test tests/mcp tests/projections tests/reconciliation tests/repos tests/search` | PASS | 113 tests, 2,128 expectations across 25 files. |
| `git diff --check` | PASS | No whitespace errors in the pre-existing tracked diff. |
| `bunx vitest run ... legacy files` | BLOCKED/NOT APPLICABLE | Existing Vitest config includes only `tests/supabase`; a temporary broader config could discover the files but Node/Vitest cannot load Bun-only `bun:sqlite`. Bun's test runner is the working legacy command. |

Dynamic cloud validation covered the existing authenticated happy path, private Storage behavior, signed upload/finalize, safe reads, worker authentication, and remote MCP authentication. No existing test exercises hash mismatch, missing object, repeated finalize, partial finalize failure, stale upload cleanup, duplicate hash recovery, cloud matching, or receipt embedding.

## Prioritized Direction

1. Choose and document the canonical receipt runtime before extending either implementation.
2. Make cloud receipt finalization durable and repairable, including stale/failed upload cleanup and failure audit events.
3. Decide whether receipt requirements include OCR, semantic search, and reconciliation; implement only the chosen stages with explicit state and retry contracts.
4. If legacy remains supported, fix projection retry semantics, receipt status transitions, matching invariants, and tenant/auth boundaries.
5. Align CI and documentation with the chosen runtime; do not leave two receipt contracts described as simultaneously complete.

## Audit Limitations

- No production deployment, production database, or external provider behavior was inspected.
- Cloud negative paths were reasoned from current code and schema rather than injected fault tests.
- The report treats the current worktree as the requested audit target and labels cloud/untracked behavior accordingly.
