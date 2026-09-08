import { describe, expect, it } from "vitest"
import { toMinor } from "../../packages/core/src/domain/money.ts"
import {
  mapCashAccountType,
  signedAmount,
  sourceFingerprint,
} from "../../packages/enablebanking/src/map.ts"

describe("enablebanking map", () => {
  it("maps CACC to checking", () => {
    expect(mapCashAccountType("CACC")).toBe("checking")
  })

  it("signs DBIT amounts negative", () => {
    expect(signedAmount("1.23", "EUR", "DBIT")).toBe(-123n)
    expect(toMinor("1.23", "EUR")).toBe(123n)
  })

  it("builds a stable fingerprint that changes with amount", () => {
    const base = {
      accountExternalId: "acc-1",
      externalTransactionId: "tx-1",
      entryReference: "eref-1",
      bookingDate: "2026-09-01",
      amountMinor: 123n,
      currency: "EUR",
      creditDebitIndicator: "DBIT" as const,
    }
    const first = sourceFingerprint(base)
    const second = sourceFingerprint(base)
    expect(first).toBe(second)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(sourceFingerprint({ ...base, amountMinor: 124n })).not.toBe(first)
  })
})
