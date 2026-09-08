import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { Database } from "bun:sqlite"
import { Code, ConnectError, createClient, type ServiceImpl } from "@connectrpc/connect"
import { connectNodeAdapter, createConnectTransport } from "@connectrpc/connect-node"
import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { AppConfigTag } from "../../packages/core/src/config/config.ts"
import { TenantId } from "../../packages/core/src/domain/tenant.ts"
import type { TenantId as TenantIdT } from "../../packages/core/src/domain/tenant.ts"
import { nowInstant } from "../../packages/core/src/domain/time.ts"
import { EmbeddingProvider } from "../../packages/core/src/ports/embedding-provider.ts"
import { VectorIndex } from "../../packages/core/src/ports/vector-index.ts"
import { DocumentEmbedWorkerLive } from "../../packages/search/src/embed-worker.ts"
import { HybridSearchLive } from "../../packages/search/src/hybrid.ts"
import { Db } from "../../packages/db/src/client.ts"
import { VectorIndexLive } from "../../packages/db/src/vector-index.ts"
import { LexicalIndexLive } from "../../packages/db/src/lexical/lexical-index.ts"
import { SearchDocumentRepository } from "../../packages/db/src/repositories/search-document.ts"
import { tenants } from "../../packages/db/src/schema/index.ts"
import { makeSearchService } from "../../packages/connect/src/search-service.ts"
import { SearchService } from "../../packages/connect/src/gen/finch/search/v1/search_pb.ts"
import { makeTestLayers, runTest } from "../setup.ts"

// SearchService over HTTP, backed by the real stack: live vec0 + FTS
// indexes on memory SQLite with a canned EmbeddingProvider (same pattern
// as tests/search/hybrid.test.ts — deterministic, no network, no keys).
const DIMS = 1024
const MODEL = "voyage-finance-2"

const TIDA = Schema.decodeUnknownSync(TenantId)("t-hybrid-a")

const basis = (i: number): Float32Array => {
  const v = new Float32Array(DIMS)
  v[i] = 1
  return v
}

const queryVector = (): Float32Array => {
  const v = new Float32Array(DIMS)
  v[0] = 0.9
  v[1] = 0.1
  return v
}

const encode = (v: Float32Array): Uint8Array => new Uint8Array(v.buffer)

const cannedEmbeddings = Layer.succeed(
  EmbeddingProvider,
  EmbeddingProvider.of({
    embedDocuments: (texts) =>
      Effect.succeed(texts.map(() => ({ model: MODEL, dims: DIMS, vector: queryVector() }))),
    embedQuery: () => Effect.succeed({ model: MODEL, dims: DIMS, vector: queryVector() }),
  }),
)

const testConfig = Layer.succeed(AppConfigTag, {
  databaseUrl: "file::memory:",
  sqliteVecPath: "",
  voyageApiKey: "",
  voyageModel: MODEL,
})

const rpcLayer = (sqlite: Database) => {
  const base = makeTestLayers(sqlite)
  const indexes = Layer.mergeAll(
    Layer.provide(VectorIndexLive, base),
    Layer.provide(LexicalIndexLive, base),
  )
  const hybrid = Layer.provide(HybridSearchLive, Layer.mergeAll(base, indexes, cannedEmbeddings))
  const worker = Layer.provide(
    DocumentEmbedWorkerLive,
    Layer.mergeAll(base, indexes, cannedEmbeddings, testConfig),
  )
  return { base, indexes, layer: Layer.mergeAll(hybrid, worker) }
}

const seedCorpus = (tid: TenantIdT) =>
  Effect.gen(function* () {
    const { db } = yield* Db
    yield* Effect.sync(() =>
      db.insert(tenants).values({ id: tid, name: tid, createdAt: nowInstant() }).run(),
    )
    const docs = yield* SearchDocumentRepository
    const vectors = yield* VectorIndex
    yield* docs.upsert(
      tid,
      "transaction",
      "tx-groceries",
      "Continente groceries debit EUR 42.80 weekly shop",
    )
    yield* vectors.upsert(tid, "transaction:tx-groceries", MODEL, DIMS, encode(basis(0)))
    yield* docs.upsert(tid, "transaction", "tx-fuel", "BP fuel station diesel receipt")
    yield* vectors.upsert(tid, "transaction:tx-fuel", MODEL, DIMS, encode(basis(1)))
    yield* docs.upsert(tid, "receipt", "rc-market", "Alvalade market Lisboa fresh produce")
    yield* vectors.upsert(tid, "receipt:rc-market", MODEL, DIMS, encode(basis(2)))
  })

const serve = (
  impl: ServiceImpl<typeof SearchService>,
): Promise<{ baseUrl: string; close: () => Promise<void> }> =>
  new Promise((resolve, reject) => {
    const server: Server = createServer(
      connectNodeAdapter({ routes: (router) => router.service(SearchService, impl) }),
    )
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise<void>((closeResolve, closeReject) =>
            server.close((error) => (error ? closeReject(error) : closeResolve())),
          ),
      })
    })
  })

describe("SearchService RPC", () => {
  it("returns the golden doc over a client/server round-trip", async () => {
    const sqlite = new Database(":memory:")
    try {
      const { base, indexes, layer } = rpcLayer(sqlite)
      await runTest(Layer.mergeAll(base, indexes), seedCorpus(TIDA))
      const { impl, dispose } = makeSearchService(layer)
      try {
        const { baseUrl, close } = await serve(impl)
        try {
          const client = createClient(SearchService, createConnectTransport({ baseUrl, httpVersion: "1.1" }))
          const response = await client.search({
            tenantId: "t-hybrid-a",
            text: "Continente groceries",
            topK: 5,
          })
          const top = response.hits[0]
          expect(top?.documentId).toBe("transaction:tx-groceries")
          // RRF over rank 1 in both lists with k=60: 1/61 + 1/61.
          expect(top?.fusedScore).toBeCloseTo(2 / 61, 12)
          expect(top?.sources).toStrictEqual(["dense", "lexical"])
          expect(top?.denseRank).toBe(1)
          expect(top?.lexicalRank).toBe(1)
          // L2 distance ||q - e0|| = 0.1*sqrt(2); similarity is 1/(1+d).
          expect(top?.denseSimilarity).toBeCloseTo(1 / (1 + 0.1 * Math.SQRT2), 6)
          expect(top?.lexicalScore).toBeLessThan(0)
          // Dense-only doc keeps its dense provenance and no lexical rank.
          const fuel = response.hits.find((h) => h.documentId === "transaction:tx-fuel")
          expect(fuel?.sources).toStrictEqual(["dense"])
          expect(fuel?.denseRank).toBe(2)
          expect(fuel?.lexicalRank).toBeUndefined()
          expect(fuel?.lexicalScore).toBeUndefined()
          expect(response.diagnostics?.denseCandidates).toBe(3)
          expect(response.diagnostics?.lexicalCandidates).toBe(1)
          expect(response.diagnostics?.fusedCandidates).toBe(3)
        } finally {
          await close()
        }
      } finally {
        await dispose()
      }
    } finally {
      sqlite.close()
    }
  })

  it("maps empty text to InvalidArgument over the wire", async () => {
    const sqlite = new Database(":memory:")
    try {
      const { layer } = rpcLayer(sqlite)
      const { impl, dispose } = makeSearchService(layer)
      try {
        const { baseUrl, close } = await serve(impl)
        try {
          const client = createClient(SearchService, createConnectTransport({ baseUrl, httpVersion: "1.1" }))
          const failure = await client
            .search({ tenantId: "t-hybrid-a", text: "   " })
            .then(
              () => null,
              (cause: unknown) => cause,
            )
          expect(failure).toBeInstanceOf(ConnectError)
          expect((failure as ConnectError).code).toBe(Code.InvalidArgument)
        } finally {
          await close()
        }
      } finally {
        await dispose()
      }
    } finally {
      sqlite.close()
    }
  })
})
