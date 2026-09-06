import { Data } from "effect"

export interface RankedDocument {
  readonly id: string
  readonly score?: number
}

export interface FusionOptions {
  readonly k?: number
  readonly weights?: readonly number[]
  readonly topK?: number
}

export interface FusionContribution {
  readonly listIndex: number
  readonly rank: number
}

export interface FusedDocument {
  readonly id: string
  readonly score: number
  readonly contributions: readonly FusionContribution[]
}

export class FusionInvalidInput extends Data.TaggedError("FusionInvalidInput")<{
  readonly reason: string
}> {}

// Cormack et al. 2009: score(d) = Σ weight_i / (k + rank_i), ranks 1-based.
// A document missing from a list contributes nothing from that list.
export const reciprocalRankFusion = (
  lists: readonly (readonly RankedDocument[])[],
  opts: FusionOptions = {},
): FusedDocument[] => {
  const k = opts.k ?? 60
  if (!Number.isFinite(k) || k <= 0) {
    throw new FusionInvalidInput({ reason: `k must be a positive number, got ${String(k)}` })
  }
  if (opts.weights !== undefined && opts.weights.length !== lists.length) {
    throw new FusionInvalidInput({
      reason: `weights length (${opts.weights.length}) must match lists length (${lists.length})`,
    })
  }
  if (opts.weights?.some((w) => !Number.isFinite(w))) {
    throw new FusionInvalidInput({ reason: "weights must all be finite numbers" })
  }
  if (opts.topK !== undefined && (!Number.isInteger(opts.topK) || opts.topK <= 0)) {
    throw new FusionInvalidInput({ reason: `topK must be a positive integer, got ${String(opts.topK)}` })
  }

  const fused = new Map<string, { score: number; contributions: FusionContribution[] }>()
  lists.forEach((list, listIndex) => {
    const weight = opts.weights?.[listIndex] ?? 1
    const seen = new Set<string>()
    list.forEach((doc, index) => {
      if (seen.has(doc.id)) return
      seen.add(doc.id)
      const rank = index + 1
      const entry = fused.get(doc.id) ?? { score: 0, contributions: [] }
      entry.score += weight / (k + rank)
      entry.contributions.push({ listIndex, rank })
      fused.set(doc.id, entry)
    })
  })

  const ranked: FusedDocument[] = [...fused].map(([id, entry]) => ({
    id,
    score: entry.score,
    contributions: entry.contributions,
  }))
  ranked.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return ranked.slice(0, opts.topK ?? ranked.length)
}
