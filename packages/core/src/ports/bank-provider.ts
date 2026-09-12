import { Context, Data, Effect, Schema } from "effect"
import { AmountMinor, CurrencyCode } from "../domain/money.ts"
import { IsoDate } from "../domain/time.ts"
import type { TenantId } from "../domain/tenant.ts"

export const BankAspsp = Schema.Struct({
  name: Schema.String,
  country: Schema.String,
})

export type BankAspsp = Schema.Schema.Type<typeof BankAspsp>

export const BankAccountSnapshot = Schema.Struct({
  externalAccountId: Schema.String,
  name: Schema.optional(Schema.String),
  iban: Schema.optional(Schema.String),
  currency: Schema.optional(CurrencyCode),
  cashAccountType: Schema.optional(Schema.String),
})

export type BankAccountSnapshot = Schema.Schema.Type<typeof BankAccountSnapshot>

export const BankTransactionSnapshot = Schema.Struct({
  externalTransactionId: Schema.optional(Schema.String),
  entryReference: Schema.optional(Schema.String),
  bookingDate: IsoDate,
  valueDate: Schema.optional(IsoDate),
  amountMinor: AmountMinor,
  currency: CurrencyCode,
  creditDebitIndicator: Schema.Literal("CRDT", "DBIT"),
  rawDescription: Schema.String,
  merchantName: Schema.optional(Schema.String),
  counterpartyName: Schema.optional(Schema.String),
  status: Schema.Literal("booked", "pending"),
})

export type BankTransactionSnapshot = Schema.Schema.Type<typeof BankTransactionSnapshot>

export const BankAuthorization = Schema.Struct({
  url: Schema.String,
})

export type BankAuthorization = Schema.Schema.Type<typeof BankAuthorization>

export const BankSession = Schema.Struct({
  sessionId: Schema.String,
  accounts: Schema.Array(BankAccountSnapshot),
})

export type BankSession = Schema.Schema.Type<typeof BankSession>

export const BankPayment = Schema.Struct({
  paymentId: Schema.String,
  status: Schema.String,
  url: Schema.optional(Schema.String),
})

export type BankPayment = Schema.Schema.Type<typeof BankPayment>

export interface CreateBankPaymentInput {
  readonly aspsp: BankAspsp
  readonly redirectUrl: string
  readonly state: string
  readonly paymentType: string
  readonly creditorName: string
  readonly creditorIban: string
  readonly amountMinor: AmountMinor
  readonly currency: CurrencyCode
  readonly remittance?: string
}

export const BankProviderConfig = Schema.Struct({
  baseUrl: Schema.String,
  applicationId: Schema.String,
  // Plain string (not Redacted): host-injected, never logged.
  privateKeyPem: Schema.String,
  psuIp: Schema.String,
  psuUserAgent: Schema.String,
})

export type BankProviderConfig = Schema.Schema.Type<typeof BankProviderConfig>

export class ProviderUnavailable extends Data.TaggedError("ProviderUnavailable")<{
  readonly message: string
  readonly status?: number
  readonly cause?: unknown
}> {}

export class BankSessionMissing extends Data.TaggedError("BankSessionMissing")<{
  readonly tenantId: TenantId
}> {}

export class BankProvider extends Context.Tag("BankProvider")<
  BankProvider,
  {
    readonly listAspsps: () => Effect.Effect<readonly BankAspsp[], ProviderUnavailable>
    readonly startAuthorization: (input: {
      readonly aspsp: BankAspsp
      readonly redirectUrl: string
      readonly state: string
    }) => Effect.Effect<BankAuthorization, ProviderUnavailable>
    readonly createSession: (code: string) => Effect.Effect<BankSession, ProviderUnavailable>
    readonly listAccounts: (
      sessionId: string,
    ) => Effect.Effect<readonly BankAccountSnapshot[], ProviderUnavailable>
    readonly listTransactions: (
      sessionId: string,
      accountExternalId: string,
      since?: Schema.Schema.Type<typeof IsoDate>,
    ) => Effect.Effect<readonly BankTransactionSnapshot[], ProviderUnavailable>
    readonly deleteSession: (sessionId: string) => Effect.Effect<void, ProviderUnavailable>
    readonly createPayment: (
      input: CreateBankPaymentInput,
    ) => Effect.Effect<BankPayment, ProviderUnavailable>
    readonly getPayment: (paymentId: string) => Effect.Effect<BankPayment, ProviderUnavailable>
    readonly submitPayment: (paymentId: string) => Effect.Effect<BankPayment, ProviderUnavailable>
    readonly deletePayment: (paymentId: string) => Effect.Effect<void, ProviderUnavailable>
  }
>() {}
