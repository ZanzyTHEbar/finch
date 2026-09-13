import { describe, expect, it } from "vitest"
import {
  scorePair,
  blendScore,
  shouldPropose,
  shouldAutoMatch,
} from "../../packages/reconciliation/src/score.ts"

describe("scoring pipeline integration", () => {
  it("perfect match scores above auto-match", () => {
    const score = scorePair({
      receiptTotalMinor: 4280n,
      receiptCurrency: "EUR",
      receiptDate: "2026-09-01",
      receiptMerchant: "Continente",
      transactionAmountMinor: -4280n,
      transactionCurrency: "EUR",
      transactionPostedDate: "2026-09-02",
      transactionDescription: "Continente groceries",
      transactionMerchantName: null,
      transactionCounterpartyName: null,
    })
    // 0.6 (base) + 0.1 (currency) + 0.2 (date within 3d) + 0.1 (merchant) = 1.0
    expect(score).toBeGreaterThanOrEqual(0.8)
    expect(shouldAutoMatch(score)).toBe(true)
  })

  it("partial match scores above propose threshold", () => {
    const score = scorePair({
      receiptTotalMinor: 2100n,
      receiptCurrency: "EUR",
      receiptDate: "2026-09-01",
      receiptMerchant: null,
      transactionAmountMinor: -2100n,
      transactionCurrency: "EUR",
      transactionPostedDate: "2026-09-11",
      transactionDescription: "Weekly shop",
      transactionMerchantName: null,
      transactionCounterpartyName: null,
    })
    // 0.6 (base) + 0.1 (currency) = 0.7; date diff 10d > 3d → no bonus; no merchant
    expect(score).toBeGreaterThanOrEqual(0.6)
    expect(score).toBeLessThan(0.8)
    expect(shouldPropose(score)).toBe(true)
    expect(shouldAutoMatch(score)).toBe(false)
  })

  it("amount mismatch always scores 0", () => {
    const score = scorePair({
      receiptTotalMinor: 4280n,
      receiptCurrency: "EUR",
      receiptDate: "2026-09-01",
      receiptMerchant: "Continente",
      transactionAmountMinor: -1000n,
      transactionCurrency: "EUR",
      transactionPostedDate: "2026-09-01",
      transactionDescription: "Continente",
      transactionMerchantName: null,
      transactionCounterpartyName: null,
    })
    expect(score).toBe(0)
  })

  it("embedding boost improves score", () => {
    const base = 0.7
    const highSimilarity = 0.95
    const noSimilarity = 0.0
    const boosted = blendScore(base, highSimilarity)
    const unboosted = blendScore(base, noSimilarity)
    expect(boosted).toBeGreaterThan(unboosted)
    expect(boosted).toBeCloseTo(0.8425, 10)
    expect(unboosted).toBeCloseTo(base, 10)
  })
})
