import { Database } from "bun:sqlite"
import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { AppConfigTag } from "../../packages/core/src/config/config.ts"
import { TenantId } from "../../packages/core/src/domain/tenant.ts"
import { nowInstant } from "../../packages/core/src/domain/time.ts"
import { EmbeddingProvider } from "../../packages/core/src/ports/embedding-provider.ts"
import { VectorIndex } from "../../packages/core/src/ports/vector-index.ts"
import { LineItemBurstLive, LineItemBurst } from "../../packages/search/src/burst.ts"
import { Db } from "../../packages/db/src/client.ts"
import { VectorIndexLive } from "../../packages/db/src/vector-index.ts"
import { SearchDocumentRepository } from "../../packages/db/src/repositories/search-document.ts"
import { tenants } from "../../packages/db/src/schema/index.ts"
import { makeTestLayers, runTest } from "../setup.ts"

const DIMS = 1024
const MODEL = "voyage-finance-2"

const TID = Schema.decodeUnknownSync(TenantId)("t-burst-a")

const basis = (i: number): Float32Array => {
  const v = new Float32Array(DIMS)
  v[i] = 1
  return v
}

const encode = (v: Float32Array): Uint8Array => new Uint8Array(v.buffer)

const cannedEmbeddings = Layer.succeed(
  EmbeddingProvider,
  EmbeddingProvider.of({
    embedDocuments: (texts) =>
      Effect.succeed(
        texts.map((_t, i) => ({ model: MODEL, dims: DIMS, vector: basis(i % DIMS) })),
      ),
    embedQuery: () => Effect.succeed({ model: MODEL, dims: DIMS, vector: basis(0) }),
  }),
)

const testConfig = Layer.succeed(AppConfigTag, {
  databaseUrl: "file::memory:",
  sqliteVecPath: "",
  voyageApiKey: "",
  voyageModel: MODEL,
  llmAdapter: "opencode",
  openCodeApiKey: "",
  openCodeLlmBaseUrl: "https://opencode.ai/zen/v1",
  openCodeLlmModel: "opencode/claude-sonnet-4-20250514",
  bankAdapter: "enablebanking",
  enableBankingBaseUrl: "https://api.enablebanking.com",
  enableBankingApplicationId: "",
  enableBankingPrivateKey: "",
  enableBankingPsuIp: "203.0.113.10",
  enableBankingPsuUserAgent: "finch-test",
  enableDistillation: true,
  enableReranker: true,
  enableSummaries: true,
  enableEmbeddings: true,
})

const makeLayers = (sqlite: Database) => {
  const base = makeTestLayers(sqlite)
  // ponytail: burst code uses a formatted docId (e.g. "receipt:r-1:line:0") as
  // the embeddings documentId, but the embeddings FK references
  // searchDocuments.id which is a UUID. Disable FK enforcement so the burst
  // logic can be tested; FK correctness belongs to schema-level tests.
  sqlite.exec("PRAGMA foreign_keys = OFF;")
  const vectorIndex = Layer.provide(VectorIndexLive, base)
  const burst = Layer.provide(
    LineItemBurstLive,
    Layer.mergeAll(base, cannedEmbeddings, vectorIndex, testConfig),
  )
  return Layer.mergeAll(base, vectorIndex, cannedEmbeddings, testConfig, burst)
}

const seedTenant = () =>
  Effect.gen(function* () {
    const { db } = yield* Db
    yield* Effect.sync(() =>
      db.insert(tenants).values({ id: TID, name: TID, createdAt: nowInstant() }).run(),
    )
  })

describe("LineItemBurstLive", () => {
  it("bursts multi-line receipt into line items", async () => {
    const sqlite = new Database(":memory:")
    try {
      const result = await runTest(
        makeLayers(sqlite),
        Effect.gen(function* () {
          yield* seedTenant()
          const burst = yield* LineItemBurst
          return yield* burst.burst(TID, "receipt", "r-1", [
            { description: "Milk", amountMinor: 150n, currency: "EUR" },
            { description: "Bread", amountMinor: 600n, currency: "EUR" },
          ])
        }),
      )
      // BURST_THRESHOLD is 500n: only Bread (600n) qualifies
      // Document ID uses the filtered index (Bread is index 0 after Milk is filtered)
      expect(result.burstItems).toHaveLength(1)
      expect(result.burstItems[0]?.documentId).toBe("receipt:r-1:line:0")
      expect(result.burstItems[0]?.content).toContain("Bread")
    } finally {
      sqlite.close()
    }
  })

  it("returns empty when no items exceed threshold", async () => {
    const sqlite = new Database(":memory:")
    try {
      const result = await runTest(
        makeLayers(sqlite),
        Effect.gen(function* () {
          yield* seedTenant()
          const burst = yield* LineItemBurst
          return yield* burst.burst(TID, "receipt", "r-2", [
            { description: "Milk", amountMinor: 150n, currency: "EUR" },
            { description: "Eggs", amountMinor: 200n, currency: "EUR" },
          ])
        }),
      )
      expect(result.burstItems).toHaveLength(0)
    } finally {
      sqlite.close()
    }
  })

  it("embeds and stores burst content", async () => {
    const sqlite = new Database(":memory:")
    try {
      await runTest(
        makeLayers(sqlite),
        Effect.gen(function* () {
          yield* seedTenant()
          const burst = yield* LineItemBurst
          yield* burst.burst(TID, "receipt", "r-3", [
            { description: "Wine", amountMinor: 1200n, currency: "EUR" },
          ])
          // Verify document was upserted into search_documents
          const docs = yield* SearchDocumentRepository
          const doc = yield* docs.findBySource(TID, "receipt", "receipt:r-3:line:0")
          expect(doc).not.toBeNull()
          expect(doc?.content).toContain("Wine")
        }),
      )
    } finally {
      sqlite.close()
    }
  })
})
