import { Context, Effect, Layer } from "effect"
import {
  AppConfigTag,
  EmbeddingProvider,
  TenantId,
  VectorIndex,
  type AppConfig,
  type EmbeddingDimsMismatch,
  type EmbeddingError,
  type StorageUnavailable,
  type VectorIndexError,
} from "@finch/core"
import {
  EmbeddingRepository,
  SearchDocumentRepository,
} from "@finch/db"
import { contentHash } from "./content-hash.ts"
import { formatDocumentId } from "./document-id.ts"

const encodeVector = (vector: Float32Array): Uint8Array =>
  new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength))

export interface BurstedItem {
  readonly documentId: string
  readonly content: string
}

export interface BurstResult {
  readonly burstItems: readonly BurstedItem[]
}

export type BurstError =
  | StorageUnavailable
  | EmbeddingError
  | EmbeddingDimsMismatch
  | VectorIndexError

export interface LineItemBurst {
  readonly burst: (
    tenantId: TenantId,
    parentSourceType: string,
    parentSourceId: string,
    items: readonly { readonly description: string; readonly amountMinor: bigint; readonly currency: string }[],
  ) => Effect.Effect<BurstResult, BurstError>
}

export const LineItemBurst = Context.GenericTag<LineItemBurst, LineItemBurst>("LineItemBurst")

const BURST_THRESHOLD_MINOR = 500n

export const LineItemBurstLive: Layer.Layer<
  LineItemBurst,
  never,
  AppConfig | EmbeddingProvider | VectorIndex | SearchDocumentRepository | EmbeddingRepository
> = Layer.effect(
  LineItemBurst,
  Effect.gen(function* () {
    const config = yield* AppConfigTag
    const embeddings = yield* EmbeddingProvider
    const vectors = yield* VectorIndex
    const docs = yield* SearchDocumentRepository
    const stored = yield* EmbeddingRepository
    const model = config.voyageModel

    return {
      burst: (tenantId, parentSourceType, parentSourceId, items) =>
        Effect.gen(function* () {
          const significant = items.filter((i) => i.amountMinor >= BURST_THRESHOLD_MINOR)
          if (significant.length === 0) {
            return { burstItems: [] }
          }
          const burstItems: BurstedItem[] = []
          const contents = significant.map(
            (i) => `${i.description} ${i.amountMinor} ${i.currency}`,
          )
          const embedded = yield* embeddings.embedDocuments(contents)
          for (let i = 0; i < significant.length; i++) {
            const item = significant[i]!
            const vec = embedded[i]
            if (vec === undefined) continue
            const docId = `${parentSourceType}:${parentSourceId}:line:${i}`
            const content = contents[i]!
            yield* docs.upsert(tenantId, "receipt", docId, content)
            const bytes = encodeVector(vec.vector)
            yield* vectors.upsert(tenantId, docId, vec.model, vec.dims, bytes)
            yield* stored.upsert(
              tenantId,
              docId,
              vec.model,
              vec.dims,
              bytes,
              contentHash(content),
            )
            burstItems.push({ documentId: docId, content })
          }
          return { burstItems }
        }),
    }
  }),
)
