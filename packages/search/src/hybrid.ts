import { Context, Effect, Layer } from "effect"
import {
  EmbeddingProvider,
  LexicalIndex,
  ValidationFailed,
  VectorIndex,
  type AppConfig,
  type EmbeddingDimsMismatch,
  type EmbeddingError,
  type LexicalIndexError,
  type StorageUnavailable,
  type TenantId,
  type VectorIndexError,
} from "@finch/core"
import { reciprocalRankFusion } from "./fusion.ts"
import { parseDocumentId } from "./document-id.ts"
import { SearchDocumentRepository } from "@finch/db"
import { Reranker } from "./rerank.ts"
import { AppConfigTag } from "@finch/core"

export { formatDocumentId, parseDocumentId, type ParsedDocumentId } from "./document-id.ts"

export interface HybridSearchInput {
  readonly tenantId: TenantId
  readonly text: string
  readonly topK?: number
  readonly candidateMultiplier?: number
}

export type HybridSearchSource = "dense" | "lexical"

export interface SearchHit {
  readonly documentId: string
  readonly fusedScore: number
  readonly denseRank?: number
  readonly lexicalRank?: number
  readonly denseSimilarity?: number
  readonly lexicalScore?: number
  readonly sources: readonly HybridSearchSource[]
}

export interface SearchDiagnostics {
  readonly denseCandidates: number
  readonly lexicalCandidates: number
  readonly fusedCandidates: number
}

export interface HybridSearchResult {
  readonly hits: readonly SearchHit[]
  readonly diagnostics: SearchDiagnostics
}

export type HybridSearchError =
  | EmbeddingError
  | EmbeddingDimsMismatch
  | VectorIndexError
  | LexicalIndexError
  | StorageUnavailable
  | ValidationFailed

const DEFAULT_TOP_K = 10
const DEFAULT_CANDIDATE_MULTIPLIER = 5

// VectorIndex scores are L2 distances (smaller = nearer); report similarity as 1/(1+d).
const toSimilarity = (distance: number): number => 1 / (1 + distance)

// Copy onto a fresh buffer: the provider may hand back a pooled or unaligned view.
const encodeQuery = (vector: Float32Array): Uint8Array =>
  new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength))

export class HybridSearch extends Context.Tag("HybridSearch")<
  HybridSearch,
  {
    readonly hybridSearch: (
      input: HybridSearchInput,
    ) => Effect.Effect<HybridSearchResult, HybridSearchError>
  }
>() {}

export const HybridSearchLive: Layer.Layer<
  HybridSearch,
  never,
  EmbeddingProvider | VectorIndex | LexicalIndex | SearchDocumentRepository | AppConfig | Reranker
> = Layer.effect(
  HybridSearch,
  Effect.gen(function* () {
    const embeddings = yield* EmbeddingProvider
    const vectors = yield* VectorIndex
    const lexical = yield* LexicalIndex
    const docs = yield* SearchDocumentRepository
    const config = yield* AppConfigTag
    const reranker = yield* Reranker

    const hybridSearch = (
      input: HybridSearchInput,
    ): Effect.Effect<HybridSearchResult, HybridSearchError> =>
      Effect.gen(function* () {
        const text = input.text.trim()
        if (text.length === 0) {
          return yield* new ValidationFailed({ issues: ["search text must not be empty"] })
        }
        const topK = input.topK ?? DEFAULT_TOP_K
        if (!Number.isInteger(topK) || topK <= 0) {
          return yield* new ValidationFailed({
            issues: [`topK must be a positive integer, got ${String(input.topK)}`],
          })
        }
        const multiplier = input.candidateMultiplier ?? DEFAULT_CANDIDATE_MULTIPLIER
        if (!Number.isInteger(multiplier) || multiplier <= 0) {
          return yield* new ValidationFailed({
            issues: [
              `candidateMultiplier must be a positive integer, got ${String(input.candidateMultiplier)}`,
            ],
          })
        }
        const perSource = topK * multiplier

        const query = yield* embeddings.embedQuery(text)
        const [denseHits, lexicalHits] = yield* Effect.all(
          [
            vectors.search(input.tenantId, encodeQuery(query.vector), query.dims, perSource),
            lexical.search(input.tenantId, text, perSource),
          ],
          { concurrency: 2 },
        )

        // RRF consumes ranks only: dense ascending distance, lexical in returned order.
        const denseById = new Map<string, { rank: number; similarity: number }>()
        const denseList = [...denseHits]
          .sort((a, b) => a.score - b.score)
          .map((hit, index) => {
            if (!denseById.has(hit.documentId)) {
              denseById.set(hit.documentId, { rank: index + 1, similarity: toSimilarity(hit.score) })
            }
            return { id: hit.documentId }
          })
        const lexicalById = new Map<string, { rank: number; score: number }>()
        const lexicalList = lexicalHits.map((hit, index) => {
          if (!lexicalById.has(hit.documentId)) {
            lexicalById.set(hit.documentId, { rank: index + 1, score: hit.rank })
          }
          return { id: hit.documentId }
        })

        const fused = reciprocalRankFusion([denseList, lexicalList]).slice(0, topK)

        // The indexes key rows by "<sourceType>:<sourceId>" while the ledger
        // stores the parts in columns: resolve each fused id with a bounded
        // point lookup. Missing or malformed ids are skipped, never an error.
        const hits: SearchHit[] = []
        for (const doc of fused) {
          const parsed = parseDocumentId(doc.id)
          if (parsed === null) {
            continue
          }
          const row = yield* docs.findBySource(input.tenantId, parsed.sourceType, parsed.sourceId)
          if (row === null) {
            continue
          }
          const dense = denseById.get(doc.id)
          const lex = lexicalById.get(doc.id)
          const sources: HybridSearchSource[] = []
          if (dense !== undefined) {
            sources.push("dense")
          }
          if (lex !== undefined) {
            sources.push("lexical")
          }
          hits.push({
            documentId: doc.id,
            fusedScore: doc.score,
            denseRank: dense?.rank,
            lexicalRank: lex?.rank,
            denseSimilarity: dense?.similarity,
            lexicalScore: lex?.score,
            sources,
          })
        }

        const reranked = config.enableReranker
          ? yield* reranker.rerank(input.text, hits, (docId) =>
              Effect.gen(function* () {
                const parsed = parseDocumentId(docId)
                if (parsed === null) return docId
                const row = yield* docs.findBySource(input.tenantId, parsed.sourceType, parsed.sourceId).pipe(Effect.catchAll(() => Effect.succeed(null)))
                return row?.content ?? docId
              }),
            )
          : hits

        return {
          hits: reranked,
          diagnostics: {
            denseCandidates: denseHits.length,
            lexicalCandidates: lexicalHits.length,
            fusedCandidates: fused.length,
          },
        }
      })

    return { hybridSearch }
  }),
)
