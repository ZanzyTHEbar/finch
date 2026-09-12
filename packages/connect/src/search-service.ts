import { create } from "@bufbuild/protobuf"
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect"
import { Cause, ConfigError, Effect, Exit, Layer, ManagedRuntime } from "effect"
import {
  SearchFinanceResponseSchema,
  SearchService,
  type SearchFinanceRequest,
  type SearchFinanceResponse,
} from "@finch/contracts"
import { AppConfigLive, type EmbeddingProvider, type TenantId } from "@finch/core"
import {
  SearchPort,
  SearchUnavailable,
  ValidationFailed,
  WorkspaceAccess,
  WorkspaceAccessDenied,
  WorkspaceAccessUnavailable,
  searchFinance,
  type SearchFinanceResult,
  type SearchPortInput,
  type SearchPortError,
} from "@finch/lib"
import {
  LexicalIndexLive,
  MigratedSqliteLive,
  SearchDocumentRepositoryLive,
  VectorIndexLive,
} from "@finch/db"
import { HybridSearch, HybridSearchLive, type HybridSearchResult } from "@finch/search/hybrid"
import { NoopRerankerLive } from "@finch/search/rerank"
import { requireConnectPrincipal, type ConnectPrincipalResolver } from "./principal.ts"

// Db file-backed via DATABASE_URL (AppConfigLive reads the environment).
// DbLive is referenced — never rebuilt — by every branch below: Effect
// memoizes layers by reference within a single build, so the SQLite
// connection opens exactly once no matter how many branches consume it.
export const ConnectDbLive = Layer.provide(MigratedSqliteLive, AppConfigLive)
const SearchDocumentRepositoryProvided = Layer.provide(SearchDocumentRepositoryLive, ConnectDbLive)
const VectorIndexProvided = Layer.provide(VectorIndexLive, ConnectDbLive)
const LexicalIndexProvided = Layer.provide(
  LexicalIndexLive,
  Layer.mergeAll(ConnectDbLive, SearchDocumentRepositoryProvided),
)

/** Production HybridSearch stack over the file-backed SQLite indexes. */
export const SearchLayerLive = <E>(
  embeddings: Layer.Layer<EmbeddingProvider, E>,
): Layer.Layer<HybridSearch, E | Error | ConfigError.ConfigError> =>
  Layer.provide(
    HybridSearchLive,
    Layer.mergeAll(
      AppConfigLive,
      ConnectDbLive,
      embeddings,
      SearchDocumentRepositoryProvided,
      VectorIndexProvided,
      LexicalIndexProvided,
      NoopRerankerLive,
    ),
  )

const entityForDocument = (documentId: string) => {
  const separator = documentId.indexOf(":")
  if (separator <= 0 || separator === documentId.length - 1) {
    return { entityId: documentId, entityType: "document" }
  }
  return {
    entityId: documentId.slice(separator + 1),
    entityType: documentId.slice(0, separator),
  }
}

const toSearchFinanceResult = (result: HybridSearchResult): SearchFinanceResult => ({
  hits: result.hits.map((hit) => ({
    ...entityForDocument(hit.documentId),
    // The legacy index has no display metadata; retain its stable document id as the title.
    title: hit.documentId,
    snippet: "",
    fusedScore: hit.fusedScore,
    ...(hit.denseRank === undefined ? {} : { denseRank: hit.denseRank }),
    ...(hit.lexicalRank === undefined ? {} : { lexicalRank: hit.lexicalRank }),
    ...(hit.denseSimilarity === undefined ? {} : { denseSimilarity: hit.denseSimilarity }),
    ...(hit.lexicalScore === undefined ? {} : { lexicalScore: hit.lexicalScore }),
    sources: [...hit.sources],
  })),
  diagnostics: { ...result.diagnostics },
})

const toTenantId = (workspaceId: SearchPortInput["workspaceId"]): TenantId =>
  // ponytail: SQLite search is tenant-keyed; both branded scopes are validated non-empty strings.
  workspaceId as unknown as TenantId

/** Bridges the current HybridSearch adapter to lib's transport-agnostic port. */
export const HybridSearchPortLive: Layer.Layer<SearchPort, never, HybridSearch> = Layer.effect(
  SearchPort,
  Effect.gen(function* () {
    const hybridSearch = yield* HybridSearch
    return SearchPort.of({
      search: (input): Effect.Effect<SearchFinanceResult, SearchPortError> =>
        hybridSearch
          .hybridSearch({
            tenantId: toTenantId(input.workspaceId),
            text: input.query,
            ...(input.topK === undefined ? {} : { topK: input.topK }),
            ...(input.candidateMultiplier === undefined
              ? {}
              : { candidateMultiplier: input.candidateMultiplier }),
          })
          .pipe(
            Effect.map(toSearchFinanceResult),
            Effect.mapError((error): SearchPortError =>
              error instanceof ValidationFailed ? error : new SearchUnavailable(),
            ),
          ),
    })
  }),
)

export const toConnectError = (cause: unknown): ConnectError => {
  if (cause instanceof ConnectError) {
    return cause
  }
  if (cause instanceof WorkspaceAccessDenied) {
    return new ConnectError("workspace access denied", Code.PermissionDenied)
  }
  if (cause instanceof WorkspaceAccessUnavailable) {
    return new ConnectError("workspace access unavailable", Code.Unavailable)
  }
  if (cause instanceof ValidationFailed) {
    return new ConnectError(`invalid search request: ${cause.issues.join("; ")}`, Code.InvalidArgument)
  }
  if (cause instanceof SearchUnavailable) {
    return new ConnectError("search unavailable", Code.Unavailable)
  }
  return new ConnectError("search failed", Code.Internal)
}

export interface SearchServiceDependencies<E> {
  readonly principalResolver: ConnectPrincipalResolver
  readonly layer: Layer.Layer<SearchPort | WorkspaceAccess, E>
}

export interface SearchServiceHandle {
  readonly impl: ServiceImpl<typeof SearchService>
  readonly dispose: () => Promise<void>
}

export const makeSearchService = <E>(
  dependencies: SearchServiceDependencies<E>,
  runtime: ManagedRuntime.ManagedRuntime<SearchPort | WorkspaceAccess, E> = ManagedRuntime.make(dependencies.layer),
): SearchServiceHandle => {
  const run = (request: SearchFinanceRequest, principal: NonNullable<Awaited<ReturnType<ConnectPrincipalResolver["resolve"]>>>) =>
    runtime.runPromiseExit(
      searchFinance(principal, {
        workspaceId: request.workspaceId,
        query: request.query,
        ...(request.topK > 0 ? { topK: request.topK } : {}),
        ...(request.candidateMultiplier > 0
          ? { candidateMultiplier: request.candidateMultiplier }
          : {}),
      }),
    ).then((exit) => {
      if (Exit.isSuccess(exit)) {
        return create(SearchFinanceResponseSchema, {
          hits: exit.value.hits.map((hit) => ({
            entityId: hit.entityId,
            entityType: hit.entityType,
            title: hit.title,
            snippet: hit.snippet,
            fusedScore: hit.fusedScore,
            ...(hit.denseRank === undefined ? {} : { denseRank: hit.denseRank }),
            ...(hit.lexicalRank === undefined ? {} : { lexicalRank: hit.lexicalRank }),
            ...(hit.denseSimilarity === undefined
              ? {}
              : { denseSimilarity: hit.denseSimilarity }),
            ...(hit.lexicalScore === undefined ? {} : { lexicalScore: hit.lexicalScore }),
            sources: [...hit.sources],
          })),
          diagnostics: { ...exit.value.diagnostics },
        })
      }
      throw toConnectError(Cause.squash(exit.cause))
    })

  return {
    impl: {
      searchFinance: async (request, context) => {
        const principal = await requireConnectPrincipal(dependencies.principalResolver, context)
        if (request.page !== undefined) {
          throw new ConnectError("search pagination is not supported", Code.InvalidArgument)
        }
        return run(request, principal)
      },
    },
    dispose: () => runtime.dispose(),
  }
}
