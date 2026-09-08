import { Database } from "bun:sqlite"
import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { AppConfigTag, EmbeddingProvider, TenantId, VectorIndex } from "../../packages/core/src/index.ts"
import { nowInstant } from "../../packages/core/src/domain/time.ts"
import type { TenantId as TenantIdT } from "../../packages/core/src/domain/tenant.ts"
import { Db } from "../../packages/db/src/client.ts"
import { EventStore, type AppendInput } from "../../packages/db/src/event-store.ts"
import { DOCUMENT_EMBED_JOB_KIND } from "../../packages/db/src/job-kinds.ts"
import { ProjectionRunner } from "../../packages/db/src/projections/runner.ts"
import { EmbeddingRepository } from "../../packages/db/src/repositories/embedding.ts"
import { JobRepository } from "../../packages/db/src/repositories/job.ts"
import { SearchDocumentRepository } from "../../packages/db/src/repositories/search-document.ts"
import { tenants } from "../../packages/db/src/schema/index.ts"
import { VectorIndexLive } from "../../packages/db/src/vector-index.ts"
import { contentHash } from "../../packages/search/src/content-hash.ts"
import { formatDocumentId } from "../../packages/search/src/document-id.ts"
import { DocumentEmbedWorker, DocumentEmbedWorkerLive } from "../../packages/search/src/embed-worker.ts"
import { makeTestLayers, runTest } from "../setup.ts"

const TIDA = Schema.decodeUnknownSync(TenantId)("t-embed-a")
const TIDB = Schema.decodeUnknownSync(TenantId)("t-embed-b")
const ACCT = "acct-embed"
const TX = "tx-embed-1"

const unit = new Float32Array(1024).fill(0.01)
const encode = (vector: Float32Array): Uint8Array =>
  new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength))

const seedTenant = (tid: TenantIdT) =>
  Effect.gen(function* () {
    const { db } = yield* Db
    yield* Effect.sync(() =>
      db.insert(tenants).values({ id: tid, name: tid, createdAt: nowInstant() }).run(),
    )
  })

const observed = (tid: TenantIdT, aggregateId: string, merchantName: string): AppendInput => ({
  tenantId: tid,
  aggregateType: "transaction",
  aggregateId,
  eventType: "TransactionObserved",
  payload: {
    accountId: ACCT,
    amountMinor: 4280n,
    currency: "EUR",
    bookingDate: "2026-09-01",
    rawDescription: `${merchantName} purchase`,
    merchantName,
    sourceFingerprint: `fp-${aggregateId}`,
    status: "booked",
  },
  actor: "test",
})

const discovered = (tid: TenantIdT): AppendInput => ({
  tenantId: tid,
  aggregateType: "account",
  aggregateId: ACCT,
  eventType: "AccountDiscovered",
  payload: { name: "Checking", type: "checking", currency: "EUR", status: "active" },
  actor: "test",
})

const countingEmbedder = () => {
  let calls = 0
  return {
    calls: () => calls,
    layer: Layer.succeed(EmbeddingProvider, {
      embedDocuments: (texts) => {
        calls += texts.length
        return Effect.succeed(
          texts.map(() => ({ vector: unit, model: "voyage-finance-2", dims: 1024 })),
        )
      },
      embedQuery: () => Effect.succeed({ vector: unit, model: "voyage-finance-2", dims: 1024 }),
    }),
  }
}

const workerLayers = (sqlite: Database, embedder: Layer.Layer<EmbeddingProvider>) => {
  const base = makeTestLayers(sqlite)
  const vectors = Layer.provide(VectorIndexLive, base)
  const config = Layer.succeed(AppConfigTag, {
    databaseUrl: "file::memory:",
    sqliteVecPath: "",
    voyageApiKey: "",
    voyageModel: "voyage-finance-2",
    enableBankingBaseUrl: "https://api.enablebanking.com",
    enableBankingApplicationId: "",
    enableBankingPrivateKey: "",
    enableBankingPsuIp: "203.0.113.10",
    enableBankingPsuUserAgent: "finch-test",
  })
  const worker = Layer.provide(
    DocumentEmbedWorkerLive,
    Layer.mergeAll(base, vectors, config, embedder),
  )
  return Layer.mergeAll(base, vectors, config, embedder, worker)
}

describe("document.embed worker", () => {
  it("projects a transaction, drains into vec0, and skips unchanged content", async () => {
    const sqlite = new Database(":memory:")
    const embedder = countingEmbedder()
    try {
      const result = await runTest(
        workerLayers(sqlite, embedder.layer),
        Effect.gen(function* () {
          yield* seedTenant(TIDA)
          const store = yield* EventStore
          const runner = yield* ProjectionRunner
          const jobs = yield* JobRepository
          const worker = yield* DocumentEmbedWorker
          const vectors = yield* VectorIndex
          const stored = yield* EmbeddingRepository
          const docs = yield* SearchDocumentRepository

          const account = yield* store.append(discovered(TIDA))
          yield* runner.project(account)
          const event = yield* store.append(observed(TIDA, TX, "Continente"))
          yield* runner.project(event)
          yield* runner.project(event)

          const queued = yield* jobs.listDue(TIDA, 10)
          const first = yield* worker.drain(10)
          const second = yield* worker.drain(10)
          const hits = yield* vectors.search(TIDA, encode(unit), 1024, 5)
          const doc = yield* docs.findBySource(TIDA, "transaction", TX)
          const row = doc === null ? null : yield* stored.get(TIDA, doc.id, "voyage-finance-2")
          return { queued, first, second, hits, hash: row?.contentHash ?? null, content: doc?.content ?? null }
        }),
      )
      expect(result.queued).toHaveLength(1)
      expect(result.queued[0]?.kind).toBe(DOCUMENT_EMBED_JOB_KIND)
      expect(result.first).toEqual({ processed: 1, embedded: 1, skipped: 0, failed: 0 })
      expect(result.second).toEqual({ processed: 0, embedded: 0, skipped: 0, failed: 0 })
      expect(result.hits.map((hit) => hit.documentId)).toEqual([formatDocumentId("transaction", TX)])
      expect(result.hash).toBe(result.content === null ? null : contentHash(result.content))
      expect(embedder.calls()).toBe(1)
    } finally {
      sqlite.close()
    }
  })

  it("re-embeds when search-document content changes", async () => {
    const sqlite = new Database(":memory:")
    const embedder = countingEmbedder()
    try {
      const result = await runTest(
        workerLayers(sqlite, embedder.layer),
        Effect.gen(function* () {
          yield* seedTenant(TIDA)
          const docs = yield* SearchDocumentRepository
          const jobs = yield* JobRepository
          const worker = yield* DocumentEmbedWorker
          yield* docs.upsert(TIDA, "transaction", TX, "first body")
          yield* jobs.enqueue(TIDA, DOCUMENT_EMBED_JOB_KIND, {
            sourceType: "transaction",
            sourceId: TX,
          })
          const first = yield* worker.drain(10)
          yield* docs.upsert(TIDA, "transaction", TX, "second body")
          const requeued = yield* worker.requeueMissing(TIDA)
          const second = yield* worker.drain(10)
          return { first, requeued, second }
        }),
      )
      expect(result.first.embedded).toBe(1)
      expect(result.requeued.enqueued).toBe(1)
      expect(result.second.embedded).toBe(1)
      expect(embedder.calls()).toBe(2)
    } finally {
      sqlite.close()
    }
  })

  it("skips jobs whose document is gone and drains both tenants", async () => {
    const sqlite = new Database(":memory:")
    const embedder = countingEmbedder()
    try {
      const result = await runTest(
        workerLayers(sqlite, embedder.layer),
        Effect.gen(function* () {
          yield* seedTenant(TIDA)
          yield* seedTenant(TIDB)
          const docs = yield* SearchDocumentRepository
          const jobs = yield* JobRepository
          const worker = yield* DocumentEmbedWorker
          yield* docs.upsert(TIDA, "transaction", "tx-a", "alpha")
          yield* docs.upsert(TIDB, "transaction", "tx-b", "beta")
          const tenants = yield* docs.listDistinctTenantIds()
          yield* jobs.enqueue(TIDA, DOCUMENT_EMBED_JOB_KIND, {
            sourceType: "transaction",
            sourceId: "missing",
          })
          yield* jobs.enqueue(TIDA, "other.kind", { x: 1 })
          const backfill = yield* worker.requeueAllMissing()
          const drain = yield* worker.drain(10)
          const leftover = yield* jobs.listDue(TIDA, 10)
          return { tenants, backfill, drain, leftoverKinds: leftover.map((job) => job.kind) }
        }),
      )
      expect(result.tenants.slice().sort()).toEqual([TIDA, TIDB].slice().sort())
      expect(result.backfill.enqueued).toBe(2)
      expect(result.drain).toEqual({ processed: 3, embedded: 2, skipped: 1, failed: 0 })
      expect(result.leftoverKinds).toEqual(["other.kind"])
    } finally {
      sqlite.close()
    }
  })

  it("repairs missing vec0 from a stored embedding without re-embedding", async () => {
    const sqlite = new Database(":memory:")
    const embedder = countingEmbedder()
    try {
      const result = await runTest(
        workerLayers(sqlite, embedder.layer),
        Effect.gen(function* () {
          yield* seedTenant(TIDA)
          const docs = yield* SearchDocumentRepository
          const stored = yield* EmbeddingRepository
          const jobs = yield* JobRepository
          const worker = yield* DocumentEmbedWorker
          const vectors = yield* VectorIndex
          const doc = yield* docs.upsert(TIDA, "transaction", TX, "repair body")
          yield* stored.upsert(
            TIDA,
            doc.id,
            "voyage-finance-2",
            1024,
            encode(unit),
            contentHash("repair body"),
          )
          yield* jobs.enqueue(TIDA, DOCUMENT_EMBED_JOB_KIND, {
            sourceType: "transaction",
            sourceId: TX,
          })
          const drain = yield* worker.drain(10)
          const hits = yield* vectors.search(TIDA, encode(unit), 1024, 5)
          return { drain, hits: hits.map((hit) => hit.documentId) }
        }),
      )
      expect(result.drain).toEqual({ processed: 1, embedded: 0, skipped: 1, failed: 0 })
      expect(result.hits).toEqual([formatDocumentId("transaction", TX)])
      expect(embedder.calls()).toBe(0)
    } finally {
      sqlite.close()
    }
  })

  it("reclaims a running document.embed job on drain", async () => {
    const sqlite = new Database(":memory:")
    const embedder = countingEmbedder()
    try {
      const result = await runTest(
        workerLayers(sqlite, embedder.layer),
        Effect.gen(function* () {
          yield* seedTenant(TIDA)
          const docs = yield* SearchDocumentRepository
          const jobs = yield* JobRepository
          const worker = yield* DocumentEmbedWorker
          yield* docs.upsert(TIDA, "transaction", TX, "reclaim body")
          const job = yield* jobs.enqueue(TIDA, DOCUMENT_EMBED_JOB_KIND, {
            sourceType: "transaction",
            sourceId: TX,
          })
          const claimed = yield* jobs.claim(TIDA, job.id)
          const drain = yield* worker.drain(10)
          return { claimed, drain }
        }),
      )
      expect(result.claimed).toBe(true)
      expect(result.drain).toEqual({ processed: 1, embedded: 1, skipped: 0, failed: 0 })
      expect(embedder.calls()).toBe(1)
    } finally {
      sqlite.close()
    }
  })
})
