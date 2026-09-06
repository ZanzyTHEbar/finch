import { Context, Data, Effect, Schema } from "effect"

export const VectorDocumentId = Schema.Struct({
  documentId: Schema.String,
  model: Schema.String,
})

export type VectorDocumentId = Schema.Schema.Type<typeof VectorDocumentId>

export const VectorScoredHit = Schema.Struct({
  documentId: Schema.String,
  score: Schema.Number,
})

export type VectorScoredHit = Schema.Schema.Type<typeof VectorScoredHit>

export class VectorIndexError extends Data.TaggedError("VectorIndexError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class VectorIndex extends Context.Tag("VectorIndex")<
  VectorIndex,
  {
    upsert(documentId: string, model: string, dims: number, vector: Uint8Array): Effect.Effect<void, VectorIndexError>
    removeByDocument(documentId: string): Effect.Effect<void, VectorIndexError>
    search(
      query: Uint8Array,
      dims: number,
      topK: number,
    ): Effect.Effect<readonly VectorScoredHit[], VectorIndexError>
  }
>() {}
