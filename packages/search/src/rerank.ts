import { Context, Effect, Layer } from "effect"
import { type AppConfig, LlmProvider, AppConfigTag } from "@finch/core"
import type { SearchHit } from "./hybrid.ts"

const RERANK_SYSTEM = `You are a financial search relevance scorer. Given a search query and a candidate document, score how relevant the document is to the query on a scale of 0-10. Output ONLY the numeric score, no explanation.`

const buildRerankPrompt = (query: string, document: string): string =>
  `Query: "${query}"\n\nCandidate: "${document}"\n\nRelevance score (0-10):`

export interface Reranker {
  readonly rerank: (
    query: string,
    hits: readonly SearchHit[],
    getDocument: (documentId: string) => Effect.Effect<string, never>,
  ) => Effect.Effect<readonly SearchHit[], never>
}

export const Reranker = Context.GenericTag<Reranker, Reranker>("Reranker")

const MAX_CANDIDATES = 20

export const RerankerLive: Layer.Layer<Reranker, never, LlmProvider | AppConfig> = Layer.effect(
  Reranker,
  Effect.gen(function* () {
    const llm = yield* LlmProvider
    const config = yield* AppConfigTag
    const model = config.openCodeLlmModel

    return {
      rerank: (query, hits, getDocument) =>
        Effect.gen(function* () {
          const candidates = hits.slice(0, MAX_CANDIDATES)
          const scored = yield* Effect.forEach(candidates, (hit) =>
            Effect.gen(function* () {
              const doc = yield* getDocument(hit.documentId)
              const result = yield* llm.chat(model, [
                { role: "system", content: RERANK_SYSTEM },
                { role: "user", content: buildRerankPrompt(query, doc) },
              ], { maxTokens: 16, temperature: 0.0 })
              const score = parseFloat(result.trim())
              const llmScore = Number.isFinite(score) ? Math.max(0, Math.min(10, score)) / 10 : 0.5
              return { ...hit, fusedScore: hit.fusedScore * 0.3 + llmScore * 0.7 }
            }).pipe(Effect.catchAll(() => Effect.succeed(hit))),
          )
          const remaining = hits.slice(MAX_CANDIDATES)
          return [...scored, ...remaining].sort((a, b) => b.fusedScore - a.fusedScore)
        }),
    }
  }),
)

export const NoopRerankerLive: Layer.Layer<Reranker> = Layer.succeed(Reranker, {
  rerank: (_query, hits, _getDocument) => Effect.succeed(hits),
})
