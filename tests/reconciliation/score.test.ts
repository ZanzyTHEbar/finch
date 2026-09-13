import { describe, expect, it } from "vitest"
import {
  blendScore,
  scorePair,
  shouldPropose,
  shouldAutoMatch,
} from "../../packages/reconciliation/src/score.ts"

describe("blendScore", () => {
  it("adds the embedding similarity boost", () => {
    expect(blendScore(0.6, 0.5)).toBeCloseTo(0.675, 10)
  })

  it("returns 0 when base is 0", () => {
    expect(blendScore(0, 0.5)).toBe(0)
  })
})

describe("scorePair", () => {
  it("requires amount match", () => {
    const same = scorePair({
      receiptTotalMinor: 4280n,
      receiptCurrency: "EUR",
      receiptDate: null,
      receiptMerchant: null,
      transactionAmountMinor: -4280n,
      transactionCurrency: "EUR",
      transactionPostedDate: null,
      transactionDescription: null,
      transactionMerchantName: null,
      transactionCounterpartyName: null,
    })
    expect(same).toBeGreaterThanOrEqual(0.6)

    const diff = scorePair({
      receiptTotalMinor: 4280n,
      receiptCurrency: "EUR",
      receiptDate: null,
      receiptMerchant: null,
      transactionAmountMinor: -100n,
      transactionCurrency: "EUR",
      transactionPostedDate: null,
      transactionDescription: null,
      transactionMerchantName: null,
      transactionCounterpartyName: null,
    })
    expect(diff).toBe(0)
  })

  it("adds currency bonus", () => {
    const withCurrency = scorePair({
      receiptTotalMinor: 1000n,
      receiptCurrency: "EUR",
      receiptDate: null,
      receiptMerchant: null,
      transactionAmountMinor: 1000n,
      transactionCurrency: "EUR",
      transactionPostedDate: null,
      transactionDescription: null,
      transactionMerchantName: null,
      transactionCounterpartyName: null,
    })
    const withoutCurrency = scorePair({
      receiptTotalMinor: 1000n,
      receiptCurrency: null,
      receiptDate: null,
      receiptMerchant: null,
      transactionAmountMinor: 1000n,
      transactionCurrency: "EUR",
      transactionPostedDate: null,
      transactionDescription: null,
      transactionMerchantName: null,
      transactionCounterpartyName: null,
    })
    expect(withCurrency - withoutCurrency).toBeCloseTo(0.1, 10)
  })

  it("adds date bonus within 3 days", () => {
    const withDate = scorePair({
      receiptTotalMinor: 1000n,
      receiptCurrency: "EUR",
      receiptDate: "2026-09-01",
      receiptMerchant: null,
      transactionAmountMinor: 1000n,
      transactionCurrency: "EUR",
      transactionPostedDate: "2026-09-02",
      transactionDescription: null,
      transactionMerchantName: null,
      transactionCounterpartyName: null,
    })
    const withoutDate = scorePair({
      receiptTotalMinor: 1000n,
      receiptCurrency: "EUR",
      receiptDate: null,
      receiptMerchant: null,
      transactionAmountMinor: 1000n,
      transactionCurrency: "EUR",
      transactionPostedDate: "2026-09-02",
      transactionDescription: null,
      transactionMerchantName: null,
      transactionCounterpartyName: null,
    })
    expect(withDate - withoutDate).toBeCloseTo(0.2, 10)
  })

  it("adds merchant bonus", () => {
    const withMerchant = scorePair({
      receiptTotalMinor: 1000n,
      receiptCurrency: "EUR",
      receiptDate: null,
      receiptMerchant: "Continente",
      transactionAmountMinor: 1000n,
      transactionCurrency: "EUR",
      transactionPostedDate: null,
      transactionDescription: "Continente groceries",
      transactionMerchantName: null,
      transactionCounterpartyName: null,
    })
    const withoutMerchant = scorePair({
      receiptTotalMinor: 1000n,
      receiptCurrency: "EUR",
      receiptDate: null,
      receiptMerchant: null,
      transactionAmountMinor: 1000n,
      transactionCurrency: "EUR",
      transactionPostedDate: null,
      transactionDescription: "Continente groceries",
      transactionMerchantName: null,
      transactionCounterpartyName: null,
    })
    expect(withMerchant - withoutMerchant).toBeCloseTo(0.1, 10)
  })
})

describe("shouldPropose", () => {
  it("at 0.6", () => {
    expect(shouldPropose(0.6)).toBe(true)
    expect(shouldPropose(0.59)).toBe(false)
  })
})

describe("shouldAutoMatch", () => {
  it("at 0.8", () => {
    expect(shouldAutoMatch(0.8)).toBe(true)
    expect(shouldAutoMatch(0.79)).toBe(false)
  })
})
