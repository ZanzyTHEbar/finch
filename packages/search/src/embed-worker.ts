import { Context, Effect, Layer, Schema } from "effect"
import {
  AppConfigTag,
  EmbeddingProvider,
  TenantId,
  ValidationFailed,
  VectorIndex,
  type AppConfig,
  type EmbeddingDimsMismatch,
  type EmbeddingError,
  type StorageUnavailable,
  type VectorIndexError,
} from "@finch/core"
import {
  DOCUMENT_EMBED_JOB_KIND,
  EmbeddingRepository,
  JobRepository,
  SearchDocumentRepository,
  type JobRow,
} from "@finch/db"
import { contentHash } from "./content-hash.ts"
import { formatDocumentId } from "./document-id.ts"
import { Distiller } from "./distill.ts"

export interface DrainStats {
  readonly processed: number
  readonly embedded: number
  readonly skipped: number
  readonly failed: number
}

export interface RequeueStats {
  readonly enqueued: number
}

const EmbedPayload = Schema.Struct({
  sourceType: Schema.String,
  sourceId: Schema.String,
})

const encodeVector = (vector: Float32Array): Uint8Array =>
  new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength))

export type EmbedWorkerError =
  | StorageUnavailable
  | ValidationFailed
  | EmbeddingError
  | EmbeddingDimsMismatch
  | VectorIndexError

export class DocumentEmbedWorker extends Context.Tag("DocumentEmbedWorker")<
  DocumentEmbedWorker,
  {
    readonly drain: (limit?: number) => Effect.Effect<DrainStats, EmbedWorkerError>
    readonly requeueMissing: (tenantId: TenantId) => Effect.Effect<RequeueStats, EmbedWorkerError>
    readonly requeueAllMissing: () => Effect.Effect<RequeueStats, EmbedWorkerError>
  }
>() {}

export const DocumentEmbedWorkerLive: Layer.Layer<
  DocumentEmbedWorker,
  never,
  | AppConfig
  | EmbeddingProvider
  | VectorIndex
  | JobRepository
  | SearchDocumentRepository
  | EmbeddingRepository
  | Distiller
> = Layer.effect(
  DocumentEmbedWorker,
  Effect.gen(function* () {
    const config = yield* AppConfigTag
    const embeddings = yield* EmbeddingProvider
    const vectors = yield* VectorIndex
    const jobs = yield* JobRepository
    const docs = yield* SearchDocumentRepository
    const stored = yield* EmbeddingRepository
    const distiller = yield* Distiller
    const model = config.voyageModel

    const processClaimed = (
      tenantId: TenantId,
      job: JobRow,
    ): Effect.Effect<"embedded" | "skipped", EmbedWorkerError> =>
      Effect.gen(function* () {
        const payload = yield* Schema.decodeUnknown(Schema.parseJson(EmbedPayload))(
          job.payload ?? "null",
        ).pipe(Effect.mapError((issue) => new ValidationFailed({ issues: [String(issue)] })))
        const row = yield* docs.findBySource(tenantId, payload.sourceType, payload.sourceId)
        if (row === null) {
          return "skipped" as const
        }
        const hash = contentHash(row.content)
        const existing = yield* stored.get(tenantId, row.id, model)
        const documentId = formatDocumentId(payload.sourceType, payload.sourceId)
        if (existing !== null && existing.contentHash === hash) {
          yield* vectors.upsert(
            tenantId,
            documentId,
            existing.model,
            existing.dims,
            new Uint8Array(existing.vector),
          )
          return "skipped" as const
        }
        const contentToEmbed = config.enableDistillation
          ? yield* distiller.distill(payload.sourceType, row.content)
          : row.content
        const [embedded] = yield* embeddings.embedDocuments([contentToEmbed])
        if (embedded === undefined) {
          return yield* new ValidationFailed({ issues: ["embedDocuments returned no vector"] })
        }
        const bytes = encodeVector(embedded.vector)
        yield* vectors.upsert(tenantId, documentId, embedded.model, embedded.dims, bytes)
        yield* stored.upsert(tenantId, row.id, embedded.model, embedded.dims, bytes, hash)
        return "embedded" as const
      })

    const drain = (limit = 100): Effect.Effect<DrainStats, EmbedWorkerError> =>
      Effect.gen(function* () {
        yield* jobs.reclaimRunning(DOCUMENT_EMBED_JOB_KIND)
        let processed = 0
        let embedded = 0
        let skipped = 0
        let failed = 0
        for (;;) {
          const due = yield* jobs.listDueAll(DOCUMENT_EMBED_JOB_KIND, limit)
          if (due.length === 0) {
            break
          }
          let claimedThisPass = 0
          for (const job of due) {
            const tenantId = yield* Schema.decodeUnknown(TenantId)(job.tenantId).pipe(
              Effect.mapError(() => new ValidationFailed({ issues: [`job ${job.id} has invalid tenantId`] })),
            )
            const claimed = yield* jobs.claim(tenantId, job.id)
            if (!claimed) {
              continue
            }
            claimedThisPass += 1
            const outcome = yield* processClaimed(tenantId, job).pipe(Effect.either)
            if (outcome._tag === "Left") {
              const lastError =
                outcome.left._tag === "ValidationFailed"
                  ? `${outcome.left._tag}: ${outcome.left.issues.join("; ")}`
                  : outcome.left._tag
              yield* jobs.finish(tenantId, job.id, { status: "failed", lastError })
              failed += 1
            } else {
              yield* jobs.finish(tenantId, job.id, { status: "succeeded" })
              if (outcome.right === "embedded") {
                embedded += 1
              } else {
                skipped += 1
              }
            }
            processed += 1
          }
          if (claimedThisPass === 0) {
            break
          }
        }
        return { processed, embedded, skipped, failed }
      })

    const requeueMissing = (tenantId: TenantId): Effect.Effect<RequeueStats, EmbedWorkerError> =>
      Effect.gen(function* () {
        const rows = yield* docs.listAll(tenantId)
        let enqueued = 0
        for (const row of rows) {
          const hash = contentHash(row.content)
          const existing = yield* stored.get(tenantId, row.id, model)
          if (existing !== null && existing.contentHash === hash) {
            continue
          }
          yield* jobs.enqueue(tenantId, DOCUMENT_EMBED_JOB_KIND, {
            sourceType: row.sourceType,
            sourceId: row.sourceId,
          })
          enqueued += 1
        }
        return { enqueued }
      })

    const requeueAllMissing = (): Effect.Effect<RequeueStats, EmbedWorkerError> =>
      Effect.gen(function* () {
        const tenantIds = yield* docs.listDistinctTenantIds()
        let enqueued = 0
        for (const tenantId of tenantIds) {
          const stats = yield* requeueMissing(tenantId)
          enqueued += stats.enqueued
        }
        return { enqueued }
      })

    return { drain, requeueMissing, requeueAllMissing }
  }),
)
