import { Context, Data, Effect, Schema } from "effect"
import { ValidationFailed, WorkspaceId, type WorkspaceId as WorkspaceIdT } from "@finch/core/domain"
import { type PrincipalContext, WorkspaceAccess } from "./foundation.ts"

export type SearchSource = "dense" | "lexical"

export interface SearchFinanceHit {
  readonly entityId: string
  readonly entityType: string
  readonly title: string
  readonly snippet: string
  readonly fusedScore: number
  readonly denseRank?: number
  readonly lexicalRank?: number
  readonly denseSimilarity?: number
  readonly lexicalScore?: number
  readonly sources: readonly SearchSource[]
}

export interface SearchDiagnostics {
  readonly denseCandidates: number
  readonly lexicalCandidates: number
  readonly fusedCandidates: number
}

export interface SearchFinanceResult {
  readonly hits: readonly SearchFinanceHit[]
  readonly diagnostics: SearchDiagnostics
}

export interface SearchPortInput {
  readonly workspaceId: WorkspaceIdT
  readonly query: string
  readonly topK?: number
  readonly candidateMultiplier?: number
}

export class SearchUnavailable extends Data.TaggedError("SearchUnavailable")<Record<never, never>> {}

export type SearchPortError = ValidationFailed | SearchUnavailable

export class SearchPort extends Context.Tag("SearchPort")<
  SearchPort,
  {
    readonly search: (input: SearchPortInput) => Effect.Effect<SearchFinanceResult, SearchPortError>
  }
>() {}

export interface SearchFinanceInput {
  readonly workspaceId: unknown
  readonly query: string
  readonly topK?: number
  readonly candidateMultiplier?: number
}

const DEFAULT_TOP_K = 10
const MAX_TOP_K = 100
const DEFAULT_CANDIDATE_MULTIPLIER = 5
const MAX_CANDIDATE_MULTIPLIER = 10
const MAX_CANDIDATES = 1000

const decodeWorkspaceId = (scope: unknown) =>
  Schema.decodeUnknown(WorkspaceId)(scope).pipe(
    Effect.mapError(
      () => new ValidationFailed({ issues: ["workspace_id must be a UUID"] }),
    ),
  )

const decodeSearchLimits = (input: SearchFinanceInput) => {
  const topK = input.topK === undefined ? DEFAULT_TOP_K : input.topK
  if (!Number.isInteger(topK) || topK <= 0 || topK > MAX_TOP_K) {
    return Effect.fail(
      new ValidationFailed({ issues: [`topK must be a positive integer no greater than ${MAX_TOP_K}, got ${String(input.topK)}`] }),
    )
  }
  const candidateMultiplier = input.candidateMultiplier === undefined
    ? DEFAULT_CANDIDATE_MULTIPLIER
    : input.candidateMultiplier
  if (
    !Number.isInteger(candidateMultiplier) ||
    candidateMultiplier <= 0 ||
    candidateMultiplier > MAX_CANDIDATE_MULTIPLIER
  ) {
    return Effect.fail(
      new ValidationFailed({
        issues: [
          `candidateMultiplier must be a positive integer no greater than ${MAX_CANDIDATE_MULTIPLIER}, got ${String(input.candidateMultiplier)}`,
        ],
      }),
    )
  }
  if (topK * candidateMultiplier > MAX_CANDIDATES) {
    return Effect.fail(
      new ValidationFailed({
        issues: [`topK * candidateMultiplier must not exceed ${MAX_CANDIDATES}, got ${topK * candidateMultiplier}`],
      }),
    )
  }
  return Effect.succeed({ topK, candidateMultiplier })
}

export const searchFinance = (principal: PrincipalContext, input: SearchFinanceInput) =>
  Effect.gen(function* () {
    const limits = yield* decodeSearchLimits(input)
    const workspaceId = yield* decodeWorkspaceId(input.workspaceId)
    const access = yield* WorkspaceAccess
    const authorized = yield* access.authorize(principal, workspaceId)
    const search = yield* SearchPort
    return yield* search.search({
      workspaceId: authorized.workspaceId,
      query: input.query,
      ...limits,
    })
  })
