import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { AppConfigTag } from "../../packages/core/src/config/config.ts"
import { LlmProvider, LlmError } from "../../packages/core/src/ports/llm-provider.ts"
import { RerankerLive, Reranker } from "../../packages/search/src/rerank.ts"
import type { SearchHit } from "../../packages/search/src/hybrid.ts"

const testConfig = Layer.succeed(AppConfigTag, {
  databaseUrl: "file::memory:",
  sqliteVecPath: "",
  voyageApiKey: "",
  voyageModel: "voyage-finance-2",
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

// ponytail: parse candidate text from reranker prompt, not the query which
// is always present and would make every hit score identically.
const cannedLlm = Layer.succeed(LlmProvider, {
  chat: (_model, messages, _options) => {
    const userMsg = messages.find((m) => m.role === "user")?.content ?? ""
    const candidateMatch = userMsg.match(/Candidate:\s*"([^"]*)"/)
    const candidate = candidateMatch?.[1] ?? ""
    if (candidate.includes("grocery")) return Effect.succeed("8.5")
    return Effect.succeed("3.2")
  },
})

const failingLlm = Layer.succeed(LlmProvider, {
  chat: (_model, _messages, _options) =>
    Effect.fail(new LlmError({ message: "boom" })),
})

const makeHit = (id: string, fusedScore: number): SearchHit => ({
  documentId: id,
  fusedScore,
  sources: ["dense"],
  denseRank: 1,
  denseSimilarity: 0.5,
})

const getDocument =
  (docs: Map<string, string>) =>
  (documentId: string) =>
    Effect.succeed(docs.get(documentId) ?? documentId)

const rerankerLayer = (llm: Layer.Layer<LlmProvider, never, never>) =>
  Layer.provide(RerankerLive, Layer.mergeAll(llm, testConfig))

const runRerank = (
  llm: Layer.Layer<LlmProvider, never, never>,
  query: string,
  hits: readonly SearchHit[],
  getDocument: (id: string) => Effect.Effect<string, never>,
) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const reranker = yield* Reranker
        return yield* reranker.rerank(query, hits, getDocument)
      }),
      rerankerLayer(llm),
    ),
  )

describe("RerankerLive", () => {
  it("reranks hits with LLM scores", async () => {
    const docs = new Map([
      ["doc:a", "weekly grocery shopping"],
      ["doc:b", "fuel station diesel"],
      ["doc:c", "bank fee"],
    ])
    const hits: SearchHit[] = [
      makeHit("doc:a", 0.3),
      makeHit("doc:b", 0.5),
      makeHit("doc:c", 0.7),
    ]

    const result = await runRerank(cannedLlm, "grocery", hits, getDocument(docs))

    expect(result).toHaveLength(3)
    // doc:a has "grocery" in candidate → LLM 8.5, blended: 0.3*0.3 + 0.85*0.7 = 0.685
    const docA = result.find((h) => h.documentId === "doc:a")
    expect(docA?.fusedScore).toBeCloseTo(0.685, 10)
    // doc:b no grocery → LLM 3.2, blended: 0.5*0.3 + 0.32*0.7 = 0.374
    const docB = result.find((h) => h.documentId === "doc:b")
    expect(docB?.fusedScore).toBeCloseTo(0.374, 10)
    // doc:c no grocery → same LLM 3.2, blended: 0.7*0.3 + 0.32*0.7 = 0.434
    const docC = result.find((h) => h.documentId === "doc:c")
    expect(docC?.fusedScore).toBeCloseTo(0.434, 10)
    // doc:a should now be top (was lowest fusedScore, now highest after rerank)
    expect(result[0]?.documentId).toBe("doc:a")
  })

  it("preserves hit order when LLM fails", async () => {
    const docs = new Map([
      ["doc:a", "fuel"],
      ["doc:b", "bank fee"],
    ])
    const hits: SearchHit[] = [
      makeHit("doc:a", 0.5),
      makeHit("doc:b", 0.7),
    ]

    const result = await runRerank(failingLlm, "grocery", hits, getDocument(docs))

    // On failure, catchAll returns the original hit unchanged; then sorted by fusedScore desc.
    expect(result).toHaveLength(2)
    expect(result[0]?.fusedScore).toBe(0.7)
    expect(result[1]?.fusedScore).toBe(0.5)
  })

  it("caps candidates at MAX_CANDIDATES (20)", async () => {
    const docs = new Map<string, string>()
    const hits: SearchHit[] = Array.from({ length: 25 }, (_, i) => {
      const id = `doc:${i}`
      docs.set(id, `document ${i}`)
      return makeHit(id, 0.1 * i)
    })

    const result = await runRerank(cannedLlm, "query", hits, getDocument(docs))

    // All 25 returned but only first 20 had scores changed
    expect(result).toHaveLength(25)
    // Positions >= 20 were sliced off and kept original fusedScore
    const reranked = result.filter((h) => {
      const idx = Number(h.documentId.split(":")[1])
      return idx >= 20
    })
    for (const hit of reranked) {
      const idx = Number(hit.documentId.split(":")[1])
      expect(hit.fusedScore).toBe(0.1 * idx)
    }
  })
})
