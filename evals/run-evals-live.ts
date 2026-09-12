import { Database } from "bun:sqlite"
import { Effect, Layer, Schema } from "effect"
import { AppConfigTag, loadVoyageApiKey } from "../packages/core/src/config/config.ts"
import { TenantId } from "../packages/core/src/domain/tenant.ts"
import type { TenantId as TenantIdT } from "../packages/core/src/domain/tenant.ts"
import { nowInstant } from "../packages/core/src/domain/time.ts"
import { EmbeddingProvider } from "../packages/core/src/ports/embedding-provider.ts"
import { VectorIndex } from "../packages/core/src/ports/vector-index.ts"
import { Db } from "../packages/db/src/client.ts"
import { LexicalIndexLive } from "../packages/db/src/lexical/lexical-index.ts"
import { SearchDocumentRepository } from "../packages/db/src/repositories/search-document.ts"
import { tenants } from "../packages/db/src/schema/index.ts"
import { VectorIndexLive } from "../packages/db/src/vector-index.ts"
import { parseDocumentId } from "../packages/search/src/document-id.ts"
import { evaluateRun } from "../packages/search/src/eval-metrics.ts"
import { HybridSearch, HybridSearchLive } from "../packages/search/src/hybrid.ts"
import { NoopRerankerLive } from "../packages/search/src/rerank.ts"
import { makeVoyageEmbeddingService } from "../packages/search/src/voyage-embeddings.ts"
import { makeTestLayers, runTest } from "../tests/setup.ts"
import { EVAL_CORPUS, EVAL_DIMS, EVAL_MODEL, EVAL_TENANT } from "./corpus.ts"

const TOP_K = 10
// Voyage unpaid accounts are capped at 3 RPM. Pace every live embed.
const VOYAGE_MIN_INTERVAL_MS = 21_000

interface EvalCase {
  readonly id: string
  readonly query: string
  readonly expectedDocumentIds: readonly string[]
  readonly type: string
}

const encode = (v: Float32Array): Uint8Array =>
  new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength))

const splitDocumentId = (documentId: string): { sourceType: string; sourceId: string } => {
  const parsed = parseDocumentId(documentId)
  if (parsed === null) {
    throw new Error(`fixture documentId is malformed: ${JSON.stringify(documentId)}`)
  }
  return parsed
}

const loadCases = async (): Promise<EvalCase[]> => {
  const text = await Bun.file(new URL("./queries.jsonl", import.meta.url)).text()
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as EvalCase)
}

const requireApiKey = async (): Promise<string> => {
  const key = await loadVoyageApiKey()
  if (key === "") {
    console.error("VOYAGE_API_KEY missing from keyring (service=finch name=VOYAGE_API_KEY)")
    process.exit(1)
  }
  return key
}

const runSmoke = async (apiKey: string): Promise<void> => {
  const service = makeVoyageEmbeddingService({ apiKey, model: EVAL_MODEL })
  const docs = await Effect.runPromise(service.embedDocuments(["Continente groceries debit EUR 42.80"]))
  const query = await Effect.runPromise(service.embedQuery("espresso morning brew"))
  const docDims = docs[0]?.dims
  console.log(`dims=${query.dims}`)
  if (query.dims !== EVAL_DIMS || docDims !== EVAL_DIMS) {
    console.error(`FAIL: expected dims=${EVAL_DIMS}, got query=${query.dims} doc=${String(docDims)}`)
    process.exit(1)
  }
}

const pacedVoyage = (apiKey: string) => {
  const inner = makeVoyageEmbeddingService({ apiKey, model: EVAL_MODEL })
  let lastAt = 0
  const pace = Effect.promise(async () => {
    const wait = lastAt === 0 ? 0 : VOYAGE_MIN_INTERVAL_MS - (Date.now() - lastAt)
    if (wait > 0) {
      await Bun.sleep(wait)
    }
    lastAt = Date.now()
  })
  return EmbeddingProvider.of({
    embedDocuments: (texts) => pace.pipe(Effect.flatMap(() => inner.embedDocuments(texts))),
    embedQuery: (text) => pace.pipe(Effect.flatMap(() => inner.embedQuery(text))),
  })
}

const runGolden = async (apiKey: string): Promise<void> => {
  const cases = await loadCases()
  const sqlite = new Database(":memory:")
  try {
    const base = makeTestLayers(sqlite)
    const embeddings = Layer.succeed(EmbeddingProvider, pacedVoyage(apiKey))
    const indexes = Layer.mergeAll(
      Layer.provide(VectorIndexLive, base),
      Layer.provide(LexicalIndexLive, base),
    )
    const testConfig = Layer.succeed(AppConfigTag, {
      databaseUrl: "file::memory:",
      sqliteVecPath: "",
      voyageApiKey: apiKey,
      voyageModel: EVAL_MODEL,
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
    const layers = Layer.mergeAll(
      base,
      indexes,
      embeddings,
      testConfig,
      Layer.provide(HybridSearchLive, Layer.mergeAll(base, indexes, embeddings, NoopRerankerLive, testConfig)),
    )
    const tenantId: TenantIdT = Schema.decodeUnknownSync(TenantId)(EVAL_TENANT)

    await runTest(
      layers,
      Effect.gen(function* () {
        const { db } = yield* Db
        yield* Effect.sync(() =>
          db.insert(tenants).values({ id: tenantId, name: tenantId, createdAt: nowInstant() }).run(),
        )
        const docs = yield* SearchDocumentRepository
        const vec = yield* VectorIndex
        const embedder = yield* EmbeddingProvider
        const embedded = yield* embedder.embedDocuments(EVAL_CORPUS.map((doc) => doc.content))
        for (let i = 0; i < EVAL_CORPUS.length; i++) {
          const doc = EVAL_CORPUS[i]
          const vector = embedded[i]
          if (doc === undefined || vector === undefined) {
            throw new Error(`corpus/embed length mismatch at ${i}`)
          }
          const { sourceType, sourceId } = splitDocumentId(doc.documentId)
          yield* docs.upsert(tenantId, sourceType, sourceId, doc.content)
          yield* vec.upsert(tenantId, doc.documentId, vector.model, vector.dims, encode(vector.vector))
        }
      }),
    )

    const results: { queryId: string; rankedIds: string[] }[] = []
    for (const c of cases) {
      const rankedIds = await runTest(
        layers,
        Effect.gen(function* () {
          const search = yield* HybridSearch
          const result = yield* search.hybridSearch({
            tenantId,
            text: c.query,
            topK: TOP_K,
          })
          return result.hits.map((hit) => hit.documentId)
        }),
      )
      results.push({ queryId: c.id, rankedIds })
    }

    const summary = evaluateRun(
      results,
      cases.map((c) => ({ queryId: c.id, expectedIds: c.expectedDocumentIds })),
    )
    const byId = new Map(summary.perQuery.map((p) => [p.queryId, p] as const))

    console.log("query\ttype\texpected-top1\tgot-top1\trecall@1\trecall@3\trecall@10\tmrr")
    for (const c of cases) {
      const score = byId.get(c.id)
      const expectedTop = c.expectedDocumentIds[0] ?? "-"
      const gotTop = results.find((r) => r.queryId === c.id)?.rankedIds[0] ?? "-"
      console.log(
        [
          c.id,
          c.type,
          expectedTop,
          gotTop,
          score?.recallAt1.toFixed(3) ?? "?",
          score?.recallAt3.toFixed(3) ?? "?",
          score?.recallAt10.toFixed(3) ?? "?",
          score?.mrr.toFixed(3) ?? "?",
        ].join("\t"),
      )
    }
    const m = summary.macro
    console.log(
      `macro\t-\t-\t-\t${m.recallAt1.toFixed(3)}\t${m.recallAt3.toFixed(3)}\t${m.recallAt10.toFixed(3)}\t${m.mrr.toFixed(3)}`,
    )
    if (m.recallAt10 < 1) {
      console.error("FAIL: live macro recall@10 below 1.0 on the separable fixture")
      process.exit(1)
    }
  } finally {
    sqlite.close()
  }
}

const main = async (): Promise<void> => {
  const smokeOnly = process.argv.includes("--smoke")
  const apiKey = await requireApiKey()
  if (smokeOnly) {
    await runSmoke(apiKey)
    return
  }
  await runGolden(apiKey)
}

await main()
