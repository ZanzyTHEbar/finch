const PROPOSE_AT = 0.6
const AUTO_AT = 0.8
export const EMBEDDING_BOOST = 0.15

export const blendScore = (
  base: number,
  denseSimilarity: number,
): number =>
  base === 0 ? 0 : Math.min(1, base + EMBEDDING_BOOST * denseSimilarity)

const haystack = (...parts: Array<string | null | undefined>): string =>
  parts
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join(" ")
    .toLowerCase()

const dayDiff = (a: string, b: string): number | null => {
  const left = Date.parse(`${a}T00:00:00Z`)
  const right = Date.parse(`${b}T00:00:00Z`)
  if (Number.isNaN(left) || Number.isNaN(right)) {
    return null
  }
  return Math.abs(left - right) / 86_400_000
}

export interface ScoreInput {
  readonly receiptTotalMinor: bigint | null
  readonly receiptCurrency: string | null
  readonly receiptDate: string | null
  readonly receiptMerchant: string | null
  readonly transactionAmountMinor: bigint
  readonly transactionCurrency: string
  readonly transactionPostedDate: string | null
  readonly transactionDescription: string | null
  readonly transactionMerchantName: string | null
  readonly transactionCounterpartyName: string | null
}

export const scorePair = (input: ScoreInput): number => {
  if (input.receiptTotalMinor === null) {
    return 0
  }
  if (input.receiptTotalMinor !== (input.transactionAmountMinor < 0n ? -input.transactionAmountMinor : input.transactionAmountMinor)) {
    return 0
  }
  if (
    input.receiptCurrency !== null &&
    input.receiptCurrency !== input.transactionCurrency
  ) {
    return 0
  }
  let score = 0.6
  if (input.receiptCurrency !== null) {
    score += 0.1
  }
  if (input.receiptDate !== null && input.transactionPostedDate !== null) {
    const days = dayDiff(input.receiptDate, input.transactionPostedDate)
    if (days !== null && days <= 3) {
      score += 0.2
    }
  }
  const merchant = haystack(input.receiptMerchant)
  if (merchant !== "") {
    const text = haystack(
      input.transactionDescription,
      input.transactionMerchantName,
      input.transactionCounterpartyName,
    )
    if (text.includes(merchant)) {
      score += 0.1
    }
  }
  return score
}

export const shouldPropose = (score: number): boolean => score >= PROPOSE_AT
export const shouldAutoMatch = (score: number): boolean => score >= AUTO_AT
