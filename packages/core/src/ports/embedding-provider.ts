import { Context, Data, Effect } from "effect"

export interface EmbeddedVector {
  readonly model: string
  readonly dims: number
  readonly vector: Float32Array
}

export class EmbeddingError extends Data.TaggedError("EmbeddingError")<{
  readonly message: string
  readonly status?: number
  readonly cause?: unknown
}> {}

export class EmbeddingDimsMismatch extends Data.TaggedError("EmbeddingDimsMismatch")<{
  readonly model: string
  readonly expectedDims: number
  readonly actualDims: number
}> {}

export class EmbeddingProvider extends Context.Tag("EmbeddingProvider")<
  EmbeddingProvider,
  {
    embedDocuments(
      texts: readonly string[],
    ): Effect.Effect<readonly EmbeddedVector[], EmbeddingError | EmbeddingDimsMismatch>
    embedQuery(text: string): Effect.Effect<EmbeddedVector, EmbeddingError | EmbeddingDimsMismatch>
  }
>() {}
