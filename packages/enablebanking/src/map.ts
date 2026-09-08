import { createHash } from "node:crypto"
import { toMinor, type AmountMinor, type CurrencyCode, type IsoDate } from "@finch/core"

export type CashAccountType = "checking" | "savings" | "credit" | "investment" | "other"

export const mapCashAccountType = (raw: string | undefined): CashAccountType => {
  switch (raw) {
    case "CACC":
    case "TRAN":
    case "CASH":
      return "checking"
    case "SVGS":
      return "savings"
    case "CARD":
      return "credit"
    default:
      return "other"
  }
}

export const mapStatus = (raw: string | undefined): "booked" | "pending" | null => {
  if (raw === "BOOK") {
    return "booked"
  }
  if (raw === "PDNG") {
    return "pending"
  }
  return null
}

export const signedAmount = (
  amountDecimal: string,
  currency: CurrencyCode | string,
  creditDebitIndicator: "CRDT" | "DBIT",
): AmountMinor => {
  const minor = toMinor(amountDecimal, currency)
  return (creditDebitIndicator === "DBIT" ? -minor : minor) as AmountMinor
}

export interface SourceFingerprintInput {
  readonly accountExternalId: string
  readonly externalTransactionId?: string
  readonly entryReference?: string
  readonly bookingDate: IsoDate | string
  readonly amountMinor: AmountMinor | bigint
  readonly currency: CurrencyCode | string
  readonly creditDebitIndicator: "CRDT" | "DBIT"
}

export const sourceFingerprint = (input: SourceFingerprintInput): string =>
  createHash("sha256")
    .update(
      [
        input.accountExternalId,
        input.externalTransactionId ?? "",
        input.entryReference ?? "",
        input.bookingDate,
        String(input.amountMinor),
        input.currency,
        input.creditDebitIndicator,
      ].join("|"),
    )
    .digest("hex")
