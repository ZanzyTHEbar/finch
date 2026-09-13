# Document Ingest v1

**Status:** Proposed target architecture, 2026-09-10

**Audience:** Finch implementation agents and reviewers

**Decision owner:** Finch product/architecture
**Scope:** Physical-paper capture and durable ingestion of financial documents into Finch

## 1. Decision Summary

Finch will add `document.ingest.v1`: a bounded ingestion domain that turns an
immutable uploaded or captured artifact into provenance-bearing, reviewable,
canonical financial rows.

This is a logical service boundary now. It is **not** a separate deployable
microservice on day one:

- Supabase Auth, Postgres, private Storage, and PGMQ remain the data plane.
- The control plane authenticates a user, authorizes a workspace, issues upload
  URLs, accepts a committed artifact, and exposes status and review operations.
- A worker verifies artifacts and runs one idempotent processing stage at a
  time. It does not run during an upload request.
- OCR, document parsers, and vision-language models (VLMs) are replaceable
  extractor adapters. They return hypotheses; they never write canonical rows.
- A dedicated persistent ingestion worker is added only when a processing stage
  cannot meet the current Edge worker's safe budget of about 45 seconds, or
  when queue volume requires continuous consumption.

The public control plane is the Supabase Edge REST API. New endpoints preserve
the commands and invariants below.

## 2. Why This Exists

Finch's current cloud receipt path accepts only JPEG, PNG, and PDF originals;
it verifies a client-declared SHA-256 and immediately indexes client-supplied
metadata. It does not extract receipt content or provide a durable extraction
workflow (`supabase/functions/api/index.ts`, `supabase/schemas/finch.sql`).

The product requirement is broader:

- Physical paper captured through a camera.
- Images, scans, PDFs, DOCX, XLSX, and invoices.
- Google Sheets and other connector-backed sources as immutable snapshots.
- Structured e-invoices, QR codes, native text, OCR, and optional VLMs.
- Canonical financial data, not an archive of vendor-shaped OCR JSON.

These sources have incompatible latency and failure semantics. Capture needs
fast feedback; extraction may take seconds or minutes; canonical publication
must be transactional and auditable. A single synchronous "upload receipt"
handler is the wrong boundary.

## 3. Non-Negotiable Invariants

1. **Persist before interpret.** No extraction runs until original bytes,
   immutable hashes, workspace scope, and a durable job exist.
2. **Unselected camera frames are ephemeral.** Finch retains only a user- or
   client-selected official still/page set. Live preview frames are never a
   durable record.
3. **An extractor is an opinion.** It cannot update `documents`, financial
   projections, or matches directly.
4. **Canonical facts have field-level provenance.** Every published field must
   resolve to a selected hypothesis, a human correction, or an explicit
   constraint result.
5. **Constraints outrank confidence.** Money arithmetic, checksum rules,
   structured e-invoice validation, and jurisdiction rules decide conflicts;
   model confidence is only evidence.
6. **Artifact acceptance and extraction success are independent.** A verified
   original remains available even when OCR fails or needs human review.
7. **Workspace authority comes from Auth.** Client-provided workspace IDs are
   requested context only. The server derives authority from a Supabase user
   and active membership.
8. **Jobs are at-least-once.** Every stage is idempotent. A PGMQ retry or lease
   expiry must not create duplicate canonical data or duplicate provider calls.
9. **Originals are immutable.** Replays run newer extractors against the same
   artifact revision. They do not replace bytes or erase prior evidence.
10. **Extraction and financial reconciliation are separate.** Selecting an
    invoice total is not the same operation as matching a receipt to a bank
    transaction.

## 4. Current Runtime Constraints

The target design must respect these current facts:

| Current surface | Constraint | Consequence for ingestion |
| --- | --- | --- |
| `api` Edge Function | Receipt finalization is synchronous and marks a receipt ready before its derived document/audit writes. | Do not build extraction by adding more synchronous work to finalization. |
| `worker-run` Edge Function | Cron invokes it once a minute with a 55-second HTTP timeout; each invocation claims one PGMQ job. | Initial stages need a hard sub-45-second budget. Long OCR/VLM work belongs in a persistent worker or provider async/polling stages. |
| PGMQ plus `job_requests` | Has idempotency keys, leases, retry, delayed redelivery, and dead-lettering. | Reuse it. Do not introduce Temporal, another queue, or Realtime as a work queue without an explicit new decision. |
| `receipt-originals` | Is private but limited to JPEG/PNG/PDF at 10 MiB. | Create a separate private document-originals bucket and contracts for broader files; do not weaken the existing receipt bucket ad hoc. |
| `workspace_ai_policies` | Covers embeddings and assistant summaries only. | Vision/OCR provider authorization needs a distinct, explicit document-processing policy. |

## 5. Service Boundary

```text
Camera / web uploader / connector
    | control commands + private object upload
    v
document.ingest.v1 control plane
    | authorized workspace, artifact revision, document job
    v
Supabase Postgres + private Storage + PGMQ
    | one idempotent stage at a time
    v
ingestion worker
    | immutable bytes in, hypotheses out
    +-- structured parser / QR decoder
    +-- native PDF, DOCX, XLSX parser
    +-- OCR service
    +-- optional VLM provider
    v
field reconciler and normalizer
    v
canonical document rows -> receipt/invoice projections -> financial matching
```

### 5.1 Control plane owns

- Supabase Auth validation and workspace authorization.
- Capture session creation and official-frame/page commit.
- Signed, resumable object-upload intent issuance.
- Submission idempotency, artifact status, job status, cancellation, replay, and
  user review commands.
- Short-lived signed download URLs and read models.

The control plane never OCRs, sends raw video, puts signed URLs in queue
payloads, or lets a client choose a worker/provider.

### 5.2 Worker owns

- Magic-byte MIME validation, actual size validation, SHA-256 verification, and
  page/attachment discovery.
- One stage invocation: classify, structured extraction, native parsing, OCR,
  VLM extraction, reconciliation, or publication.
- Immutable extraction-run and field-hypothesis writes.
- Scheduling eligible next stages through PGMQ.

The worker uses a service role. It does not depend on a user JWT that may
expire while a job waits.

### 5.3 Extractor adapter owns

- Converting supplied bytes into a uniform set of field hypotheses.
- Returning its extractor name, version, timing, safe error code, and evidence.

An extractor has no Postgres credentials, no Storage listing permission, no
public route, and no ability to publish a document. It receives one artifact
or page through a private authenticated connection and returns a response.

## 6. Artifact and Document Model

### 6.1 Terminology

| Term | Meaning |
| --- | --- |
| Artifact | One immutable byte sequence, such as a JPEG page, PDF, DOCX, XLSX, XML attachment, or frozen Sheet export. |
| Document revision | The immutable, ordered artifact set processed as one document submission. A one-page receipt has one artifact; a capture burst may have several. |
| Document | The user-visible business document and current canonical view derived from a revision. |
| Hypothesis | A typed field candidate emitted by an extractor, a parser, a human, or a constraint. |
| Field selection | An immutable decision explaining why one hypothesis became the canonical field value. |
| Processing stage | One retryable unit of work delivered through PGMQ. |

### 6.2 Required state separation

Do not reuse the current receipt `upload_state` for this domain. It conflates
byte availability and business readiness. The new model separates:

| Entity | State | Meaning |
| --- | --- | --- |
| Artifact revision | `uploading`, `verified`, `rejected` | Whether Finch has a validated immutable input. |
| Document job | `queued`, `classifying`, `extracting`, `reconciling`, `needs_review`, `published`, `failed`, `cancelled` | Aggregate progress shown to users. Stages may run in parallel even though this is one display state. |
| Extraction run | `queued`, `running`, `succeeded`, `retry`, `dead`, `rejected` | Delivery and extractor outcome for one stage. |
| Canonical field | `provisional`, `selected`, `overridden` | Whether a current value is derived, resolved, or explicitly human-corrected. |

`failed` means the requested processing cannot continue after bounded retry; it
does not delete a verified original. Low confidence or unresolved arithmetic is
`needs_review`, not a processing failure.

### 6.3 Idempotency and deduplication

Every `SubmitDocument` and `CommitCapture` command requires an idempotency key.

1. Compute byte SHA-256 for a single-file submission. For a multi-page capture,
   compute a manifest SHA-256 over canonical JSON containing ordered page
   ordinal, MIME type, and each page SHA-256.
2. The first `(workspace_id, idempotency_key, manifest_sha256)` creates the
   document revision and returns its document ID.
3. Repeating the same key and manifest returns the original document ID.
4. Reusing a key with different content returns an explicit conflict. It never
   overwrites the prior submission.
5. Tenant-scoped exact-content deduplication may return an already-authorized
   document in the same workspace. It must never disclose whether another
   workspace has the same hash.

Raw SHA-256 proves byte identity. It is not a user-visible global lookup key.
The API never reveals cross-workspace hash matches.

### 6.4 Connector-backed sources

Google Sheets, email attachments, and similar connectors are not durable merely
because Finch stores a URL. A connector submission must freeze a byte snapshot
(XLSX, CSV, PDF, MIME part, or another declared export), its provider revision
identifier, and its hash before processing. Replay operates on the snapshot,
not the provider's current version.

## 7. Target Data Model

Names below are target logical tables. A migration may choose an `ingest` and
`document` schema, but it must preserve these relationships and invariants.

```text
documents
  1 -> N document_revisions
  1 -> N document_jobs
  1 -> 1 current document_header
  1 -> N document_parties / tax_lines / line_items

document_revisions
  1 -> N document_files
  1 -> N extraction_runs
  1 -> N field_hypotheses

field_hypotheses
  1 -> N field_selections (history; one current selection per field path)
```

### 7.1 Source and work records

| Table | Minimum responsibilities and columns |
| --- | --- |
| `documents` | `id`, `workspace_id`, `document_kind`, current status, primary jurisdiction/pack selection, current revision pointer, creator, timestamps. |
| `document_revisions` | `id`, `document_id`, ordinal, source kind (`capture`, `upload`, `connector`), manifest hash, verification state, declared/verified MIME summary, verified byte count, capture time, source revision metadata, timestamps. |
| `document_files` | `id`, `revision_id`, ordinal, role (`original`, `page_render`, `deskew`, `xml_sidecar`, `thumbnail`), bucket, object key, MIME, byte count, SHA-256, page count when known. Original rows are immutable. |
| `document_jobs` | Stable user-facing job per revision, aggregate state, current phase, safe error code, cancellation marker, timestamps. |
| `document_stage_runs` | `job_id`, stage kind, stage input hash, runner/extractor version, attempt summary, job-request link, timing, terminal safe error. Unique by the stage idempotency identity. |
| `extraction_runs` | `revision_id`, stage run, extractor ID/version, policy/pack version, raw-result object reference, result hash, timing, safe error. |
| `geo_evidence` | `revision_id`, evidence channel, normalized value, weight/rationale, contradiction marker, pack version. |

Raw provider responses may be retained in private object storage for audit and
calibration. They must not become canonical JSONB columns or application logs.

### 7.2 Field provenance is a first-class model

| Table | Minimum responsibilities and columns |
| --- | --- |
| `field_hypotheses` | `revision_id`, optional extraction run, canonical `field_path`, raw string, typed normalized candidate, confidence, evidence reference, completeness, rejection reason. |
| `field_selections` | `document_id`, revision, field path, selected hypothesis or human correction, selection generation, selection reason (`authority`, `agreement`, `constraint`, `human`), rule/pack version, actor when human, timestamp. |
| `constraint_evaluations` | Revision, constraint ID/version, pass/fail/residual, input hypothesis IDs, chosen outputs, rationale. |
| `review_tasks` | Document/revision, field paths needing review, reason, priority, assigned actor, resolution time. |

`evidence_reference` is a discriminated structure, not an always-present
bounding box. Valid evidence includes an OCR page bounding box, a PDF text span,
an XML XPath, a spreadsheet cell reference, a barcode payload, or a VLM quote
and page. Do not invent a bounding box a provider did not return.

Human edits create a human hypothesis followed by a new immutable field
selection. They never mutate or delete the prior extractor output.

### 7.3 Canonical financial rows

The product view stays relational and queryable:

- `document_headers`: number, issue/due date, document type/profile, currency,
  and integer-minor-unit net/tax/gross/payable totals.
- `document_parties`: issuer, buyer, ship-to, normalized tax ID/scheme, name,
  structured address, country.
- `document_tax_lines`: category, rate, base, tax amount, and jurisdiction.
- `document_line_items`: stable source ordinal, description, SKU, quantity,
  unit, integer-minor-unit amounts, tax, page/evidence reference.
- `document_fields`: sparse, selected residual fields that do not merit a
  dedicated relation.

Store money as integer minor units plus ISO 4217 currency. Do not use floating
point values. The canonical rows are projections of current field selections;
they are not a replacement for the selection history.

Only a published, validated receipt/invoice projection may later feed financial
matching. Existing `receipt_matches` is not a substitute for field-level
extraction state.

## 8. Intake Contracts

### 8.1 Control-plane operations

`document.ingest.v1` exposes these operations through the Supabase Edge REST
API.

| Command | Purpose |
| --- | --- |
| `InitiateResumableUpload` | Authorize a workspace-scoped private upload and return a signed Storage URL/object reference. |
| `SubmitDocument` | Commit an already-uploaded file or connector snapshot using an idempotency key. |
| `OpenCaptureSession` | Create a short-lived capture session with optional device/locale/consent metadata. |
| `CommitCapture` | Commit selected stills/pages as one immutable revision and create its job. |
| `GetDocument` / `ListDocuments` | Read canonical document state, never raw extractor credentials or Storage object keys. |
| `GetJob` / `WatchJob` | Read aggregate and per-stage progress plus current selected fields. |
| `GetFieldProvenance` | Return hypotheses and selection history for an authorized document field. |
| `ResolveReview` | Validate and record a human field correction/selection. |
| `ReplayJob` | Run selected stages against the same revision with explicit new extractor/rule versions. |
| `CancelJob` | Stop scheduling remaining work; it does not remove verified originals. |
| `AttachSupplement` | Add a new immutable revision or declared sidecar, never mutate an existing original. |

All commands carry a requested workspace context. The server authenticates the
Supabase JWT and verifies active membership before accessing any row, following
the existing `requireWorkspace` model.

### 8.2 Bytes never travel through the control API

- Large files use private resumable Storage upload.
- `SubmitDocument` carries an authorized object reference and idempotency key.
- `WatchJob` streams progress and selected fields, not artifact bytes.
- Internal extractor calls may send bytes over a private authenticated channel,
  but never expose a reusable signed URL or a public extractor endpoint.

## 9. Camera Capture

Camera streaming is a capture-quality feature, not an extraction transport.

### Initial behavior

- The client performs live preview and optional local gates for blur, exposure,
  skew, page bounds, and QR presence.
- The user or client selects one official still, a small burst, or ordered
  multi-page set.
- Only committed frames are uploaded and retained as originals.
- Client locale, timezone, optional consented GPS, orientation, and capture
  metrics are evidence. They are never authoritative document facts.

### Deferred behavior

Short bidi capture coaching or a server-streaming advice channel may be added
after the durable upload/review path works. It must not block capture, retain
preview video, or call OCR/VLMs on every frame. QR decoding may run locally for
fast coaching; the committed original is still decoded and verified by a worker.

## 10. Extraction and Routing

### 10.1 Classify before expensive extraction

The verifier determines actual MIME from bytes, size, page count, embedded XML,
PDF text availability, barcode/QR presence, and source type. Declared MIME is
untrusted metadata.

Eligible work is field-group based, not a fixed serial pipeline:

| Input | Required cheap work | Eligible extractors |
| --- | --- | --- |
| UBL/CII/XML | Schema/profile validation, structured parser | VLM only for missing visual annex fields. |
| PDF/A-3 or PDF with attachment | Attachment discovery, native PDF text | Structured parser, then OCR/VLM only for pages/fields still missing. |
| Digital PDF, DOCX, XLSX | Native text/table/cell parser | OCR only for embedded rasters; VLM for unresolved fields. |
| Photo or scan | QR/barcode decode and image-quality metadata | OCR and VLM; native PDF text does not apply. |
| Frozen Sheet export | Cell/table parser and source revision verification | VLM generally does not apply. |

Tier 0 structured evidence can settle a complete, schema-valid field group. It
does not prohibit a visual extractor from filling a separate missing group such
as line items. Do not invoke an expensive VLM merely because it is available.

### 10.2 Uniform extractor contract

Every adapter returns a common contract:

```text
field_path
raw_value
normalized_value
evidence_reference
local_confidence
completeness
extractor_id and extractor_version
policy/pack version
timing and safe_error_code
```

Local confidence is not globally comparable. A VLM's `0.93` and an OCR engine's
`0.93` have no shared meaning until Finch calibrates them against reviewed
documents by field and jurisdiction.

### 10.3 Provider policy

Finch will own the adapter and reconciliation, not OCR model training or CV
infrastructure by default.

- Start with one benchmark-selected extraction provider plus local
  structured/QR parsing.
- A managed VLM is valid when its data-processing agreement, data residency,
  retention, rate-limit, cost, and no-training terms satisfy the workspace
  policy. It remains an untrusted hypothesis generator.
- Self-hosted options such as [Docling Serve](https://github.com/docling-project/docling-serve)
  or [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) are alternatives,
  not mandatory parallel services. Add one only when measured accuracy, latency,
  cost, or privacy requirements justify operating it.
- Do not adopt a full document-orchestration platform such as
  [Marie-AI](https://github.com/marieai/marie-ai). Finch already owns durable
  jobs, audit, policy, and canonical financial state; duplicating those systems
  would increase failure modes without removing the core reconciliation work.

Document vision needs an explicit workspace policy distinct from the current
embedding/assistant policy. The policy records approved provider, model,
processing region, retention terms, and version. A disabled policy prevents
external vision calls but does not block structured/local parsing.

## 11. Field Reconciliation and Normalization

### 11.1 Resolution order

1. **Type and grammar gates:** reject impossible dates, invalid ISO currencies,
   checksum failures, invalid tax-ID shapes, and values outside explicit ranges.
2. **Field authority:** a schema-valid embedded e-invoice outranks extracted
   text; a verified fiscal QR outranks a visual guess; a human correction is an
   explicit override with an audit trail.
3. **Agreement:** compare normalized values, not raw strings. For example,
   `1.234,56 EUR` and `1234.56` may agree under a selected decimal rule.
4. **Constraints:** choose candidates that satisfy monetary arithmetic, tax
   rules, date ordering, identifier rules, and cross-field currency consistency.
5. **Review:** if required fields remain missing or constraints cannot be
   satisfied, create a review task. Never invent a value to reach publication.

### 11.2 Required constraints

- Sum of line net amounts, tax, discounts, allowances, and payable total with
  a declared currency-aware rounding tolerance.
- Tax amount consistency with detected tax bases/rates where a jurisdiction pack
  makes the rate matrix authoritative.
- Currency consistency across header, tax lines, and line items.
- Identifier checksum and grammar validation.
- Reasonable issue/due-date ordering. Capture time is weak evidence, not a
  replacement for a printed date.
- Structured payload profile/schema validity before it receives top authority.

Each constraint evaluation records its input hypothesis IDs and versioned rule
name. This makes `resolved_by=constraint.total` explainable and replayable.

### 11.3 Publication rule

`published` requires every document-kind-required field to have a current field
selection and all hard constraints to pass. A header may be selected while line
items are still under review, but the document remains `needs_review` until the
configured publication contract is met. No extractor or financial matcher can
relax this rule.

## 12. Jurisdiction Packs

The global core always runs first. It contains generic money/date/identifier
shape detection, QR/barcode decoding, table geometry, and ISO normalization.

Jurisdiction packs refine rather than replace it. A pack may provide:

- Identifier parsers/checksums and label lexicons.
- Decimal/date/currency priors.
- E-invoice profiles and fiscal QR parsers.
- Tax-rate matrices and mandatory-field policies.
- Review rules and versioned authority rankings.

Initial packs are `global`, `eu.en16931`, and `pt.atcud`. Pack selection uses
durable evidence in this order: intrinsic tax identifiers, structured profile,
QR/barcode standard, printed address/country, currency/tax combination,
workspace preference, consented GPS, client locale/timezone, then IP geography.
Conflicting evidence is retained. Weak geography never overrides a valid fiscal
identifier.

Pack versions are immutable, for example `pt.atcud@2026.09`. Each extraction,
constraint evaluation, and selection records the version used. Corpus-derived
calibration and vendor layout priors are deferred until human-reviewed data
exists; they must be versioned statistics, not silent model retraining.

## 13. Jobs, Retry, and Recovery

Extend the existing PGMQ/job-request taxonomy with stage kinds such as:

```text
document.verify
document.classify
document.extract.structured
document.extract.native
document.extract.ocr
document.extract.vision
document.reconcile
document.publish
```

Each queued payload contains stable IDs and non-sensitive options, for example
`document_revision_id`, stage ID, extractor version, and pack version. It does
not contain artifact bytes, signed URLs, raw document text, or provider secrets.

Stage idempotency keys follow this form:

```text
document:<revision-id>:<stage>:<input-hash>:<implementation-version>
```

Required failure behavior:

| Condition | Outcome |
| --- | --- |
| Storage/provider network failure | Retry with existing PGMQ backoff and preserve the artifact/job. |
| Provider quota or `429` | Retry only that provider stage. Do not rerun structured parsing or delete hypotheses. |
| Unsupported/corrupt bytes | Mark revision `rejected`, write a safe error, and do not retry blindly. |
| Low confidence or inconsistent totals | Persist hypotheses and create `needs_review`; this is not a failed job. |
| Worker crash before persistence | Lease expiry redelivers. The stage idempotency identity prevents duplicate durable effects. |
| Worker crash after provider call | Retry is allowed; provider requests must use a derived idempotency key where supported. Durable run/result hashes prevent duplicate selections. |
| Extractor version change | Create a new extraction run; retain old hypotheses; explicitly replay selected stages. |
| Cancellation | Stop future scheduling. Do not remove original bytes, prior results, or audit evidence. |

Use a database transaction and a current-selection generation/version check to
publish canonical rows. A Postgres advisory lock can reduce reconciler work,
but it is not the correctness mechanism because locks disappear with sessions.

## 14. Security, Privacy, and Retention

- Originals and raw extraction results are private. Object keys, signed URLs,
  source text, VLM prompts, and financial fields never enter application logs or
  job payloads.
- Browser/client roles receive only short-lived signed upload/download URLs;
  they do not get direct bucket access.
- All document rows are workspace-scoped and RLS-protected. Workers use a narrow
  service role only for work they must perform.
- Vision-provider use is opt-in at workspace level. The policy must identify the
  provider/model/region and permit raw document transfer before the worker calls
  it.
- GPS is optional, purpose-limited geo evidence. It is not a jurisdiction
  authority and needs independent retention handling.
- Retention policy is pack metadata but requires legal approval before enforcing
  jurisdiction-specific fiscal retention periods. Regenerable derivatives can
  have a shorter TTL than originals; raw provider output can be compacted only
  when its audit/calibration need is satisfied.
- Workspace deletion/export must include document originals, derivatives, raw
  extraction artifacts, hypotheses, selections, and canonical projections.

## 15. Initial Delivery Plan

### Phase 0: Lock contracts and safety boundaries

- Define canonical document/provenance schema, job kinds, and explicit document
  vision policy.
- Create the private document-originals bucket with file limits/mime allowlists
  appropriate to the first supported types.
- Define versioned request and response schemas for the Edge API operations.
- Decide the provider benchmark corpus, data-processing terms, and EU-region
  requirements before sending real documents externally.

### Phase 1: Durable paper-receipt vertical slice

- Camera-selected JPEG/PNG and direct PDF upload only.
- Artifact revision storage and asynchronous byte/MIME/hash verification.
- `document.verify` then one extraction path: local QR/structured parsing plus
  one benchmark-selected vision provider.
- Hypotheses for merchant, issue date, currency, and gross total.
- Format/arithmetic validation, manual review, and a published receipt
  projection. No automatic bank transaction match.

This phase proves the immutable artifact, retry, provenance, and review model.
It is the first release gate; do not build broad routing before it works.

### Phase 2: Native documents and field reconciliation

- Embedded XML/e-invoice profile discovery.
- Native PDF text, DOCX, XLSX, and frozen Sheet parsing.
- Parties, tax lines, and line items.
- Versioned global/EU/PT packs, constraint evaluations, and field-level review.
- Controlled fan-out to OCR/VLM only when an eligible field group is unresolved.

### Phase 3: Capture UX and scale-out

- Local capture quality coaching, QR hints, burst/multi-page commit, and
  `WatchJob` updates.
- A persistent ingestion worker when P95 stage duration exceeds 45 seconds or
  queue pressure requires it. It continues to use the same Postgres/PGMQ
  contracts.
- Provider adapters selected by measured accuracy, cost, and data residency;
  self-hosted OCR only when justified.

### Phase 4: Learning and financial automation

- Versioned calibration by `(pack, extractor, field)` from human selections.
- Vendor layout priors as versioned statistics.
- Receipt-to-transaction proposal/confirmation only after the extraction
  projection is reliable and database one-to-one invariants are enforced.

## 16. Required Validation

Before publishing the first ingestion slice, add coverage for:

- Same idempotency key plus same content returns one document; same key plus
  different content conflicts.
- A forged workspace context cannot access another workspace's document,
  artifact, job, hypothesis, raw result, or signed URL.
- Actual MIME/size/hash verification rejects mismatched uploaded bytes.
- A worker crash before and after an extractor call produces no duplicate
  canonical selection and safely redelivers work.
- Provider timeout, quota, and malformed response affect only their stage.
- No valid field selection exists without an immutable revision and evidence.
- Human correction creates an additional hypothesis/selection history rather
  than overwriting prior data.
- A hard total/tax constraint failure routes to review rather than publishing.
- Replay with a new extractor or pack version preserves original artifacts and
  prior extraction runs.
- Workspace export/deletion includes all document-domain data and Storage
  objects.

The benchmark corpus must contain representative Portuguese paper receipts,
photographed receipts, scans, and PDFs. Measure exact currency/total accuracy,
field accuracy, constraint-violation rate, review rate, time to first selected
header fields, end-to-end latency, provider cost, and data-residency compliance.
Published vendor benchmarks are not sufficient acceptance evidence.

## 17. Explicit Deferrals

The following are intentionally not part of the first vertical slice:

- Server-side live video ingestion and persistent preview-frame storage.
- Multiple OCR engines running unconditionally in parallel.
- DOCX/XLSX/Google Sheets connectors before snapshot semantics are implemented.
- Automatic receipt-to-bank-transaction matching.
- Semantic embeddings and general document search as a prerequisite for
  ingestion.
- Corpus-derived templates or automatic authority-weight changes.
- A second job system, Temporal, or a full external document orchestration
  platform.

## 18. Implementation Checklist

An implementation agent must confirm every item before marking a slice done:

1. The current cloud receipt API remains unchanged until the document path has
   explicit migration/projection behavior.
2. New document tables, object rows, jobs, and safe views have workspace RLS and
   composite workspace foreign keys where cross-table scope matters.
3. Original files and raw extraction results are private Storage objects; their
   keys are absent from client-safe views and queue payloads.
4. Every stage has a stable idempotency key and one narrow side effect.
5. Extractor adapters cannot write canonical tables or issue public URLs.
6. Canonical publishing has a transaction/version guard and cannot occur from a
   low-confidence result alone.
7. External vision use checks the dedicated document-processing policy.
8. Tests inject provider failure and worker redelivery, not only happy paths.
9. The user-visible progress model distinguishes verified original, processing,
   review required, published, and terminal failure.
10. New capabilities extend the Supabase Edge REST API and preserve the
    workspace-authorization invariants above.

## 19. Evidence and Related Documents

- Current cloud deployment/worker limit:
  [`docs/CLOUD_DEPLOYMENT.md`](../CLOUD_DEPLOYMENT.md)
- Current private receipt storage and schema:
  `supabase/schemas/finch.sql`, `supabase/config.toml`
- Current cloud receipt API and worker:
  `supabase/functions/api/index.ts`, `supabase/functions/worker-run/index.ts`
- Extractor candidates, not architectural dependencies:
  [Docling Serve](https://github.com/docling-project/docling-serve),
  [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR), and
  [Marie-AI](https://github.com/marieai/marie-ai)
