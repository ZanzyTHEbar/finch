import { Schema } from "effect"
import { AmountMinor, CurrencyCode } from "../money.ts"
import { IsoDate } from "../time.ts"

export const AccountDiscoveredV1 = Schema.Struct({
  externalRef: Schema.optional(Schema.String),
  name: Schema.String,
  type: Schema.Literal("checking", "savings", "credit", "investment", "other"),
  currency: CurrencyCode,
  status: Schema.Literal("active"),
})

export type AccountDiscoveredV1 = Schema.Schema.Type<typeof AccountDiscoveredV1>

export const AccountUpdatedV1 = Schema.Struct({
  name: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Literal("active", "revoked", "closed")),
})

export type AccountUpdatedV1 = Schema.Schema.Type<typeof AccountUpdatedV1>

export const AccountRevokedV1 = Schema.Struct({
  reason: Schema.optional(Schema.String),
})

export type AccountRevokedV1 = Schema.Schema.Type<typeof AccountRevokedV1>

export const TransactionObservedV1 = Schema.Struct({
  accountId: Schema.String,
  amountMinor: AmountMinor,
  currency: CurrencyCode,
  bookingDate: IsoDate,
  valueDate: Schema.optional(IsoDate),
  rawDescription: Schema.String,
  merchantName: Schema.optional(Schema.String),
  counterpartyName: Schema.optional(Schema.String),
  externalTransactionId: Schema.optional(Schema.String),
  sourceFingerprint: Schema.String,
  status: Schema.Literal("booked", "pending"),
})

export type TransactionObservedV1 = Schema.Schema.Type<typeof TransactionObservedV1>

export const TransactionReclassifiedV1 = Schema.Struct({
  category: Schema.String,
  previousCategory: Schema.optional(Schema.String),
})

export type TransactionReclassifiedV1 = Schema.Schema.Type<typeof TransactionReclassifiedV1>

export const TransactionCorrectedV1 = Schema.Struct({
  amountMinor: Schema.optional(AmountMinor),
  bookingDate: Schema.optional(IsoDate),
  merchantName: Schema.optional(Schema.String),
  reason: Schema.String,
})

export type TransactionCorrectedV1 = Schema.Schema.Type<typeof TransactionCorrectedV1>

export const TransactionReversedV1 = Schema.Struct({
  reversalOf: Schema.optional(Schema.String),
  reason: Schema.String,
})

export type TransactionReversedV1 = Schema.Schema.Type<typeof TransactionReversedV1>

export const TransactionDeletedBySourceV1 = Schema.Struct({
  reason: Schema.optional(Schema.String),
})

export type TransactionDeletedBySourceV1 = Schema.Schema.Type<typeof TransactionDeletedBySourceV1>

export const ReceiptCapturedV1 = Schema.Struct({
  merchant: Schema.optional(Schema.String),
  receiptDate: Schema.optional(IsoDate),
  currency: Schema.optional(CurrencyCode),
  subtotalMinor: Schema.optional(AmountMinor),
  taxMinor: Schema.optional(AmountMinor),
  totalMinor: AmountMinor,
  imageHash: Schema.String,
  sourceUri: Schema.String,
})

export type ReceiptCapturedV1 = Schema.Schema.Type<typeof ReceiptCapturedV1>

export const ReceiptMatchedV1 = Schema.Struct({
  transactionId: Schema.String,
  score: Schema.Number,
})

export type ReceiptMatchedV1 = Schema.Schema.Type<typeof ReceiptMatchedV1>

export const MatchProposedV1 = Schema.Struct({
  transactionId: Schema.String,
  receiptId: Schema.String,
  score: Schema.Number,
})

export type MatchProposedV1 = Schema.Schema.Type<typeof MatchProposedV1>

export const MatchConfirmedV1 = Schema.Struct({
  transactionId: Schema.String,
  receiptId: Schema.String,
  confirmedBy: Schema.String,
})

export type MatchConfirmedV1 = Schema.Schema.Type<typeof MatchConfirmedV1>

export const MatchRejectedV1 = Schema.Struct({
  transactionId: Schema.String,
  receiptId: Schema.String,
  reason: Schema.String,
})

export type MatchRejectedV1 = Schema.Schema.Type<typeof MatchRejectedV1>

export const SummaryGeneratedV1 = Schema.Struct({
  periodType: Schema.Literal("day", "week", "month"),
  period: Schema.String,
  contentHash: Schema.String,
})

export const BankConnectionCreatedV1 = Schema.Struct({
  aspspName: Schema.optional(Schema.String),
  aspspCountry: Schema.optional(Schema.String),
  sessionId: Schema.String,
})

export type BankConnectionCreatedV1 = Schema.Schema.Type<typeof BankConnectionCreatedV1>

export const BankConnectionRevokedV1 = Schema.Struct({
  sessionId: Schema.String,
  reason: Schema.optional(Schema.String),
})

export type BankConnectionRevokedV1 = Schema.Schema.Type<typeof BankConnectionRevokedV1>

export const BankSyncStartedV1 = Schema.Struct({
  jobId: Schema.String,
})

export type BankSyncStartedV1 = Schema.Schema.Type<typeof BankSyncStartedV1>

export const BankSyncCompletedV1 = Schema.Struct({
  jobId: Schema.String,
  transactionsObserved: Schema.Number,
})

export type BankSyncCompletedV1 = Schema.Schema.Type<typeof BankSyncCompletedV1>

export type SummaryGeneratedV1 = Schema.Schema.Type<typeof SummaryGeneratedV1>

// Event-type name (bare payload name, version carried separately in the
// envelope) -> v1 payload schema.
export const EventCatalogV1: Record<string, Schema.Schema.Any> = {
  AccountDiscovered: AccountDiscoveredV1,
  AccountUpdated: AccountUpdatedV1,
  AccountRevoked: AccountRevokedV1,
  TransactionObserved: TransactionObservedV1,
  TransactionReclassified: TransactionReclassifiedV1,
  TransactionCorrected: TransactionCorrectedV1,
  TransactionReversed: TransactionReversedV1,
  TransactionDeletedBySource: TransactionDeletedBySourceV1,
  ReceiptCaptured: ReceiptCapturedV1,
  ReceiptMatched: ReceiptMatchedV1,
  MatchProposed: MatchProposedV1,
  MatchConfirmed: MatchConfirmedV1,
  MatchRejected: MatchRejectedV1,
  SummaryGenerated: SummaryGeneratedV1,
  BankConnectionCreated: BankConnectionCreatedV1,
  BankConnectionRevoked: BankConnectionRevokedV1,
  BankSyncStarted: BankSyncStartedV1,
  BankSyncCompleted: BankSyncCompletedV1,
}

export type EventTypesV1 = keyof typeof EventCatalogV1
