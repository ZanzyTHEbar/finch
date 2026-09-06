import { Data } from "effect"

export class TenantMismatch extends Data.TaggedError("TenantMismatch")<Record<never, never>> {}

export class DuplicateEvent extends Data.TaggedError("DuplicateEvent")<Record<never, never>> {}

export class UnknownEventVersion extends Data.TaggedError("UnknownEventVersion")<{
  readonly eventType: string
  readonly eventVersion: number
}> {}

export class AccountNotFound extends Data.TaggedError("AccountNotFound")<{
  readonly accountId: string
}> {}

export class TransactionNotFound extends Data.TaggedError("TransactionNotFound")<{
  readonly transactionId: string
}> {}

export class ReceiptNotFound extends Data.TaggedError("ReceiptNotFound")<{
  readonly receiptId: string
}> {}

export class ReconciliationConflict extends Data.TaggedError("ReconciliationConflict")<{
  readonly reason: string
}> {}

export class StorageUnavailable extends Data.TaggedError("StorageUnavailable")<{
  readonly cause?: unknown
}> {}

export class ValidationFailed extends Data.TaggedError("ValidationFailed")<{
  readonly issues: readonly string[]
}> {}
