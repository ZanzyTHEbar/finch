export interface EvalResult {
  readonly queryId: string
  readonly rankedIds: readonly string[]
}

export interface EvalExpectation {
  readonly queryId: string
  readonly expectedIds: readonly string[]
}

export interface PerQueryScore {
  readonly queryId: string
  readonly recallAt1: number
  readonly recallAt3: number
  readonly recallAt10: number
  readonly mrr: number
}

export interface MacroScores {
  readonly recallAt1: number
  readonly recallAt3: number
  readonly recallAt10: number
  readonly mrr: number
}

export interface EvalSummary {
  readonly perQuery: readonly PerQueryScore[]
  readonly macro: MacroScores
}

// Fraction of expectedIds found in the first k rankedIds.
// Returns 0 when k <= 0 or there is nothing expected (fails closed so a
// missing expectation can never inflate the macro average).
export const recallAtK = (
  rankedIds: readonly string[],
  expectedIds: readonly string[],
  k: number,
): number => {
  const limit = Math.floor(k)
  if (!Number.isFinite(limit) || limit <= 0) return 0
  if (expectedIds.length === 0) return 0
  const top = new Set(rankedIds.slice(0, limit))
  let hits = 0
  for (const id of new Set(expectedIds)) {
    if (top.has(id)) hits += 1
  }
  return hits / new Set(expectedIds).size
}

// Reciprocal rank of the first expectedId found in rankedIds, 0 on a miss.
export const mrr = (rankedIds: readonly string[], expectedIds: readonly string[]): number => {
  if (expectedIds.length === 0) return 0
  const expected = new Set(expectedIds)
  for (let i = 0; i < rankedIds.length; i++) {
    if (expected.has(rankedIds[i]!)) return 1 / (i + 1)
  }
  return 0
}

const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length

// Joins results to expectations by queryId. A query with no result scores 0.
export const evaluateRun = (
  results: readonly EvalResult[],
  expectations: readonly EvalExpectation[],
): EvalSummary => {
  const rankedByQuery = new Map(results.map((r) => [r.queryId, r.rankedIds] as const))
  const perQuery: PerQueryScore[] = expectations.map((exp) => {
    const rankedIds = rankedByQuery.get(exp.queryId) ?? []
    return {
      queryId: exp.queryId,
      recallAt1: recallAtK(rankedIds, exp.expectedIds, 1),
      recallAt3: recallAtK(rankedIds, exp.expectedIds, 3),
      recallAt10: recallAtK(rankedIds, exp.expectedIds, 10),
      mrr: mrr(rankedIds, exp.expectedIds),
    }
  })
  return {
    perQuery,
    macro: {
      recallAt1: mean(perQuery.map((p) => p.recallAt1)),
      recallAt3: mean(perQuery.map((p) => p.recallAt3)),
      recallAt10: mean(perQuery.map((p) => p.recallAt10)),
      mrr: mean(perQuery.map((p) => p.mrr)),
    },
  }
}
