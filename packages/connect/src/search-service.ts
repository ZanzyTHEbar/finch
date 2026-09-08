import { create } from "@bufbuild/protobuf"
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect"
import { Cause, ConfigError, Effect, Exit, Layer, ManagedRuntime, Schema } from "effect"
import { AppConfigLive, EmbeddingProvider, StorageUnavailable, TenantId } from "@finch/core"
import {
  LexicalIndexLive,
  MigratedSqliteLive,
  SearchDocumentRepositoryLive,
  VectorIndexLive,
} from "@finch/db"
import { HybridSearch, HybridSearchLive } from "@finch/search/hybrid"
import {
  SearchResponseSchema,
  SearchService,
  type SearchRequest,
  type SearchResponse,
} from "./gen/finch/search/v1/search_pb.ts"

// Db file-backed via DATABASE_URL (AppConfigLive reads the environment).
// DbLive is referenced — never rebuilt — by every branch below: Effect
// memoizes layers by reference within a single build, so the SQLite
// connection opens exactly once no matter how many branches consume it.
const DbLive = Layer.provide(MigratedSqliteLive, AppConfigLive)
const SearchDocumentRepositoryProvided = Layer.provide(SearchDocumentRepositoryLive, DbLive)
const VectorIndexProvided = Layer.provide(VectorIndexLive, DbLive)
const LexicalIndexProvided = Layer.provide(
  LexicalIndexLive,
  Layer.mergeAll(DbLive, SearchDocumentRepositoryProvided),
)

/**
 * Production HybridSearch stack: HybridSearchLive over the live vec0 + FTS
 * indexes on the file-backed Db from DATABASE_URL.
 *
 * The EmbeddingProvider is a constructor param so serving and tests pick
 * their own implementation:
 * - serve with Voyage: `Layer.provide(VoyageEmbeddingProviderLive, AppConfigLive)`
 * - tests: `Layer.succeed(EmbeddingProvider, <canned double>)`
 */
export const SearchLayerLive = <E>(
  embeddings: Layer.Layer<EmbeddingProvider, E>,
): Layer.Layer<HybridSearch, E | ConfigError.ConfigError | StorageUnavailable> =>
  Layer.provide(
    HybridSearchLive,
    Layer.mergeAll(
      DbLive,
      embeddings,
      SearchDocumentRepositoryProvided,
      VectorIndexProvided,
      LexicalIndexProvided,
    ),
  )

const toConnectError = (cause: unknown): ConnectError => {
  if (cause instanceof ConnectError) {
    return cause
  }
  if (typeof cause === "object" && cause !== null && "_tag" in cause) {
    const tag = (cause as { readonly _tag: string })._tag
    if (tag === "ValidationFailed") {
      const issues =
        "issues" in cause && Array.isArray((cause as { issues: unknown }).issues)
          ? (cause as { issues: readonly unknown[] }).issues.join("; ")
          : "invalid request"
      return new ConnectError(`invalid search request: ${issues}`, Code.InvalidArgument)
    }
    if (tag === "StorageUnavailable") {
      return new ConnectError("search storage unavailable", Code.Unavailable)
    }
    if (tag === "EmbeddingError" || tag === "EmbeddingDimsMismatch") {
      return new ConnectError("embedding provider failed", Code.Unavailable)
    }
  }
  return new ConnectError("search failed", Code.Internal)
}

const searchEffect = (request: SearchRequest): Effect.Effect<SearchResponse, ConnectError, HybridSearch> =>
  Effect.gen(function* () {
    const tenantId = yield* Schema.decodeUnknown(TenantId)(request.tenantId).pipe(
      Effect.mapError(
        () => new ConnectError("invalid tenant_id: must be a non-empty string", Code.InvalidArgument),
      ),
    )
    const search = yield* HybridSearch
    const result = yield* search.hybridSearch({
      tenantId,
      text: request.text,
      // Proto scalars default to 0, which means "server default" here.
      ...(request.topK > 0 ? { topK: request.topK } : {}),
      ...(request.candidateMultiplier > 0
        ? { candidateMultiplier: request.candidateMultiplier }
        : {}),
    })
    return create(SearchResponseSchema, {
      hits: result.hits.map((hit) => ({
        documentId: hit.documentId,
        fusedScore: hit.fusedScore,
        denseRank: hit.denseRank,
        lexicalRank: hit.lexicalRank,
        denseSimilarity: hit.denseSimilarity,
        lexicalScore: hit.lexicalScore,
        sources: [...hit.sources],
      })),
      diagnostics: { ...result.diagnostics },
    })
  }).pipe(Effect.mapError(toConnectError))

export interface SearchServiceHandle {
  readonly impl: ServiceImpl<typeof SearchService>
  readonly dispose: () => Promise<void>
}

/** Bind the Search RPC to a HybridSearch stack. Stack build failures
 * (e.g. bad DATABASE_URL) surface as rejected RPCs via toConnectError. */
export const makeSearchService = <E>(
  hybridLayer: Layer.Layer<HybridSearch, E>,
): SearchServiceHandle => {
  const runtime = ManagedRuntime.make(hybridLayer)
  return {
    impl: {
      search: (request) =>
        runtime.runPromiseExit(searchEffect(request)).then((exit) => {
          if (Exit.isSuccess(exit)) {
            return exit.value
          }
          throw toConnectError(Cause.squash(exit.cause))
        }),
    },
    dispose: () => runtime.dispose(),
  }
}


