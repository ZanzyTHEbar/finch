import { Effect, Layer } from "effect"
import { VoyageAIClient, VoyageAIError } from "voyageai"
import { AppConfigTag, type AppConfig } from "@finch/core"
import {
  EmbeddingDimsMismatch,
  EmbeddingError,
  EmbeddingProvider,
  type EmbeddedVector,
} from "@finch/core"

export const VOYAGE_FINANCE_MODEL = "voyage-finance-2"

// ponytail: single-model registry; extend when a second model lands.
const dimsByModel: Record<string, number> = {
  [VOYAGE_FINANCE_MODEL]: 1024,
}

export interface VoyageEmbeddingOptions {
  readonly apiKey: string
  readonly model?: string
  readonly baseUrl?: string
}

const toEmbeddingError = (cause: unknown): EmbeddingError => {
  if (cause instanceof VoyageAIError) {
    return new EmbeddingError({
      message: `voyage embed failed with status ${cause.statusCode ?? "unknown"}: ${cause.message}`,
      status: cause.statusCode,
      cause,
    })
  }
  return new EmbeddingError({
    message: `voyage embed request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    cause,
  })
}

export const makeVoyageEmbeddingService = (options: VoyageEmbeddingOptions) => {
  const model = options.model ?? VOYAGE_FINANCE_MODEL
  const client = new VoyageAIClient({
    apiKey: options.apiKey,
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    // Single attempt: API failures surface as typed errors, never retried.
    maxRetries: 0,
  })

  const embed = (
    inputType: "document" | "query",
    inputs: readonly string[],
  ): Effect.Effect<readonly EmbeddedVector[], EmbeddingError | EmbeddingDimsMismatch> =>
    Effect.gen(function* () {
      if (options.apiKey === "") {
        return yield* new EmbeddingError({ message: "VOYAGE_API_KEY is not set" })
      }
      const expectedDims = dimsByModel[model]
      if (expectedDims === undefined) {
        return yield* new EmbeddingError({
          message: `no dims registered for voyage model "${model}"`,
        })
      }
      const response = yield* Effect.tryPromise({
        try: () => client.embed({ input: [...inputs], model, inputType }),
        catch: (cause) => toEmbeddingError(cause),
      })
      const data = response.data
      if (data === undefined) {
        return yield* new EmbeddingError({ message: "voyage embed returned no data" })
      }
      const vectors: EmbeddedVector[] = []
      for (const item of data) {
        const embedding = item.embedding
        if (embedding === undefined) {
          return yield* new EmbeddingError({ message: "voyage embed item returned no embedding" })
        }
        // Fail loudly on dims mismatch: never silently reshape.
        if (embedding.length !== expectedDims) {
          return yield* new EmbeddingDimsMismatch({
            model,
            expectedDims,
            actualDims: embedding.length,
          })
        }
        vectors.push({ model, dims: embedding.length, vector: Float32Array.from(embedding) })
      }
      return vectors
    })

  return EmbeddingProvider.of({
    embedDocuments: (texts) => embed("document", texts),
    embedQuery: (text) =>
      embed("query", [text]).pipe(
        Effect.flatMap((vectors) => {
          const first = vectors[0]
          return first === undefined
            ? Effect.fail(new EmbeddingError({ message: "voyage embed returned no data" }))
            : Effect.succeed(first)
        }),
      ),
  })
}

export const makeVoyageEmbeddingProviderLayer = (
  options: VoyageEmbeddingOptions,
): Layer.Layer<EmbeddingProvider, never, never> =>
  Layer.succeed(EmbeddingProvider, makeVoyageEmbeddingService(options))

export const VoyageEmbeddingProviderLive: Layer.Layer<EmbeddingProvider, never, AppConfig> =
  Layer.effect(
    EmbeddingProvider,
    Effect.map(AppConfigTag, (config) =>
      makeVoyageEmbeddingService({ apiKey: config.voyageApiKey, model: config.voyageModel })),
  )
