import { Database } from "bun:sqlite"
import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { TenantId } from "../../packages/core/src/domain/tenant.ts"
import type { TenantId as TenantIdT } from "../../packages/core/src/domain/tenant.ts"
import { nowInstant } from "../../packages/core/src/domain/time.ts"
import { EmbeddingProvider } from "../../packages/core/src/ports/embedding-provider.ts"
import { VectorIndex } from "../../packages/core/src/ports/vector-index.ts"
import { Db } from "../../packages/db/src/client.ts"
import { LexicalIndexLive } from "../../packages/db/src/lexical/lexical-index.ts"
import { AccountRepository } from "../../packages/db/src/repositories/account.ts"
import { ReceiptRepository } from "../../packages/db/src/repositories/receipt.ts"
import { SearchDocumentRepository } from "../../packages/db/src/repositories/search-document.ts"
import { TransactionRepository } from "../../packages/db/src/repositories/transaction.ts"
import { tenants } from "../../packages/db/src/schema/index.ts"
import { VectorIndexLive } from "../../packages/db/src/vector-index.ts"
import { HybridSearchLive } from "../../packages/search/src/hybrid.ts"
import { connectInProcess } from "../../packages/mcp/src/testing.ts"
import { makeTestLayers, runTest } from "../setup.ts"

// In-process MCP tool calls (real Client + Server over a linked transport)
// against the memory stack with canned embeddings: no network, no API keys.
const DIMS = 1024
const MODEL = "voyage-finance-2"

const TID = Schema.decodeUnknownSync(TenantId)("t-mcp-a")

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

const makeLayers = (sqlite: Database) => {
  const base = makeTestLayers(sqlite)
  const cannedEmbeddings = Layer.succeed(
    EmbeddingProvider,
    EmbeddingProvider.of({
      embedDocuments: (texts) =>
        Effect.succeed(texts.map(() => ({ model: MODEL, dims: DIMS, vector: queryVector() }))),
      embedQuery: () => Effect.succeed({ model: MODEL, dims: DIMS, vector: queryVector() }),
    }),
  )
  const indexes = Layer.mergeAll(
    Layer.provide(VectorIndexLive, base),
    Layer.provide(LexicalIndexLive, base),
  )
  const hybrid = Layer.provide(HybridSearchLive, Layer.mergeAll(base, indexes, cannedEmbeddings))
  return Layer.mergeAll(base, indexes, cannedEmbeddings, hybrid)
}

const seedLedger = (tid: TenantIdT) =>
  Effect.gen(function* () {
    const { db } = yield* Db
    yield* Effect.sync(() =>
      db.insert(tenants).values({ id: tid, name: tid, createdAt: nowInstant() }).run(),
    )
    const accounts = yield* AccountRepository
    yield* accounts.upsertFromDiscovery(tid, {
      id: "acct-mcp",
      name: "Checking",
      type: "checking",
      currency: "EUR",
      status: "active",
    })
    const txs = yield* TransactionRepository
    yield* txs.insert(tid, {
      id: "tx-mcp-1",
      accountId: "acct-mcp",
      amountMinor: 4280n,
      currency: "EUR",
      status: "booked",
      postedDate: "2026-09-01",
      observedAt: nowInstant(),
      description: "Continente groceries",
    })
    const receipts = yield* ReceiptRepository
    yield* receipts.insert(tid, {
      id: "rc-unmatched-1",
      merchant: "Continente",
      receiptDate: "2026-09-01",
      currency: "EUR",
      totalMinor: 4280n,
      imageRef: "img-unmatched-1",
      imageHash: "h-unmatched-1",
      status: "captured",
    })
    yield* receipts.insert(tid, {
      id: "rc-matched-1",
      merchant: "BP",
      receiptDate: "2026-09-02",
      currency: "EUR",
      totalMinor: 6000n,
      imageRef: "img-matched-1",
      imageHash: "h-matched-1",
      status: "captured",
    })
    yield* receipts.linkTransaction(tid, "rc-matched-1", "tx-mcp-1")
    // Golden search doc: dense rank 1 (nearest basis vector) + lexical
    // rank 1 (only FTS match), so RRF puts it top-1 through the tool.
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
  })

const withStack = async <A>(run: (layer: ReturnType<typeof makeLayers>) => Promise<A>): Promise<A> => {
  const sqlite = new Database(":memory:")
  try {
    const layer = makeLayers(sqlite)
    await runTest(layer, seedLedger(TID))
    return await run(layer)
  } finally {
    sqlite.close()
  }
}

describe("finch MCP server", () => {
  it("lists the four ledger tools", async () => {
    await withStack(async (layer) => {
      const mcp = await connectInProcess(layer)
      try {
        const tools = await mcp.listTools()
        expect(tools.tools.map((t) => t.name).sort()).toStrictEqual([
          "get_receipt",
          "get_transaction",
          "list_unmatched_receipts",
          "search_finances",
        ])
      } finally {
        await mcp.close()
      }
    })
  })

  it("search_finances returns the golden doc top-1 with ranks and sources", async () => {
    await withStack(async (layer) => {
      const mcp = await connectInProcess(layer)
      try {
        const call = await mcp.callTool("search_finances", {
          tenantId: "t-mcp-a",
          text: "Continente groceries",
          topK: 5,
        })
        expect(call.isError).not.toBe(true)
        const body = JSON.parse(call.text) as {
          hits: Array<{
            documentId: string
            fusedScore: number
            sources: string[]
            denseRank?: number
            lexicalRank?: number
          }>
        }
        expect(body.hits[0]?.documentId).toBe("transaction:tx-groceries")
        expect(body.hits[0]?.sources).toStrictEqual(["dense", "lexical"])
        expect(typeof body.hits[0]?.fusedScore).toBe("number")
        expect(body.hits[0]?.denseRank).toBe(1)
        expect(body.hits[0]?.lexicalRank).toBe(1)
      } finally {
        await mcp.close()
      }
    })
  })

  it("get_transaction returns the row; unknown id is a typed 404", async () => {
    await withStack(async (layer) => {
      const mcp = await connectInProcess(layer)
      try {
        const hit = await mcp.callTool("get_transaction", { tenantId: "t-mcp-a", id: "tx-mcp-1" })
        expect(hit.isError).not.toBe(true)
        const row = JSON.parse(hit.text) as { id: string; amountMinor: string; currency: string }
        expect(row.id).toBe("tx-mcp-1")
        expect(row.amountMinor).toBe("4280")
        expect(row.currency).toBe("EUR")

        const miss = await mcp.callTool("get_transaction", { tenantId: "t-mcp-a", id: "tx-nope" })
        expect(miss.isError).toBe(true)
        const failure = JSON.parse(miss.text) as Record<string, unknown>
        expect(failure["error"]).toBe("TransactionNotFound")
        expect(failure["transactionId"]).toBe("tx-nope")
      } finally {
        await mcp.close()
      }
    })
  })

  it("get_receipt returns the row; unknown id is a typed 404", async () => {
    await withStack(async (layer) => {
      const mcp = await connectInProcess(layer)
      try {
        const hit = await mcp.callTool("get_receipt", { tenantId: "t-mcp-a", id: "rc-matched-1" })
        expect(hit.isError).not.toBe(true)
        const row = JSON.parse(hit.text) as {
          id: string
          transactionId: string | null
          totalMinor: string
        }
        expect(row.id).toBe("rc-matched-1")
        expect(row.transactionId).toBe("tx-mcp-1")
        expect(row.totalMinor).toBe("6000")

        const miss = await mcp.callTool("get_receipt", { tenantId: "t-mcp-a", id: "rc-nope" })
        expect(miss.isError).toBe(true)
        expect((JSON.parse(miss.text) as Record<string, unknown>)["error"]).toBe("ReceiptNotFound")
      } finally {
        await mcp.close()
      }
    })
  })

  it("list_unmatched_receipts returns only unlinked receipts and honors limit", async () => {
    await withStack(async (layer) => {
      const mcp = await connectInProcess(layer)
      try {
        const all = await mcp.callTool("list_unmatched_receipts", { tenantId: "t-mcp-a" })
        expect(all.isError).not.toBe(true)
        const rows = JSON.parse(all.text) as Array<{ id: string }>
        expect(rows.map((r) => r.id)).toStrictEqual(["rc-unmatched-1"])

        const limited = await mcp.callTool("list_unmatched_receipts", {
          tenantId: "t-mcp-a",
          limit: 1,
        })
        expect(limited.isError).not.toBe(true)
        expect((JSON.parse(limited.text) as unknown[]).length).toBe(1)
      } finally {
        await mcp.close()
      }
    })
  })

  it("rejects bad input and unknown tools with typed ValidationFailed", async () => {
    await withStack(async (layer) => {
      const mcp = await connectInProcess(layer)
      try {
        const empty = await mcp.callTool("search_finances", { tenantId: "t-mcp-a", text: "   " })
        expect(empty.isError).toBe(true)
        expect((JSON.parse(empty.text) as Record<string, unknown>)["error"]).toBe("ValidationFailed")

        const missing = await mcp.callTool("get_transaction", { id: "tx-mcp-1" })
        expect(missing.isError).toBe(true)
        expect((JSON.parse(missing.text) as Record<string, unknown>)["error"]).toBe("ValidationFailed")

        const unknown = await mcp.callTool("drop_ledger", { tenantId: "t-mcp-a" })
        expect(unknown.isError).toBe(true)
        expect((JSON.parse(unknown.text) as Record<string, unknown>)["error"]).toBe("ValidationFailed")
      } finally {
        await mcp.close()
      }
    })
  })
})
