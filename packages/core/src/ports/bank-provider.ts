import { Context, Data, Effect, Schema } from "effect"
import { CurrencyCode } from "../domain/money.ts"
import { IsoDate } from "../domain/time.ts"

export const BankAccountSnapshot = Schema.Struct({
  externalAccountId: Schema.String,
  name: Schema.optional(Schema.String),
  iban: Schema.optional(Schema.String),
  currency: Schema.optional(CurrencyCode),
  type: Schema.optional(Schema.String),
})

export type BankAccountSnapshot = Schema.Schema.Type<typeof BankAccountSnapshot>

export const BankTransactionSnapshot = Schema.Struct({
  externalTransactionId: Schema.optional(Schema.String),
  bookingDate: IsoDate,
  amountMinor: Schema.BigInt,
  currency: CurrencyCode,
  rawDescription: Schema.String,
  merchantName: Schema.optional(Schema.String),
  counterpartyName: Schema.optional(Schema.String),
})

export type BankTransactionSnapshot = Schema.Schema.Type<typeof BankTransactionSnapshot>

export const BankProviderConfig = Schema.Struct({
  baseUrl: Schema.String,
  clientId: Schema.String,
  // Plain string (not Redacted): the secret is config-injected by the host and must never be logged.
  clientSecret: Schema.String,
})

export type BankProviderConfig = Schema.Schema.Type<typeof BankProviderConfig>

export class ProviderUnavailable extends Data.TaggedError("ProviderUnavailable")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class BankProvider extends Context.Tag("BankProvider")<
  BankProvider,
  {
    listAccounts(): Effect.Effect<readonly BankAccountSnapshot[], ProviderUnavailable>
    listTransactions(
      accountExternalId: string,
      since?: Schema.Schema.Type<typeof IsoDate>,
    ): Effect.Effect<readonly BankTransactionSnapshot[], ProviderUnavailable>
    refreshAuthorization(): Effect.Effect<void, ProviderUnavailable>
  }
>() {}
