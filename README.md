# Finch

> [!IMPORTANT]
> Finch is early-alpha and is based off of an enterprise system I built for a personal client. Finch is an attempt to open source, with permission, the core functionality and runtime so that others may benefit from it.

Finch is a Supabase-native personal-finance intelligence service based off of the original work of Cerebrases for their knowledg-base, but applied to financial data.

It receives bank data through a banking adapter, Enable Banking is the default, and document ingestion. Then builds an intelligent knowledge base around the data by a combination of deterministic and stochastic data extraction and organisation.

Finches sole purpose is to ingest data and provide evidence artifacts relative to search query inputs. Think of finch as a bespoke FINancial searCH engine that adapts overtime to your data.

Finch provides an adapter system to connect any sort of frontend. 

- cli
- RPC
- MCP
- REST
- etc

The inner library can compose any interface you wish. Finch ships built on-top of Supabase, but the model (and first prototype) can be built on sqlite as well.

## Runtime

The finch runtime is designed to be drop-in permission-aware financial RAG over **where work already happens**.

Answers: *Where is X? Who owns Y? What is Z?* with citations.

Three jobs:

1. Collect / store internal data  
2. Query it  
3. AuthZ + audit + analytics  

## Design bet

Do not fight tools. Extract from existing financial data tools. Connectors are small: *what the data is, how to connect, how often to refresh*.

## How it works

```
sources ──ingest──► distill/normalize ──embed──► Postgres + pgvector
                                                      │
query ── hybrid retrieve ── fuse/rerank ── LLM ──► answer + sources
```

### Store

Finch uses one Postgres table containing an LLM-generated data artifact summary distilled doc, embedding of select chunks + linked summary, metadata, source, timestamps  
- pgvector, **3072-d** embeddings, HNSW  
- Same row shape for every source → same query API.

Data is ingested, key information is extracted out into a normalized structure and stored.

### Ingest

- Financial Tool Adapter: on event, refetch fresh data, store as one row  
- LLM **distills** data artifact→ one-line question, summary, resolution, entities and identity refs  
- Embed the distillate and optional chunks, not the raw dump  
- GitHub / wiki / custom DBs, and other sources where data lives via the same schema; teams add connectors as needed

### Retrieve

Fuse:

| Signal | Why |
|---|---|
| Full-text / BM25 | Exact tokens |
| Embeddings | Paraphrase |
| IDF | Rare terms over filler |
| Age decay | Newer wins when tied |

Rerank. Cite sources. RBAC inherited from IdP and integrated with Supabase Auth and RLS.

## Summary

- Meet data where it lives  
- Distill noisy information before embedding  
- Hybrid ranking, not cosine-only  
- Freshness + permissions as first-class  
- Boring stack
- Supabase Auth and Postgres RLS establish user and workspace access.
- Postgres stores tenant-scoped financial data, immutable domain/audit events, export/deletion state, and PGMQ jobs.
- Vault holds provider credentials and per-connection bank sessions.
- Private Storage holds receipt originals and generated export parts.
- Edge Functions provide the API, bank callback, and stateless worker.

The client supplies `x-finch-workspace` only as a requested context. The API verifies active membership from the authenticated Supabase user before every workspace action.

## MCP

`@finch/mcp`  is an agent-only interface using Streamable HTTP MCP exposing `exec` and `docs`; it is a typescript isolate sandboxed process that allows an agent to compose the `@finch/lib` typescript library. This allows dynamic programtic composition of finch. 

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
| `api` | Authenticated workspace, bank, receipt, search, export, deletion, and AI API. |
| `bank-callback` | Handles opaque Enable Banking authorization state and stores the provider session in Vault. |
| `worker-run` | Claims PGMQ jobs for sync, embeddings, exports, cleanup, deletion, payment polling, and summaries. |
| `mcp` | Authenticated remote MCP JSON-RPC transport. |

All functions validate user tokens themselves, so deploy them with `--no-verify-jwt`. The bank callback and worker have their own narrow authentication mechanisms.

## Security model

- Browser/client roles have no direct Storage object access; uploads and downloads use short-lived signed URLs.
- Raw bank-provider references, Vault IDs, receipt object keys, payment redirect state, and queued payloads are not client-readable.
- User reads are RLS-scoped. Safe views expose only intended fields where raw rows contain server-only values.
- Export and workspace deletion require an `aal2` Supabase Auth token.
- AI work is opt-in per workspace. Prompts contain a fixed aggregate only; credentials and full source records are not sent to the model.
- Jobs have idempotency keys, worker leases, bounded retries, delayed redelivery, and a PGMQ dead-letter archive.

## Deployment

See [docs/CLOUD_DEPLOYMENT.md](docs/CLOUD_DEPLOYMENT.md) for the fresh-project bootstrap, Vault/Edge secret configuration, Edge deployment, scheduled worker, and production validation procedure.
