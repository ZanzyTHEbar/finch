import { Database } from "bun:sqlite"
import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { AppConfigTag } from "../../packages/core/src/config/config.ts"
import { TenantId } from "../../packages/core/src/domain/tenant.ts"
import { nowInstant } from "../../packages/core/src/domain/time.ts"
import { EmbeddingProvider } from "../../packages/core/src/ports/embedding-provider.ts"
import { VectorIndex } from "../../packages/core/src/ports/vector-index.ts"
import { Db } from "../../packages/db/src/client.ts"
import { LexicalIndexLive } from "../../packages/db/src/lexical/lexical-index.ts"
import { AccountRepository } from "../../packages/db/src/repositories/account.ts"
import { ReceiptRepository } from "../../packages/db/src/repositories/receipt.ts"
import { ReconciliationRepository } from "../../packages/db/src/repositories/reconciliation.ts"
import { SearchDocumentRepository } from "../../packages/db/src/repositories/search-document.ts"
import { TransactionRepository } from "../../packages/db/src/repositories/transaction.ts"
import { tenants } from "../../packages/db/src/schema/index.ts"
import { VectorIndexLive } from "../../packages/db/src/vector-index.ts"
import { ReceiptMatcher, ReceiptMatcherLive } from "../../packages/reconciliation/src/matcher.ts"
import {
  blendScore,
  scorePair,
  shouldAutoMatch,
  shouldPropose,
} from "../../packages/reconciliation/src/score.ts"
import { formatDocumentId } from "../../packages/search/src/document-id.ts"
import { HybridSearchLive } from "../../packages/search/src/hybrid.ts"
import { NoopRerankerLive } from "../../packages/search/src/rerank.ts"
import { makeTestLayers, runTest } from "../setup.ts"

const DIMS = 1024
const MODEL = "voyage-finance-2"

const queryVector = (): Float32Array => {
  const v = new Float32Array(DIMS)
  v[0] = 0.9
  v[1] = 0.1
  return v
}

const encode = (v: Float32Array): Uint8Array => new Uint8Array(v.buffer)

const matcherLayers = (sqlite: Database) => {
  const base = makeTestLayers(sqlite)
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
    enableDistillation: false,
    enableReranker: false,
    enableSummaries: false,
    enableEmbeddings: false,
  })
  const indexes = Layer.mergeAll(
    Layer.provide(VectorIndexLive, base),
    Layer.provide(LexicalIndexLive, base),
  )
  const hybrid = Layer.provide(HybridSearchLive, Layer.mergeAll(base, indexes, cannedEmbeddings, NoopRerankerLive, testConfig))
  const matcher = Layer.provide(ReceiptMatcherLive, Layer.mergeAll(base, hybrid))
  return Layer.mergeAll(base, indexes, cannedEmbeddings, testConfig, hybrid, matcher)
}

const TID = Schema.decodeUnknownSync(TenantId)("t-match-a")

describe("receipt matcher score", () => {
  it("requires amount match and auto-links amount+currency+date", () => {
    expect(
      scorePair({
        receiptTotalMinor: 100n,
        receiptCurrency: "EUR",
        receiptDate: "2026-09-01",
        receiptMerchant: null,
        transactionAmountMinor: -99n,
        transactionCurrency: "EUR",
        transactionPostedDate: "2026-09-01",
        transactionDescription: null,
        transactionMerchantName: null,
        transactionCounterpartyName: null,
      }),
    ).toBe(0)

    const auto = scorePair({
      receiptTotalMinor: 4280n,
      receiptCurrency: "EUR",
      receiptDate: "2026-09-01",
      receiptMerchant: "Continente",
      transactionAmountMinor: -4280n,
      transactionCurrency: "EUR",
      transactionPostedDate: "2026-09-01",
      transactionDescription: "Continente groceries",
      transactionMerchantName: null,
      transactionCounterpartyName: null,
    })
    expect(shouldAutoMatch(auto)).toBe(true)

    const propose = scorePair({
      receiptTotalMinor: 1500n,
      receiptCurrency: "EUR",
      receiptDate: null,
      receiptMerchant: null,
      transactionAmountMinor: 1500n,
      transactionCurrency: "EUR",
      transactionPostedDate: null,
      transactionDescription: null,
      transactionMerchantName: null,
      transactionCounterpartyName: null,
    })
    expect(shouldPropose(propose)).toBe(true)
    expect(shouldAutoMatch(propose)).toBe(false)
    expect(shouldAutoMatch(blendScore(propose, 1))).toBe(true)
  })
})

describe("receipt matcher", () => {
  it("auto-links exact amount+date and proposes amount-only", async () => {
    const sqlite = new Database(":memory:")
    try {
      await runTest(
        matcherLayers(sqlite),
        Effect.gen(function* () {
          const { db } = yield* Db
          yield* Effect.sync(() =>
            db.insert(tenants).values({ id: TID, name: TID, createdAt: nowInstant() }).run(),
          )
          const accounts = yield* AccountRepository
          yield* accounts.upsertFromDiscovery(TID, {
            id: "acct-1",
            name: "Checking",
            type: "checking",
            currency: "EUR",
            status: "active",
          })
          const txs = yield* TransactionRepository
          yield* txs.insert(TID, {
            id: "tx-auto",
            accountId: "acct-1",
            amountMinor: -4280n,
            currency: "EUR",
            status: "booked",
            postedDate: "2026-09-01",
            observedAt: nowInstant(),
            description: "Continente groceries",
          })
          yield* txs.insert(TID, {
            id: "tx-propose",
            accountId: "acct-1",
            amountMinor: 1500n,
            currency: "EUR",
            status: "booked",
            postedDate: null,
            observedAt: nowInstant(),
            description: "Misc",
          })
          const receipts = yield* ReceiptRepository
          yield* receipts.insert(TID, {
            id: "rc-auto",
            merchant: "Continente",
            receiptDate: "2026-09-01",
            currency: "EUR",
            totalMinor: 4280n,
            imageRef: "img-auto",
            imageHash: "h-auto",
            status: "captured",
          })
          yield* receipts.insert(TID, {
            id: "rc-propose",
            merchant: null,
            receiptDate: null,
            currency: "EUR",
            totalMinor: 1500n,
            imageRef: "img-propose",
            imageHash: "h-propose",
            status: "captured",
          })
          const matcher = yield* ReceiptMatcher
          const stats = yield* matcher.match(TID)
          expect(stats).toEqual({ proposed: 1, matched: 1, skipped: 0 })
          const linked = yield* receipts.findById(TID, "rc-auto")
          expect(linked.transactionId).toBe("tx-auto")
          const unmatched = yield* receipts.listUnmatched(TID)
          expect(unmatched.map((row) => row.id)).toEqual(["rc-propose"])
          const recons = yield* ReconciliationRepository
          const proposed = yield* recons.listByStatus(TID, "proposed")
          expect(proposed).toHaveLength(1)
          expect(proposed[0]?.transactionId).toBe("tx-propose")
          yield* matcher.confirm(TID, "tx-propose", "rc-propose", "test")
          const confirmed = yield* receipts.findById(TID, "rc-propose")
          expect(confirmed.transactionId).toBe("tx-propose")
        }),
      )
    } finally {
      sqlite.close()
    }
  })

  it("auto-links amount-only pairs when embeddings agree", async () => {
    const sqlite = new Database(":memory:")
    try {
      await runTest(
        matcherLayers(sqlite),
        Effect.gen(function* () {
          const { db } = yield* Db
          yield* Effect.sync(() =>
            db.insert(tenants).values({ id: TID, name: TID, createdAt: nowInstant() }).run(),
          )
          const accounts = yield* AccountRepository
          yield* accounts.upsertFromDiscovery(TID, {
            id: "acct-1",
            name: "Checking",
            type: "checking",
            currency: "EUR",
            status: "active",
          })
          const txs = yield* TransactionRepository
          yield* txs.insert(TID, {
            id: "tx-embed",
            accountId: "acct-1",
            amountMinor: -2100n,
            currency: "EUR",
            status: "booked",
            postedDate: null,
            observedAt: nowInstant(),
            description: "Weekly shop",
          })
          const receipts = yield* ReceiptRepository
          yield* receipts.insert(TID, {
            id: "rc-embed",
            merchant: null,
            receiptDate: null,
            currency: "EUR",
            totalMinor: 2100n,
            imageRef: "img-embed",
            imageHash: "h-embed",
            status: "captured",
          })
          const docs = yield* SearchDocumentRepository
          yield* docs.upsert(TID, "transaction", "tx-embed", "Weekly shop debit EUR 21.00")
          const vectors = yield* VectorIndex
          yield* vectors.upsert(TID, formatDocumentId("transaction", "tx-embed"), MODEL, DIMS, encode(queryVector()))
          const matcher = yield* ReceiptMatcher
          const stats = yield* matcher.match(TID)
          expect(stats).toEqual({ proposed: 0, matched: 1, skipped: 0 })
          const linked = yield* receipts.findById(TID, "rc-embed")
          expect(linked.transactionId).toBe("tx-embed")
        }),
      )
    } finally {
      sqlite.close()
    }
  })
})
